/*
  降雪パーティクルの GPU コンピュートシステム（plan.md D2）。

  runRainCompute をテンプレートにしたコピーベース派生。雨との違い:
  - 落下速度は約 1/7（ふわふわ落ちる）
  - 風場（windField 共有 Fn）の影響が強く、水平に大きく流される
  - スプラッシュなし。着地後は rest 秒だけ地表に静止し、フェードして
    消えてからリスポーンする（rest バッファで管理）
  - フレークの回転は compute では扱わない（描画側 vertex で time × 個体位相）

  地形衝突は HeightFieldContext の共有サンプラ（バイリニア補間）を使う。
*/
import {
  Fn,
  clamp,
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
// 調整用パラメータ — ここを変えれば見た目が変わる
// ============================================================

const WORKGROUP_SIZE = 64
const DEFAULT_DELTA = 1 / 60

// --- 初期速度のばらつき ---
const VELOCITY_VARIATION_MIN = 0.6   // 落下速度の最小倍率
const VELOCITY_VARIATION_MAX = 1.6   // 落下速度の最大倍率
const VELOCITY_HORIZONTAL_JITTER = 0.008 // 初期水平速度のランダム幅

// --- 3D ノイズ風場（雨より強く、フレークが横に流される） ---
const WIND_FIELD = {
  turbulenceScale: 0.25,     // ノイズの空間周波数
  turbulenceStrength: 0.035, // 乱流の強さ（雨の 3.5 倍: ふわふわ感の主因）
  timeScale: 0.35,           // ノイズの時間変化速度
  yDamping: 0.35,            // Y 方向も揺らして浮遊感を出す
  gustFrequency: 0.35,       // 突風の時間変動周波数
  gustStrength: 0.025,       // 突風の追加強度
  gustSpatialScale: { x: 0.05, z: 0.06 }, // 突風の空間変動スケール
}

// --- 速度制限（雨より緩く、大きく流される） ---
const MAX_HORIZONTAL_SPEED = 0.045
const FALL_SPEED_MIN_RATIO = 0.35    // 上昇気流で一瞬止まりかけるくらいまで許す
const FALL_SPEED_MAX_RATIO = 1.8

// --- 着地静止 ---
const REST_TIME = 1.5                // 地表に静止してからフェード消滅するまでの秒数

// --- リスポーン ---
const RESPAWN_WIND_CARRY = 0.5       // リスポーン時に風場の影響をどれだけ引き継ぐか
const RESPAWN_VELOCITY_JITTER = 0.008

// ============================================================

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function createInitialPositions(particleCount, halfW, halfD, topY) {
  const positions = new Float32Array(particleCount * 3)
  for (let i = 0; i < particleCount; i++) {
    const base = i * 3
    positions[base] = (hash01(i * 0.37 + 7.9) - 0.5) * 2 * halfW
    positions[base + 1] = hash01(i * 0.61 + 3.1) * topY
    positions[base + 2] = (hash01(i * 0.17 + 2.1) - 0.5) * 2 * halfD
  }
  return positions
}

function createInitialVelocities(particleCount, snowSpeed, wind) {
  const velocities = new Float32Array(particleCount * 3)
  const range = VELOCITY_VARIATION_MAX - VELOCITY_VARIATION_MIN
  for (let i = 0; i < particleCount; i++) {
    const base = i * 3
    const variation = VELOCITY_VARIATION_MIN + hash01(i * 1.23 + 5.7) * range
    velocities[base] = wind[0] + (hash01(i * 2.31 + 1.4) - 0.5) * VELOCITY_HORIZONTAL_JITTER
    velocities[base + 1] = -snowSpeed * variation
    velocities[base + 2] = wind[2] + (hash01(i * 3.17 + 8.2) - 0.5) * VELOCITY_HORIZONTAL_JITTER
  }
  return velocities
}

export function createSnowComputeRunner({
  particleCount,
  areaWidth,
  areaDepth,
  topY,
  snowSpeed = 0.012,
  wind = [0.006, 0, 0.003],
  // HeightFieldContext の共有サンプラ（{ heightAt } を持つ）。
  // null なら地形なし = y=0 平面に衝突する
  heightSampler = null,
}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const halfW = areaWidth / 2
  const halfD = areaDepth / 2
  const hasHeightMap = !!heightSampler

  // --- フレークバッファ（rest > 0 の間は着地静止 + フェード中） ---
  const buffers = createParticleBuffers(particleCount, {
    pos: { itemSize: 3, data: createInitialPositions(particleCount, halfW, halfD, topY) },
    vel: { itemSize: 3, data: createInitialVelocities(particleCount, snowSpeed, wind) },
    rest: 1,
  })

  const positionNode = buffers.nodes.pos
  const velocityNode = buffers.nodes.vel
  const restNode = buffers.nodes.rest

  // --- ユニフォーム ---
  const timeNode = uniform(0)
  const deltaNode = uniform(DEFAULT_DELTA)
  const halfWNode = uniform(halfW)
  const halfDNode = uniform(halfD)
  const topYNode = uniform(topY)
  const snowSpeedNode = uniform(snowSpeed)
  const windXNode = uniform(wind[0])
  const windZNode = uniform(wind[2])

  const turbScaleNode = uniform(WIND_FIELD.turbulenceScale)
  const turbStrengthNode = uniform(WIND_FIELD.turbulenceStrength)
  const gustFreqNode = uniform(WIND_FIELD.gustFrequency)
  const gustStrengthNode = uniform(WIND_FIELD.gustStrength)

  // --- 3D ノイズ風場（共有 Fn。strength/scale は uniform 駆動） ---
  const { windAt } = createWindField({
    turbScale: turbScaleNode,
    turbStrength: turbStrengthNode,
    gustFrequency: gustFreqNode,
    gustStrength: gustStrengthNode,
    timeScale: WIND_FIELD.timeScale,
    yDamping: WIND_FIELD.yDamping,
    gustSpatialScale: WIND_FIELD.gustSpatialScale,
  })

  // --- 雪コンピュートシェーダー ---
  const snowComputeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)
    const rest = restNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()
    const currentRest = rest.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

    const resting = currentRest.greaterThan(0.0)

    // --- 落下更新（静止中の分も計算するが、最後の select で無効化される） ---
    const windForce = windAt(currentPos, timeNode).mul(frameScale).toVar()
    const nextVel = currentVel.add(windForce).toVar()

    // 水平速度クランプ
    const hSpeedSq = nextVel.x.mul(nextVel.x).add(nextVel.z.mul(nextVel.z)).toVar()
    const maxHSpeedSq = float(MAX_HORIZONTAL_SPEED * MAX_HORIZONTAL_SPEED)
    const hScale = select(
      hSpeedSq.greaterThan(maxHSpeedSq),
      float(MAX_HORIZONTAL_SPEED).div(hSpeedSq.pow(0.5)),
      float(1.0)
    )
    nextVel.x.assign(nextVel.x.mul(hScale))
    nextVel.z.assign(nextVel.z.mul(hScale))

    // Y 速度を落下方向に維持（雨より緩いレンジで漂わせる）
    nextVel.y.assign(clamp(
      nextVel.y,
      snowSpeedNode.negate().mul(FALL_SPEED_MAX_RATIO),
      snowSpeedNode.negate().mul(FALL_SPEED_MIN_RATIO)
    ))

    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()

    // --- 地形高さサンプリング（共有サンプラ = 草・雨と同一実装） ---
    let groundY
    if (hasHeightMap) {
      groundY = heightSampler.heightAt(vec2(nextPos.x, nextPos.z)).toVar()
    } else {
      groundY = float(0.0).toVar()
    }

    // --- 状態判定 ---
    // 落下中に接地 → 静止開始 / 静止中に rest が切れる or 落下中に場外 → リスポーン
    const hitGround = resting.not().and(nextPos.y.lessThanEqual(groundY))
    const outside = resting.not().and(
      nextPos.x.abs().greaterThan(halfWNode).or(nextPos.z.abs().greaterThan(halfDNode))
    )
    const restExpired = resting.and(currentRest.sub(deltaNode).lessThanEqual(0.0))
    const needsRespawn = restExpired.or(outside)

    // --- リスポーン先 ---
    const respawnSeed = timeNode.mul(0.41).add(idPhase.mul(23.7)).toVar()
    const respawnPos = vec3(
      sin(respawnSeed.mul(1.3).add(idPhase.mul(3.1))).mul(halfWNode),
      topYNode,
      cos(respawnSeed.mul(1.7).add(idPhase.mul(5.9))).mul(halfDNode)
    ).toVar()
    const respawnVel = vec3(
      windXNode.add(windForce.x.mul(RESPAWN_WIND_CARRY)).add(sin(respawnSeed.mul(2.3)).mul(RESPAWN_VELOCITY_JITTER)),
      snowSpeedNode.negate(),
      windZNode.add(windForce.z.mul(RESPAWN_WIND_CARRY)).add(cos(respawnSeed.mul(2.7)).mul(RESPAWN_VELOCITY_JITTER))
    ).toVar()

    // 着地スナップ位置（地表のわずかに上でフェードさせる）
    const landPos = vec3(nextPos.x, groundY.add(0.004), nextPos.z)

    // --- 最終状態の合成: respawn > 静止継続 > 着地 > 落下 ---
    const finalPos = vec3(
      select(needsRespawn, respawnPos.x, select(resting, currentPos.x, select(hitGround, landPos.x, nextPos.x))),
      select(needsRespawn, respawnPos.y, select(resting, currentPos.y, select(hitGround, landPos.y, nextPos.y))),
      select(needsRespawn, respawnPos.z, select(resting, currentPos.z, select(hitGround, landPos.z, nextPos.z)))
    )
    const still = resting.or(hitGround)
    const finalVel = vec3(
      select(needsRespawn, respawnVel.x, select(still, float(0), nextVel.x)),
      select(needsRespawn, respawnVel.y, select(still, float(0), nextVel.y)),
      select(needsRespawn, respawnVel.z, select(still, float(0), nextVel.z))
    )
    const finalRest = select(
      needsRespawn,
      float(0),
      select(resting, currentRest.sub(deltaNode), select(hitGround, float(REST_TIME), float(0)))
    )

    pos.assign(finalPos)
    vel.assign(finalVel)
    rest.assign(finalRest)
  })().compute(particleCount, [WORKGROUP_SIZE])

  return {
    particleCount,
    positionNode,
    velocityNode,
    restNode,
    restMax: REST_TIME,

    init(renderer) {
      renderer.compute(snowComputeNode)
    },

    update(renderer, time, delta) {
      timeNode.value = time
      deltaNode.value = delta || DEFAULT_DELTA
      renderer.compute(snowComputeNode)
    },

    destroy(renderer) {
      snowComputeNode.dispose()
      // 高さマップは HeightFieldContext 所有なのでここでは解放しない
      buffers.dispose(renderer)
    },
  }
}
