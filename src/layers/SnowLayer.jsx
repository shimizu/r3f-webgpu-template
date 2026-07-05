import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  float,
  instanceIndex,
  modelWorldMatrix,
  positionLocal,
  select,
  sin,
  time,
  vec4,
} from 'three/tsl'

import { createSnowComputeRunner } from '../compute/runSnowCompute'
import { useHeightField } from '../gis/HeightFieldContext'

/*
  降雪レイヤー（plan.md D2）。RainLayer をテンプレートにしたコピーベース派生。

  - フレークは view 空間 billboard の小さなクアッド。回転は compute を使わず
    vertex 内で time × 個体位相から計算する
  - 着地後は runSnowCompute の rest 値でフェードアウト（スプラッシュなし）
  - 地形への積雪表現はここでは扱わない。TerrainLayer の堆積（acc）を
    Scene 側の時定数追従で駆動する
*/

// ============================================================
// 調整用パラメータ
// ============================================================

const FLAKE_SIZE = 0.016            // フレークの基本サイズ
const FLAKE_SIZE_VARIATION = 0.6    // 個体サイズ差（0.7〜1.3 倍相当）
const FLAKE_OPACITY = 0.85          // 落下中の不透明度
const FLAKE_COLOR = '#ffffff'
const SPIN_SPEED = 2.2              // 回転速度（rad/s。個体位相でばらける）
const DEFAULT_DELTA = 1 / 60
const DEFAULT_WIND = [0.006, 0, 0.003]

function SnowLayer({
  position = [0, 0, 0],
  width = 15,
  depth = 13,
  topY = 8,
  particleCount = 12000,
  snowSpeed = 0.012,
  wind = DEFAULT_WIND,
  intensity = 1, // 雪量 0..1（uniform 駆動。粒数と風の強さが連動、再コンパイルなし）
}) {
  const renderer = useThree((state) => state.gl)
  const systemRef = useRef(null)
  const { gpu } = useHeightField()
  const heightSampler = gpu?.sampler ?? null

  // wind は成分値で依存させ、呼び出し側が inline 配列を渡しても再生成されないようにする
  const [windX, windY, windZ] = wind

  const resources = useMemo(() => {
    const system = createSnowComputeRunner({
      particleCount,
      areaWidth: width,
      areaDepth: depth,
      topY,
      snowSpeed,
      wind: [windX, windY, windZ],
      heightSampler,
    })

    const geometry = new PlaneGeometry(1, 1)
    const material = new MeshBasicNodeMaterial({
      color: FLAKE_COLOR,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })

    const mesh = new InstancedMesh(geometry, material, system.particleCount)
    const identityMatrix = new Matrix4()
    for (let i = 0; i < system.particleCount; i++) {
      mesh.setMatrixAt(i, identityMatrix)
    }

    const posNode = system.positionNode.element(instanceIndex)
    const restNode = system.restNode.element(instanceIndex)

    // billboard + 個体位相の 2D 回転 + 個体サイズ差
    material.vertexNode = Fn(() => {
      const worldPos = modelWorldMatrix.mul(vec4(posNode, 1.0))
      const viewPos = cameraViewMatrix.mul(worldPos)

      const idPhase = float(instanceIndex).mul(0.7639).toVar()
      const sizeHash = sin(idPhase.mul(12.9898)).mul(0.5).add(0.5)
      const size = float(FLAKE_SIZE)
        .mul(sizeHash.mul(FLAKE_SIZE_VARIATION).add(1 - FLAKE_SIZE_VARIATION / 2))
        .toVar()

      const angle = time.mul(SPIN_SPEED).add(idPhase.mul(7.3)).toVar()
      const ca = cos(angle)
      const sa = sin(angle)
      const rx = positionLocal.x.mul(ca).sub(positionLocal.y.mul(sa))
      const ry = positionLocal.x.mul(sa).add(positionLocal.y.mul(ca))

      const finalViewPos = viewPos.add(vec4(rx.mul(size), ry.mul(size), 0, 0))
      return cameraProjectionMatrix.mul(finalViewPos)
    })()

    // 落下中は一定、着地静止中（rest > 0）は rest の残量でフェードアウト
    material.opacityNode = Fn(() => {
      const fade = clamp(restNode.div(system.restMax), 0, 1)
      const resting = restNode.greaterThan(0.0)
      return float(FLAKE_OPACITY).mul(select(resting, fade, float(1)))
    })()

    mesh.frustumCulled = false

    return { geometry, material, mesh, system }
  }, [particleCount, width, depth, topY, snowSpeed, windX, windY, windZ, heightSampler])

  // 雪量は uniform 駆動（resources 再生成なし）
  useEffect(() => {
    resources.system.setIntensity(intensity)
  }, [resources, intensity])

  useEffect(() => {
    resources.system.init(renderer)
    systemRef.current = resources.system

    return () => {
      resources.system.destroy(renderer)
      resources.geometry.dispose()
      resources.material.dispose()
      systemRef.current = null
    }
  }, [renderer, resources])

  // delta は useFrame の第2引数を使う（RainLayer と同じ理由）
  useFrame((state, delta) => {
    if (!systemRef.current) return
    systemRef.current.update(
      renderer,
      state.clock.elapsedTime,
      delta || DEFAULT_DELTA
    )
  })

  return (
    <group position={position}>
      <primitive object={resources.mesh} />
    </group>
  )
}

export default SnowLayer
