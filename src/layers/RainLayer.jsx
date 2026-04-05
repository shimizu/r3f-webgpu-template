/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { AdditiveBlending, DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
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

// --- 雨ストリーク描画 ---
const STREAK_LENGTH = 0.35          // 速度方向の引き伸ばし量
const STREAK_WIDTH = 0.003          // 雨粒の横幅
const STREAK_MIN_LENGTH = 0.02      // 最小ストリーク長
const STREAK_MAX_LENGTH = 0.5       // 最大ストリーク長

// --- 雨の透明度 ---
const OPACITY_BASE = 0.35           // 基本不透明度
const OPACITY_SPEED_BOOST = 0.25    // 速度による追加分
const OPACITY_SPEED_REF = 0.1       // boost が最大になる速度

// --- スプラッシュ描画 ---
const SPLASH_SIZE = 0.01            // スプラッシュ粒子の基本サイズ
const SPLASH_OPACITY = 0.4          // スプラッシュの不透明度
const SPLASH_COLOR = '#ccddff'      // スプラッシュの色

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

    // ======== 雨メッシュ ========
    const rainGeometry = new PlaneGeometry(1, 1)
    const rainMaterial = new MeshBasicNodeMaterial({
      color: '#aaccff',
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })

    const rainMesh = new InstancedMesh(rainGeometry, rainMaterial, system.particleCount)
    const identityMatrix = new Matrix4()
    for (let i = 0; i < system.particleCount; i++) {
      rainMesh.setMatrixAt(i, identityMatrix)
    }

    // 速度方向ストリーク vertex shader
    const posNode = system.positionNode.element(instanceIndex)
    const velNode = system.velocityNode.element(instanceIndex)

    rainMaterial.vertexNode = Fn(() => {
      const worldPos = modelWorldMatrix.mul(vec4(posNode, 1.0))
      const viewPos = cameraViewMatrix.mul(worldPos)

      const velWorld = vec4(velNode, 0.0)
      const velView = cameraViewMatrix.mul(velWorld)

      const speed = length(velView.xyz).toVar()
      const velDir = normalize(velView.xyz.add(0.0001)).toVar()

      const streakLen = speed.mul(STREAK_LENGTH)
        .max(float(STREAK_MIN_LENGTH))
        .min(float(STREAK_MAX_LENGTH))
        .toVar()

      const localY = positionLocal.y
      const localX = positionLocal.x

      const right = normalize(velDir.cross(vec4(0, 0, 1, 0).xyz)).toVar()

      const offset = velDir.mul(localY).mul(streakLen)
        .add(right.mul(localX).mul(STREAK_WIDTH))

      const finalViewPos = viewPos.add(vec4(offset, 0.0))
      return cameraProjectionMatrix.mul(finalViewPos)
    })()

    rainMaterial.opacityNode = Fn(() => {
      const velForOpacity = system.velocityNode.element(instanceIndex)
      const speed = length(velForOpacity)
      const speedFactor = smoothstep(float(0), float(OPACITY_SPEED_REF), speed)
      return float(OPACITY_BASE).add(speedFactor.mul(OPACITY_SPEED_BOOST))
    })()

    rainMesh.frustumCulled = false

    // ======== スプラッシュメッシュ ========
    const splashGeometry = new PlaneGeometry(1, 1)
    const splashMaterial = new MeshBasicNodeMaterial({
      color: SPLASH_COLOR,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })

    const splashMesh = new InstancedMesh(splashGeometry, splashMaterial, system.particleCount)
    for (let i = 0; i < system.particleCount; i++) {
      splashMesh.setMatrixAt(i, identityMatrix)
    }

    // スプラッシュ vertex shader: billboarding + 寿命ベースのサイズ変化
    const splashPosNode = system.splashPosNode.element(instanceIndex)
    const splashLifeNode = system.splashLifeNode.element(instanceIndex)

    splashMaterial.vertexNode = Fn(() => {
      const worldPos = modelWorldMatrix.mul(vec4(splashPosNode, 1.0))
      const viewPos = cameraViewMatrix.mul(worldPos)

      // 寿命に応じたサイズ: 発生直後に膨らみ、消える前に縮む
      const life = splashLifeNode.toVar()
      const normalizedLife = life.div(0.4).toVar() // 0〜1 (maxLife=0.4)
      // 急速に膨らんでゆっくり縮む: sin カーブ
      const sizeCurve = normalizedLife.mul(3.14159).sin().toVar()
      const size = float(SPLASH_SIZE).mul(sizeCurve).toVar()

      // ビュー空間 billboarding
      const localX = positionLocal.x
      const localY = positionLocal.y

      const offsetX = localX.mul(size)
      const offsetY = localY.mul(size)

      const finalViewPos = viewPos.add(vec4(offsetX, offsetY, 0, 0))
      return cameraProjectionMatrix.mul(finalViewPos)
    })()

    // スプラッシュ opacity: 寿命に応じてフェードアウト
    splashMaterial.opacityNode = Fn(() => {
      const life = system.splashLifeNode.element(instanceIndex)
      const normalizedLife = life.div(0.4)
      // 後半で急速にフェードアウト
      return normalizedLife.mul(float(SPLASH_OPACITY))
    })()

    splashMesh.frustumCulled = false

    return {
      rainGeometry, rainMaterial, rainMesh,
      splashGeometry, splashMaterial, splashMesh,
      system,
    }
  }, [particleCount, width, depth, topY, rainSpeed, wind, heightInfo])

  useEffect(() => {
    resources.system.init(renderer)
    systemRef.current = resources.system

    return () => {
      resources.system.destroy()
      resources.rainGeometry.dispose()
      resources.rainMaterial.dispose()
      resources.splashGeometry.dispose()
      resources.splashMaterial.dispose()
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

  return (
    <group position={position}>
      <primitive object={resources.rainMesh} />
      <primitive object={resources.splashMesh} />
    </group>
  )
}

export default RainLayer
