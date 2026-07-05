import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  float,
  instanceIndex,
  mix,
  modelWorldMatrix,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

import { createVortexComputeRunner } from '../compute/runVortexCompute'
import { useHeightField } from '../gis/HeightFieldContext'
import { cpuHeightAt } from '../tsl/sampleHeightField'
import { valueFbm3 } from '../tsl/valueNoise'

/*
  竜巻レイヤー（plan.md D4）。

  構成:
  - 漏斗雲: LatheGeometry ベースのメッシュ。raymarch は使わず（CloudLayer と
    steps 予算を食い合わないため）、vertex でノイズ揺らぎ + スウェイ、
    fragment でスクロールノイズの opacity を与える
  - デブリ/塵: runVortexCompute の GPU パーティクル。windField の vortex 項
    （接線 + 吸引 + 上昇気流）で螺旋上昇する
  - 中心の移動: useFrame で緩いリサージュ軌道を描き、vortex.center uniform と
    漏斗メッシュの位置を同期して動かす（React 再レンダーなし）

  strength 0..1 が実質のマスター（接線速度・上昇気流・不透明度に連動）。
*/

// ============================================================
// 調整用パラメータ
// ============================================================

const FUNNEL = {
  radiusBottom: 0.1,    // 接地部の半径
  radiusTop: 1.7,       // 雲底部の半径
  profilePow: 1.7,      // 半径カーブ（大きいほど下すぼまり）
  segments: 40,         // 周方向分割
  rings: 28,            // 高さ方向分割
  color: '#6d6258',     // 根元の色（巻き上げた土）
  colorTop: '#9d938a',  // 上部の色（雲に馴染む）
  opacity: 0.62,        // strength=1 のときの最大不透明度
  wobbleAmp: 0.28,      // ノイズによる半径揺らぎ
  swayAmp: 0.35,        // 全体の蛇行振幅（上部ほど大きい）
}

const VORTEX_DEFAULTS = {
  radius: 0.55,         // 渦の特性半径（world units）
  tangential: 0.055,    // strength=1 の接線速度
  inflow: 0.018,        // 吸引
  updraft: 0.035,       // 上昇気流
}

const DEBRIS = {
  size: 0.014,
  color: '#a08663',
  opacity: 0.75,
}

const WANDER = {
  // 中心移動のリサージュ係数（<1 の非整数比で軌道が閉じない）
  freqX1: 0.11, freqX2: 0.043,
  freqZ1: 0.083, freqZ2: 0.057,
  rangeRatio: 0.4, // 移動範囲（地形ハーフサイズ比）
}

const DEFAULT_DELTA = 1 / 60

function TornadoLayer({
  position = [0, 0, 0],
  topY = 4.5, // 漏斗の上端（雲底、レイヤーローカル）
  strength = 1, // 0..1 マスター（uniform 駆動）
  particleCount = 8000,
}) {
  const renderer = useThree((state) => state.gl)
  const { heightInfo, gpu } = useHeightField()
  const heightSampler = gpu?.sampler ?? null
  const systemRef = useRef(null)
  const funnelRef = useRef(null)

  // vortex uniform 群（windField / デブリ / 漏斗で共有。生成一度きり）
  const vortex = useMemo(
    () => ({
      center: uniform(new THREE.Vector2(0, 0)),
      radius: uniform(VORTEX_DEFAULTS.radius),
      tangential: uniform(VORTEX_DEFAULTS.tangential),
      inflow: uniform(VORTEX_DEFAULTS.inflow),
      updraft: uniform(VORTEX_DEFAULTS.updraft),
    }),
    []
  )
  const funnelOpacity = useMemo(() => uniform(FUNNEL.opacity), [])

  // strength → uniform（再コンパイルなし）
  useEffect(() => {
    const s = Math.min(Math.max(strength, 0), 1)
    vortex.tangential.value = VORTEX_DEFAULTS.tangential * s
    vortex.inflow.value = VORTEX_DEFAULTS.inflow * s
    vortex.updraft.value = VORTEX_DEFAULTS.updraft * s
    funnelOpacity.value = FUNNEL.opacity * s
  }, [vortex, funnelOpacity, strength])

  const resources = useMemo(() => {
    // ======== デブリ compute + メッシュ ========
    const system = createVortexComputeRunner({
      particleCount,
      topY,
      vortex,
      heightSampler,
    })

    const debrisGeometry = new PlaneGeometry(1, 1)
    const debrisMaterial = new MeshBasicNodeMaterial({
      color: DEBRIS.color,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    const debrisMesh = new InstancedMesh(debrisGeometry, debrisMaterial, system.particleCount)
    const identity = new Matrix4()
    for (let i = 0; i < system.particleCount; i++) debrisMesh.setMatrixAt(i, identity)

    const posNode = system.positionNode.element(instanceIndex)
    const lifeNode = system.lifeNode.element(instanceIndex)

    debrisMaterial.vertexNode = Fn(() => {
      const worldPos = modelWorldMatrix.mul(vec4(posNode, 1))
      const viewPos = cameraViewMatrix.mul(worldPos)
      const idPhase = float(instanceIndex).mul(0.7639)
      const sizeHash = sin(idPhase.mul(12.9898)).mul(0.5).add(0.5)
      const size = float(DEBRIS.size).mul(sizeHash.mul(0.9).add(0.55))
      const finalViewPos = viewPos.add(vec4(
        positionLocal.x.mul(size),
        positionLocal.y.mul(size),
        0,
        0
      ))
      return cameraProjectionMatrix.mul(finalViewPos)
    })()

    // 寿命の出入りでフェードイン/アウト（t=1 スポーン直後 → 0 消滅。
    // 減少側 smoothstep は未定義なので oneMinus 形で書く）
    debrisMaterial.opacityNode = Fn(() => {
      const t = clamp(lifeNode.div(system.lifeMax), 0, 1)
      const fadeIn = smoothstep(0.75, 0.92, t).oneMinus()
      const fadeOut = smoothstep(0, 0.15, t)
      return float(DEBRIS.opacity).mul(fadeIn).mul(fadeOut)
    })()

    debrisMesh.frustumCulled = false

    // ======== 漏斗雲メッシュ ========
    // プロファイル: y 0..1、半径は下すぼまりのべき乗カーブ
    const profile = []
    for (let i = 0; i <= FUNNEL.rings; i++) {
      const t = i / FUNNEL.rings
      const r = FUNNEL.radiusBottom +
        (FUNNEL.radiusTop - FUNNEL.radiusBottom) * Math.pow(t, FUNNEL.profilePow)
      profile.push(new THREE.Vector2(r, t))
    }
    const funnelGeometry = new THREE.LatheGeometry(profile, FUNNEL.segments)
    const funnelMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })

    const h = positionGeometry.y // 0(接地)..1(雲底)

    // vertex: ノイズで半径を揺らし、全体を上部ほど大きく蛇行させる
    funnelMaterial.positionNode = Fn(() => {
      const wob = valueFbm3(
        vec3(
          positionGeometry.x.mul(1.4),
          h.mul(3).sub(time.mul(1.1)),
          positionGeometry.z.mul(1.4)
        ),
        3
      ).sub(0.5).mul(FUNNEL.wobbleAmp).mul(h.mul(0.7).add(0.3))
      const radialScale = wob.add(1)
      const sway = vec2(
        sin(time.mul(0.8).add(h.mul(2.6))),
        sin(time.mul(0.67).add(h.mul(3.1)).add(1.7))
      ).mul(FUNNEL.swayAmp).mul(h)
      return vec3(
        positionGeometry.x.mul(radialScale).add(sway.x),
        positionGeometry.y,
        positionGeometry.z.mul(radialScale).add(sway.y)
      )
    })()

    funnelMaterial.colorNode = mix(vec3(...new THREE.Color(FUNNEL.color).toArray()),
      vec3(...new THREE.Color(FUNNEL.colorTop).toArray()), h)

    // fragment: スクロールノイズで筋状のむら + 上端をわずかにフェード
    // （減少側 smoothstep は未定義なので oneMinus 形で書く）
    funnelMaterial.opacityNode = Fn(() => {
      const streak = valueFbm3(
        vec3(
          positionGeometry.x.mul(2.2).add(time.mul(0.5)),
          h.mul(4.5).sub(time.mul(2.4)),
          positionGeometry.z.mul(2.2)
        ),
        3
      )
      const topFade = smoothstep(0.85, 1.0, h).oneMinus()
      const bottomBoost = smoothstep(0.0, 0.35, h).oneMinus().mul(0.25).add(0.75)
      return funnelOpacity
        .mul(streak.mul(0.55).add(0.45))
        .mul(topFade)
        .mul(bottomBoost)
    })()

    return {
      system,
      debrisGeometry, debrisMaterial, debrisMesh,
      funnelGeometry, funnelMaterial,
    }
  }, [particleCount, topY, vortex, heightSampler, funnelOpacity])

  useEffect(() => {
    resources.system.init(renderer)
    systemRef.current = resources.system
    return () => {
      resources.system.destroy(renderer)
      resources.debrisGeometry.dispose()
      resources.debrisMaterial.dispose()
      resources.funnelGeometry.dispose()
      resources.funnelMaterial.dispose()
      systemRef.current = null
    }
  }, [renderer, resources])

  // 中心の移動（リサージュ）+ デブリ compute 更新
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime
    if (heightInfo) {
      const rangeX = (heightInfo.terrainWidth / 2) * WANDER.rangeRatio
      const rangeZ = (heightInfo.terrainDepth / 2) * WANDER.rangeRatio
      const cx = (Math.sin(t * WANDER.freqX1) * 0.7 + Math.sin(t * WANDER.freqX2 + 1.3) * 0.3) * rangeX
      const cz = (Math.sin(t * WANDER.freqZ1 + 0.9) * 0.7 + Math.sin(t * WANDER.freqZ2 + 2.1) * 0.3) * rangeZ
      vortex.center.value.set(cx, cz)
      if (funnelRef.current) {
        const groundY = cpuHeightAt(heightInfo, cx, cz)
        funnelRef.current.position.set(cx, groundY + 0.02, cz)
        funnelRef.current.scale.y = Math.max(topY - groundY, 0.5)
      }
    }
    if (systemRef.current) {
      systemRef.current.update(renderer, t, delta || DEFAULT_DELTA)
    }
  })

  return (
    <group position={position}>
      <primitive object={resources.debrisMesh} />
      <mesh
        ref={funnelRef}
        geometry={resources.funnelGeometry}
        material={resources.funnelMaterial}
        frustumCulled={false}
        renderOrder={9}
      />
    </group>
  )
}

export default TornadoLayer
