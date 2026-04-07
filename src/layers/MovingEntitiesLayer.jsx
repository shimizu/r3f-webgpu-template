/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, Matrix4 } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { cos, float, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl'

import { useProjection } from '../gis/CoordinateContext'
import { createInterpolationPass } from '../compute/createInterpolationPass'
import {
  ENTITY_TYPE,
  OBSERVATION_OFFSET,
  OBSERVATION_STRIDE,
} from '../compute/observationLayout'
import { createMockObservationBuffer } from '../data/mockObservations'

// 定数定義: エンティティのサイズやアニメーション周期
const ENTITY_SIZE = 0.017
const LOOP_DURATION = 6
const ENTITY_COLORS = { aircraft: '#ffd166', default: '#66d9ff' }
const ENTITY_MATERIAL = { color: '#ffffff' }

/**
 * 観測データ（バッファ）からエンティティのタイプに応じた色を取得します。
 */
function getEntityColor(rawObservationBuffer, index) {
  const type = rawObservationBuffer[index * OBSERVATION_STRIDE + OBSERVATION_OFFSET.type]

  return type === ENTITY_TYPE.aircraft
    ? new Color(ENTITY_COLORS.aircraft)
    : new Color(ENTITY_COLORS.default)
}

/**
 * 大量の移動体を GPU で補間・投影して描画するレイヤー。
 * 
 * 仕組み:
 * 1. 観測データ（前回位置、現在位置、時刻）を GPU バッファ（StorageBuffer）に転送。
 * 2. Compute Shader (TSL) が現在の再生時刻に基づき、2点間を線形補間。
 * 3. 補間された地理座標（lon/lat）をそのまま GPU 上でワールド座標へ投影。
 * 4. InstancedMesh を使用し、頂点シェーダー内で各インスタンスの位置を更新して描画。
 */
function MovingEntitiesLayer({ entityCount }) {
  const { view } = useProjection()
  const renderer = useThree((state) => state.gl)
  const systemRef = useRef(null)
  
  // モックデータの生成
  const dataset = useMemo(() => createMockObservationBuffer(entityCount), [entityCount])

  // GPU リソースとマテリアルの初期化
  const { resourceError, resources } = useMemo(() => {
    try {
      // 補間・投影を行う Compute Pass の作成
      const system = createInterpolationPass(dataset.rawObservationBuffer, {
        ...view,
        loopDuration: LOOP_DURATION,
      })

      // 個々のエンティティの形状（三角形）
      const s = ENTITY_SIZE
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute([
        0, s, 0,               // 先端
        -s * 0.5, -s * 0.5, 0, // 左後方
        s * 0.5, -s * 0.5, 0,  // 右後方
      ], 3))

      const material = new MeshBasicNodeMaterial({
        color: ENTITY_MATERIAL.color,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      })

      // インスタンス描画用のメッシュ
      const mesh = new InstancedMesh(geometry, material, system.entityCount)
      const identityMatrix = new Matrix4()

      // 各インスタンスの初期色を設定
      for (let index = 0; index < system.entityCount; index += 1) {
        mesh.setMatrixAt(index, identityMatrix)
        mesh.setColorAt(index, getEntityColor(dataset.rawObservationBuffer, index))
      }

      // --- TSL による頂点制御 ---
      // Compute Shader で計算された位置と進行方向を取得
      const rawPos = system.positionNode.element(instanceIndex)
      const heading = system.headingNode.element(instanceIndex)
      const cosH = cos(heading)
      const sinH = sin(heading)

      // 頂点シェーダー内で、各インスタンスを進行方向（heading）へ回転させ、投影位置（rawPos）へ配置
      const lx = positionLocal.x
      const ly = positionLocal.y
      const rotatedX = lx.mul(cosH).sub(ly.mul(sinH))
      const rotatedY = lx.mul(sinH).add(ly.mul(cosH))

      material.positionNode = vec3(
        rotatedX.add(rawPos.x),
        rotatedY.add(rawPos.y),
        float(0)
      )
      mesh.frustumCulled = false // 常に描画

      return {
        resourceError: null,
        resources: { geometry, material, mesh, system },
      }
    } catch (projectionError) {
      return {
        resourceError:
          projectionError instanceof Error
            ? projectionError.message
            : 'projection pass の初期化に失敗しました',
        resources: null,
      }
    }
  }, [dataset, view])

  // レンダラーへの Compute Pass 登録とクリーンアップ
  useEffect(() => {
    if (!resources) return undefined

    try {
      resources.system.init(renderer)
      systemRef.current = resources.system
    } catch (projectionError) {
      console.error(
        projectionError instanceof Error
          ? projectionError.message
          : 'projection pass の実行に失敗しました'
      )
    }

    return () => {
      resources.geometry.dispose()
      resources.material.dispose()
      resources.system.destroy()
      systemRef.current = null
    }
  }, [renderer, resources])

  // 毎フレームの更新処理
  useFrame((state) => {
    const system = systemRef.current
    if (!system) return

    // ループ再生時刻の計算
    const playbackTime = state.clock.elapsedTime % LOOP_DURATION
    
    // GPU 側で補間と投影を再計算
    system.update(renderer, playbackTime, {
      ...view,
      loopDuration: LOOP_DURATION,
    })
  })

  if (resourceError) {
    console.error(resourceError)
    return null
  }

  return <primitive object={resources.mesh} />
}

export default MovingEntitiesLayer
