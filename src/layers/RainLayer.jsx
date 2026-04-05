/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  instanceIndex,
  length,
  modelWorldMatrix,
  normalize,
  positionLocal,
  smoothstep,
  vec4,
} from 'three/tsl'

import { createRainComputeRunner } from '../compute/runRainCompute'

// ============================================================
// 調整用パラメータ
// ============================================================

// ストリーク描画
const STREAK_LENGTH = 0.35          // 速度方向の引き伸ばし量
const STREAK_WIDTH = 0.003          // 雨粒の横幅
const STREAK_MIN_LENGTH = 0.02      // 最小ストリーク長（速度ゼロでも見える）
const STREAK_MAX_LENGTH = 0.5       // 最大ストリーク長

// 透明度
const OPACITY_BASE = 0.35           // 基本不透明度
const OPACITY_SPEED_BOOST = 0.25    // 速度による不透明度の追加分
const OPACITY_SPEED_REF = 0.1       // この速度で opacity_boost が最大になる

function RainLayer({
  position = [0, 0, 0],
  width = 15,
  depth = 13,
  topY = 8,
  particleCount = 30000,
  rainSpeed = 0.08,
  wind = [0.01, 0, 0.005],
  heightInfo = null,
}) {
  const renderer = useThree((state) => state.gl)
  const systemRef = useRef(null)

  const resources = useMemo(() => {
    const system = createRainComputeRunner({
      particleCount,
      areaWidth: width,
      areaDepth: depth,
      topY,
      rainSpeed,
      wind,
      heightData: heightInfo?.heights ?? null,
      heightCols: heightInfo?.cols ?? 0,
      heightRows: heightInfo?.rows ?? 0,
      terrainWidth: heightInfo?.terrainWidth ?? 0,
      terrainDepth: heightInfo?.terrainDepth ?? 0,
    })

    // 単位平面: Y 方向 [-0.5, 0.5] を速度方向に引き伸ばし、
    //          X 方向 [-0.5, 0.5] を横幅として使う
    const geometry = new PlaneGeometry(1, 1)
    const material = new MeshBasicNodeMaterial({
      color: '#aaccff',
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })

    const mesh = new InstancedMesh(geometry, material, system.particleCount)
    const identityMatrix = new Matrix4()
    for (let i = 0; i < system.particleCount; i++) {
      mesh.setMatrixAt(i, identityMatrix)
    }

    // --- 速度方向ストリーク vertex shader ---
    // 各パーティクルの velocity を取得し、
    // ビュー空間で速度方向にクアッドを引き伸ばす。
    // これにより速い雨は長い線に、遅い雨は短い点になる。
    const posNode = system.positionNode.element(instanceIndex)
    const velNode = system.velocityNode.element(instanceIndex)

    material.vertexNode = Fn(() => {
      // パーティクルのワールド位置
      const worldPos = modelWorldMatrix.mul(vec4(posNode, 1.0))

      // ビュー空間に変換
      const viewPos = cameraViewMatrix.mul(worldPos)

      // 速度をビュー空間に変換（方向のみ、平行移動なし）
      const velWorld = vec4(velNode, 0.0)
      const velView = cameraViewMatrix.mul(velWorld)

      // 速度の大きさ
      const speed = length(velView.xyz).toVar()

      // 速度方向を正規化（ゼロ除算防止）
      const velDir = normalize(velView.xyz.add(0.0001)).toVar()

      // ストリーク長: 速度に比例、min/max でクランプ
      const streakLen = speed.mul(STREAK_LENGTH)
        .max(float(STREAK_MIN_LENGTH))
        .min(float(STREAK_MAX_LENGTH))
        .toVar()

      // クアッドのローカル座標: Y が速度方向、X が横方向
      const localY = positionLocal.y  // -0.5 〜 0.5
      const localX = positionLocal.x  // -0.5 〜 0.5

      // 速度方向に垂直なビュー空間ベクトル（Z 軸との外積で横方向を得る）
      const sideDir = normalize(velDir.cross(velView.xyz.normalize().add(0.001).cross(velDir).add(
        // フォールバック: 速度がカメラ方向と平行な場合
        normalize(velDir.cross(velDir.add(0.1)))
      ).normalize())).toVar()

      // もっとシンプルに: ビュー空間の Z 軸（カメラ前方）と速度方向の外積
      const right = normalize(velDir.cross(vec4(0, 0, 1, 0).xyz)).toVar()

      // 頂点をオフセット: 速度方向にストレッチ + 横幅
      const offset = velDir.mul(localY).mul(streakLen)
        .add(right.mul(localX).mul(STREAK_WIDTH))

      const finalViewPos = viewPos.add(vec4(offset, 0.0))

      return cameraProjectionMatrix.mul(finalViewPos)
    })()

    // --- 速度ベースの透明度 ---
    // 速い雨粒ほど明るく見える
    material.opacityNode = Fn(() => {
      const velForOpacity = system.velocityNode.element(instanceIndex)
      const speed = length(velForOpacity)
      const speedFactor = smoothstep(float(0), float(OPACITY_SPEED_REF), speed)
      return float(OPACITY_BASE).add(speedFactor.mul(OPACITY_SPEED_BOOST))
    })()

    mesh.frustumCulled = false

    return { geometry, material, mesh, system }
  }, [particleCount, width, depth, topY, rainSpeed, wind, heightInfo])

  useEffect(() => {
    resources.system.init(renderer)
    systemRef.current = resources.system

    return () => {
      resources.system.destroy()
      resources.geometry.dispose()
      resources.material.dispose()
      systemRef.current = null
    }
  }, [renderer, resources])

  useFrame((state) => {
    if (!systemRef.current) return
    systemRef.current.update(
      renderer,
      state.clock.elapsedTime,
      state.clock.getDelta() || 1 / 60
    )
  })

  return <primitive object={resources.mesh} position={position} />
}

export default RainLayer
