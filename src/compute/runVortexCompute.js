/*
  竜巻デブリ/塵パーティクルの GPU コンピュートシステム（plan.md D4）。

  runRainCompute をテンプレートにしたコピーベース派生。
  - 風場は windField の vortex 項（接線 + 吸引 + 上昇気流）+ 弱い FBM 乱流。
    windAt を「目標風速」として扱い、速度を時定数で緩和して追従させる
    （力の積算より軌道が安定し、きれいな螺旋になる）
  - 寿命制。中心近くの地表からスポーン → 螺旋上昇 → 上空 or 寿命切れで
    リスポーン。中心（vec2 uniform）は TornadoLayer が毎フレーム動かす
  - 地形衝突は共有サンプラ。地表下に潜ったら地表に押し戻す
*/
import {
  Fn,
  cos,
  exp,
  float,
  instanceIndex,
  length,
  select,
  sin,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'

import { createParticleBuffers } from './particleBuffers'
import { createWindField } from '../tsl/windField'

// ============================================================
// 調整用パラメータ
// ============================================================

const WORKGROUP_SIZE = 64
const DEFAULT_DELTA = 1 / 60

const LIFE_MAX = 4.5            // 寿命（秒）
const LIFE_MIN = 1.5
const VEL_TAU = 0.35            // 風速への緩和時定数（秒。小さいほど機敏）
const GRAVITY = 0.012           // 弱い重力（per-frame@60fps 単位）
const SPAWN_RADIUS = [0.25, 1.6] // スポーン半径（vortex.radius 比）
const ESCAPE_RADIUS = 6         // この半径（radius 比）を超えたらリスポーン
const GROUND_EPS = 0.02

// 弱い FBM 乱流（渦の主成分を邪魔しない程度）
const WIND_FIELD = {
  turbulenceScale: 0.6,
  turbulenceStrength: 0.006,
  timeScale: 0.6,
  yDamping: 0.4,
  gustFrequency: 0.4,
  gustStrength: 0.004,
  gustSpatialScale: { x: 0.08, z: 0.1 },
}

// ============================================================

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function createVortexComputeRunner({
  particleCount,
  topY,
  // windField へ渡す vortex uniform 群（TornadoLayer が所有・更新する）
  vortex, // { center(vec2), radius, tangential, inflow, updraft }
  heightSampler = null,
}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const hasHeightMap = !!heightSampler

  // 初期状態: 原点付近に散布し、寿命をずらして順次リスポーンさせる
  const initialPositions = new Float32Array(particleCount * 3)
  const initialLife = new Float32Array(particleCount)
  for (let i = 0; i < particleCount; i++) {
    const base = i * 3
    initialPositions[base] = (hash01(i * 0.37 + 7.9) - 0.5) * 2
    initialPositions[base + 1] = hash01(i * 0.61 + 3.1) * topY * 0.5
    initialPositions[base + 2] = (hash01(i * 0.17 + 2.1) - 0.5) * 2
    initialLife[i] = hash01(i * 1.91 + 0.7) * LIFE_MAX
  }

  const buffers = createParticleBuffers(particleCount, {
    pos: { itemSize: 3, data: initialPositions },
    vel: 3,
    life: { itemSize: 1, data: initialLife },
  })

  const positionNode = buffers.nodes.pos
  const velocityNode = buffers.nodes.vel
  const lifeNode = buffers.nodes.life

  const timeNode = uniform(0)
  const deltaNode = uniform(DEFAULT_DELTA)
  const topYNode = uniform(topY)

  const { windAt } = createWindField({
    turbScale: WIND_FIELD.turbulenceScale,
    turbStrength: WIND_FIELD.turbulenceStrength,
    gustFrequency: WIND_FIELD.gustFrequency,
    gustStrength: WIND_FIELD.gustStrength,
    timeScale: WIND_FIELD.timeScale,
    yDamping: WIND_FIELD.yDamping,
    gustSpatialScale: WIND_FIELD.gustSpatialScale,
    vortex,
  })

  const vortexComputeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)
    const life = lifeNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

    // --- 風場（渦 + 弱乱流）を目標風速として速度を緩和追従 ---
    const target = windAt(currentPos, timeNode).toVar()
    const k = float(1).sub(exp(deltaNode.div(-VEL_TAU))).toVar()
    const nextVel = currentVel.add(target.sub(currentVel).mul(k)).toVar()
    nextVel.y.subAssign(float(GRAVITY).mul(deltaNode)) // 弱い重力（速度単位/秒）

    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()

    // --- 地形衝突（潜ったら地表に押し戻し、上向きに反転） ---
    let groundY
    if (hasHeightMap) {
      groundY = heightSampler.heightAt(vec2(nextPos.x, nextPos.z)).toVar()
    } else {
      groundY = float(0).toVar()
    }
    const below = nextPos.y.lessThan(groundY.add(GROUND_EPS))
    nextPos.y.assign(select(below, groundY.add(GROUND_EPS), nextPos.y))
    nextVel.y.assign(select(below, nextVel.y.abs().mul(0.4), nextVel.y))

    // --- 寿命と離脱判定 ---
    const nextLife = life.sub(deltaNode).toVar()
    const rel = vec2(nextPos.x.sub(vortex.center.x), nextPos.z.sub(vortex.center.y))
    const tooFar = length(rel).greaterThan(vortex.radius.mul(ESCAPE_RADIUS))
    const tooHigh = nextPos.y.greaterThan(topYNode)
    const needsRespawn = nextLife.lessThanEqual(0).or(tooFar).or(tooHigh)

    // --- リスポーン: 中心近傍の地表リング ---
    const seed = timeNode.mul(0.47).add(idPhase.mul(19.3)).toVar()
    const angle = seed.mul(6.2832).add(idPhase)
    const radial = vortex.radius.mul(
      float(SPAWN_RADIUS[0]).add(
        sin(seed.mul(7.7)).mul(0.5).add(0.5).mul(SPAWN_RADIUS[1] - SPAWN_RADIUS[0])
      )
    )
    const spawnX = vortex.center.x.add(cos(angle).mul(radial)).toVar()
    const spawnZ = vortex.center.y.add(sin(angle).mul(radial)).toVar()
    let spawnGroundY
    if (hasHeightMap) {
      spawnGroundY = heightSampler.heightAt(vec2(spawnX, spawnZ)).toVar()
    } else {
      spawnGroundY = float(0).toVar()
    }
    const spawnPos = vec3(spawnX, spawnGroundY.add(GROUND_EPS + 0.02), spawnZ)
    // 接線方向の初速（すぐ渦に乗る）
    const tang = vec2(sin(angle), cos(angle).negate())
    const spawnVel = vec3(
      tang.x.mul(vortex.tangential).mul(0.6),
      float(0.005),
      tang.y.mul(vortex.tangential).mul(0.6)
    )
    const respawnLife = float(LIFE_MIN).add(
      sin(seed.mul(11.3)).mul(0.5).add(0.5).mul(LIFE_MAX - LIFE_MIN)
    )

    pos.assign(vec3(
      select(needsRespawn, spawnPos.x, nextPos.x),
      select(needsRespawn, spawnPos.y, nextPos.y),
      select(needsRespawn, spawnPos.z, nextPos.z)
    ))
    vel.assign(vec3(
      select(needsRespawn, spawnVel.x, nextVel.x),
      select(needsRespawn, spawnVel.y, nextVel.y),
      select(needsRespawn, spawnVel.z, nextVel.z)
    ))
    life.assign(select(needsRespawn, respawnLife, nextLife))
  })().compute(particleCount, [WORKGROUP_SIZE])

  return {
    particleCount,
    positionNode,
    velocityNode,
    lifeNode,
    lifeMax: LIFE_MAX,

    init(renderer) {
      renderer.compute(vortexComputeNode)
    },

    update(renderer, time, delta) {
      timeNode.value = time
      deltaNode.value = delta || DEFAULT_DELTA
      renderer.compute(vortexComputeNode)
    },

    destroy(renderer) {
      vortexComputeNode.dispose()
      buffers.dispose(renderer)
    },
  }
}
