/*
  炎 / 火の粉パーティクルの GPU コンピュートシステム（plan.md D5-5b）。

  runRainCompute をテンプレートにしたコピーベース派生。
  burnField（解析近似の延焼マスク）と同じ ignition / radius / band uniform を
  受け取り、燃焼前線リング上の地表からスポーン → 浮力 + FBM 風で上昇 →
  短寿命でフェード消滅 → 前線へリスポーンする。

  パラメータ差で 2 役をこなす:
  - 炎（flame）: 浮力弱・寿命短・風の影響小（前線に張り付いて燃える）
  - 火の粉（ember）: 浮力強・寿命長・風の影響大（舞い上がって流される）
*/
import {
  Fn,
  cos,
  float,
  instanceIndex,
  select,
  sin,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'

import { createParticleBuffers } from './particleBuffers'
import { createWindField } from '../tsl/windField'

// ============================================================

const WORKGROUP_SIZE = 64
const DEFAULT_DELTA = 1 / 60
const GROUND_EPS = 0.015
const DAMPING = 0.96 // 速度減衰（毎フレーム）

// FBM 乱流（火の粉の揺らぎ。strength は呼び出し側倍率で調整）
const WIND_FIELD = {
  turbulenceScale: 0.9,
  turbulenceStrength: 0.01,
  timeScale: 0.9,
  yDamping: 0.5,
  gustFrequency: 0.6,
  gustStrength: 0.006,
  gustSpatialScale: { x: 0.1, z: 0.12 },
}

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function createEmberComputeRunner({
  particleCount,
  // burnField と共有する前線パラメータ（uniform ノード）
  fire, // { ignition(vec2), radius(float), band(float) }
  buoyancy = 0.012, // 上向き加速（速度単位/秒）
  windScale = 1, // FBM 乱流の倍率（炎 0.4 / 火の粉 1.5 など）
  riseMax = 1.2, // スポーン地点からの最大上昇量（超えたらリスポーン）
  lifeMin = 0.6,
  lifeMax = 1.4,
  heightSampler = null,
}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const hasHeightMap = !!heightSampler

  // 初期状態: 全て寿命切れ（最初の update で前線へスポーンする）
  const initialLife = new Float32Array(particleCount)
  const initialPositions = new Float32Array(particleCount * 3)
  for (let i = 0; i < particleCount; i++) {
    initialPositions[i * 3 + 1] = -1000 // 画面外から開始
    initialLife[i] = -hash01(i * 1.91 + 0.7) * lifeMax // 位相をずらして順次出現
  }

  const buffers = createParticleBuffers(particleCount, {
    pos: { itemSize: 3, data: initialPositions },
    vel: 3,
    life: { itemSize: 1, data: initialLife },
    spawnY: 1, // スポーン時の地表高さ（上昇量の判定基準）
  })

  const positionNode = buffers.nodes.pos
  const velocityNode = buffers.nodes.vel
  const lifeNode = buffers.nodes.life
  const spawnYNode = buffers.nodes.spawnY

  const timeNode = uniform(0)
  const deltaNode = uniform(DEFAULT_DELTA)

  const { windAt } = createWindField({
    turbScale: WIND_FIELD.turbulenceScale,
    turbStrength: WIND_FIELD.turbulenceStrength * windScale,
    gustFrequency: WIND_FIELD.gustFrequency,
    gustStrength: WIND_FIELD.gustStrength * windScale,
    timeScale: WIND_FIELD.timeScale,
    yDamping: WIND_FIELD.yDamping,
    gustSpatialScale: WIND_FIELD.gustSpatialScale,
  })

  const emberComputeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)
    const life = lifeNode.element(instanceIndex)
    const spawnY = spawnYNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

    // --- 上昇 + 揺らぎ ---
    const windForce = windAt(currentPos, timeNode).mul(frameScale)
    const nextVel = currentVel.mul(DAMPING)
      .add(windForce)
      .toVar()
    nextVel.y.addAssign(float(buoyancy).mul(deltaNode))

    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()
    const nextLife = life.sub(deltaNode).toVar()

    // --- リスポーン判定 ---
    const tooHigh = nextPos.y.sub(spawnY).greaterThan(riseMax)
    const needsRespawn = nextLife.lessThanEqual(0).or(tooHigh)

    // --- 燃焼前線リング上の地表へスポーン ---
    const seed = timeNode.mul(0.53).add(idPhase.mul(17.9)).toVar()
    const angle = seed.mul(6.2832).add(idPhase.mul(2.3))
    // 半径は前線 ± band（前線帯の内側寄り）
    const radial = fire.radius.add(
      sin(seed.mul(9.1)).mul(fire.band)
    ).max(0.02)
    const spawnX = fire.ignition.x.add(cos(angle).mul(radial)).toVar()
    const spawnZ = fire.ignition.y.add(sin(angle).mul(radial)).toVar()
    let spawnGroundY
    if (hasHeightMap) {
      spawnGroundY = heightSampler.heightAt(vec2(spawnX, spawnZ)).toVar()
    } else {
      spawnGroundY = float(0).toVar()
    }
    const newSpawnY = spawnGroundY.add(GROUND_EPS)
    const spawnVel = vec3(
      sin(seed.mul(13.7)).mul(0.002),
      float(0.002),
      cos(seed.mul(15.3)).mul(0.002)
    )
    const respawnLife = float(lifeMin).add(
      sin(seed.mul(11.3)).mul(0.5).add(0.5).mul(lifeMax - lifeMin)
    )

    pos.assign(vec3(
      select(needsRespawn, spawnX, nextPos.x),
      select(needsRespawn, newSpawnY, nextPos.y),
      select(needsRespawn, spawnZ, nextPos.z)
    ))
    vel.assign(vec3(
      select(needsRespawn, spawnVel.x, nextVel.x),
      select(needsRespawn, spawnVel.y, nextVel.y),
      select(needsRespawn, spawnVel.z, nextVel.z)
    ))
    life.assign(select(needsRespawn, respawnLife, nextLife))
    spawnY.assign(select(needsRespawn, newSpawnY, spawnY))
  })().compute(particleCount, [WORKGROUP_SIZE])

  return {
    particleCount,
    positionNode,
    lifeNode,
    lifeMax,

    init(renderer) {
      renderer.compute(emberComputeNode)
    },

    update(renderer, time, delta) {
      timeNode.value = time
      deltaNode.value = delta || DEFAULT_DELTA
      renderer.compute(emberComputeNode)
    },

    destroy(renderer) {
      emberComputeNode.dispose()
      buffers.dispose(renderer)
    },
  }
}
