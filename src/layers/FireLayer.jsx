import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { AdditiveBlending, DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  color,
  float,
  instanceIndex,
  mix,
  modelWorldMatrix,
  positionLocal,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'

import { createEmberComputeRunner } from '../compute/runEmberCompute'
import { useHeightField } from '../gis/HeightFieldContext'
import { valueFbm3 } from '../tsl/valueNoise'

/*
  炎 + 火の粉レイヤー（plan.md D5-5b）。

  burnField（TerrainLayer の延焼マスク）と同じ ignition / radius を受け取り、
  燃焼前線リングに沿って:
  - 炎: 大きめの billboard。fBM で形状を浸食した加算グラデーション。
    浮力弱・寿命短で前線に張り付いて燃える
  - 火の粉: 小さな加算粒。浮力強・風の影響大で舞い上がる
  を runEmberCompute のパラメータ差（2 インスタンス）で描く。

  ignition / radius は uniform 駆動（Scene の延焼スライダーと同期。
  再コンパイルなし）。
*/

// ============================================================
// 調整用パラメータ
// ============================================================

const FLAME = {
  count: 2500,
  size: 0.09,
  buoyancy: 0.006,
  windScale: 0.35,
  riseMax: 0.35,
  lifeMin: 0.5,
  lifeMax: 1.1,
  colorCore: '#ffe9b0',
  colorEdge: '#ff5a1f',
  opacity: 0.85,
}

const EMBER = {
  count: 4500,
  size: 0.011,
  buoyancy: 0.02,
  windScale: 1.6,
  riseMax: 1.6,
  lifeMin: 1.2,
  lifeMax: 2.8,
  colorHot: '#ffd9a0',
  colorCool: '#ff4400',
  opacity: 0.9,
}

const DEFAULT_DELTA = 1 / 60

// 前線リングの billboard パーティクル一式（炎 / 火の粉で共用）
function buildParticleSet(config, fire, heightSampler, kind) {
  const system = createEmberComputeRunner({
    particleCount: config.count,
    fire,
    buoyancy: config.buoyancy,
    windScale: config.windScale,
    riseMax: config.riseMax,
    lifeMin: config.lifeMin,
    lifeMax: config.lifeMax,
    heightSampler,
  })

  const geometry = new PlaneGeometry(1, 1)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    fog: false,
  })

  const mesh = new InstancedMesh(geometry, material, system.particleCount)
  const identity = new Matrix4()
  for (let i = 0; i < system.particleCount; i++) mesh.setMatrixAt(i, identity)
  mesh.frustumCulled = false

  const posNode = system.positionNode.element(instanceIndex)
  const lifeNode = system.lifeNode.element(instanceIndex)
  const lifeT = clamp(lifeNode.div(system.lifeMax), 0, 1) // 1=生まれたて → 0=消滅

  material.vertexNode = Fn(() => {
    const worldPos = modelWorldMatrix.mul(vec4(posNode, 1))
    const viewPos = cameraViewMatrix.mul(worldPos)
    const idPhase = float(instanceIndex).mul(0.7639)
    const sizeHash = sin(idPhase.mul(12.9898)).mul(0.5).add(0.5)
    // 発生直後に膨らみ、消える前に縮む
    const lifeCurve = sin(lifeT.oneMinus().mul(Math.PI)).mul(0.7).add(0.3)
    const size = float(config.size)
      .mul(sizeHash.mul(0.8).add(0.6))
      .mul(lifeCurve)
    const stretchY = kind === 'flame' ? 1.7 : 1.0 // 炎は縦長
    const finalViewPos = viewPos.add(vec4(
      positionLocal.x.mul(size),
      positionLocal.y.mul(size).mul(stretchY),
      0,
      0
    ))
    return cameraProjectionMatrix.mul(finalViewPos)
  })()

  if (kind === 'flame') {
    // 炎: 中心コア → 縁のグラデーション + fBM で形を浸食
    const centered = uv().sub(0.5).mul(2)
    const radial = centered.length()
    const erode = valueFbm3(
      vec3(
        uv().mul(3.5).add(float(instanceIndex).mul(0.61)),
        time.mul(2.2)
      ),
      2
    )
    const shape = smoothstep(0.25, 1.0, radial.add(erode.mul(0.55))).oneMinus()
    const core = smoothstep(0.0, 0.7, radial).oneMinus()
    material.colorNode = mix(color(config.colorEdge), color(config.colorCore), core)
    material.opacityNode = shape.mul(lifeT.mul(0.6).add(0.4)).mul(config.opacity)
  } else {
    // 火の粉: 熱い → 冷える色遷移 + 寿命フェード
    material.colorNode = mix(color(config.colorCool), color(config.colorHot), lifeT)
    const centered = uv().sub(0.5).mul(2)
    const dot = smoothstep(0.2, 1.0, centered.length()).oneMinus()
    material.opacityNode = dot.mul(lifeT).mul(config.opacity)
  }

  return { system, geometry, material, mesh }
}

function FireLayer({
  position = [0, 0, 0],
  ignition = null, // 発火点 [x, z]（TerrainLayer の burnField と同じ値を渡す）
  radius = 0, // 延焼半径（uniform 駆動）
  band = 0.35, // 前線帯の幅
}) {
  const renderer = useThree((state) => state.gl)
  const { gpu } = useHeightField()
  const heightSampler = gpu?.sampler ?? null
  const systemsRef = useRef(null)

  // burnField と同じ前線 uniform（生成一度きり、値は .value 更新）
  const fire = useMemo(
    () => ({
      ignition: uniform(new THREE.Vector2(0, 0)),
      radius: uniform(0),
      band: uniform(0.35),
    }),
    []
  )

  useEffect(() => {
    fire.radius.value = radius
    fire.band.value = band
    if (ignition) fire.ignition.value.set(ignition[0], ignition[1])
  }, [fire, radius, band, ignition])

  const resources = useMemo(() => {
    const flame = buildParticleSet(FLAME, fire, heightSampler, 'flame')
    const ember = buildParticleSet(EMBER, fire, heightSampler, 'ember')
    return { flame, ember }
  }, [fire, heightSampler])

  useEffect(() => {
    resources.flame.system.init(renderer)
    resources.ember.system.init(renderer)
    systemsRef.current = resources
    return () => {
      for (const set of [resources.flame, resources.ember]) {
        set.system.destroy(renderer)
        set.geometry.dispose()
        set.material.dispose()
      }
      systemsRef.current = null
    }
  }, [renderer, resources])

  useFrame((state, delta) => {
    if (!systemsRef.current) return
    const t = state.clock.elapsedTime
    const dt = delta || DEFAULT_DELTA
    systemsRef.current.flame.system.update(renderer, t, dt)
    systemsRef.current.ember.system.update(renderer, t, dt)
  })

  return (
    <group position={position}>
      <primitive object={resources.flame.mesh} />
      <primitive object={resources.ember.mesh} />
    </group>
  )
}

export default FireLayer
