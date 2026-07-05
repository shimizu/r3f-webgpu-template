/*
  雨パーティクルの GPU コンピュートシステム。

  StorageBufferAttribute + TSL compute shader を使い、
  毎フレーム GPU 上でパーティクル位置を更新する。
  新しい災害パーティクル（雪・火の粉など）はこのファイルをテンプレートに
  コピーベースで派生させる（plan.md R4 参照）。

  地形の高さデータ（heightMap）を読み取り専用バッファとして渡し、
  パーティクルが地表に到達したらリスポーンさせる。

  3D ノイズ風場:
  パーティクルの位置 + 時間から 3 オクターブの sin/cos FBM で
  風ベクトルを合成し、空間的に変化する乱流・突風・渦を表現する。

  スプラッシュ:
  雨粒が地面に衝突すると、同インデックスのスプラッシュ粒子を発生させる。
  スプラッシュは衝突点から放射状に広がり、重力で落下しながら寿命で消える。
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
const VELOCITY_VARIATION_MIN = 0.8   // 落下速度の最小倍率
const VELOCITY_VARIATION_MAX = 1.2   // 落下速度の最大倍率 (min + range)
const VELOCITY_HORIZONTAL_JITTER = 0.005 // 初期水平速度のランダム幅

// --- 3D ノイズ風場（実装は src/tsl/windField.js を共有） ---
const WIND_FIELD = {
  turbulenceScale: 0.2,     // ノイズの空間周波数（小さい = 大きなうねり）
  turbulenceStrength: 0.01, // 乱流の強さ（控えめ: ほぼ真下に落ちつつ微かに揺れる程度）
  timeScale: 0.5,           // ノイズの時間変化速度（ゆっくり変化）
  yDamping: 0.1,             // Y 方向の風の減衰（ほぼゼロ）
  gustFrequency: 0.5,        // 突風の時間変動周波数（穏やかに）
  gustStrength: 0.02,       // 突風の追加強度（控えめ）
  gustSpatialScale: { x: 0.03, z: 0.04 }, // 突風の空間変動スケール
}

// --- 速度制限 ---
const MAX_HORIZONTAL_SPEED = 0.02    // 水平速度の上限（しっかり抑える）
const FALL_SPEED_MIN_RATIO = 0.7     // 落下速度の最小倍率（あまり遅くならない）
const FALL_SPEED_MAX_RATIO = 1.3     // 落下速度の最大倍率

// --- リスポーン ---
const RESPAWN_WIND_CARRY = 0.5       // リスポーン時に風場の影響をどれだけ引き継ぐか
const RESPAWN_VELOCITY_JITTER = 0.005 // リスポーン速度の微小ランダム幅

// --- スプラッシュ ---
const SPLASH = {
  maxLife: 0.4,              // スプラッシュの最大寿命（秒）
  radiusSpeed: 0.04,         // 放射方向の初速
  radiusVariation: 0.02,     // 放射速度のランダム幅
  upSpeed: 0.03,             // 上向きの初速
  upVariation: 0.015,        // 上向き速度のランダム幅
  gravity: 0.15,             // スプラッシュにかかる重力加速度
  damping: 0.97,             // 水平速度の減衰（毎フレーム）
}

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

function createInitialVelocities(particleCount, rainSpeed, wind) {
  const velocities = new Float32Array(particleCount * 3)
  const range = VELOCITY_VARIATION_MAX - VELOCITY_VARIATION_MIN
  for (let i = 0; i < particleCount; i++) {
    const base = i * 3
    const variation = VELOCITY_VARIATION_MIN + hash01(i * 1.23 + 5.7) * range
    velocities[base] = wind[0] + (hash01(i * 2.31 + 1.4) - 0.5) * VELOCITY_HORIZONTAL_JITTER
    velocities[base + 1] = -rainSpeed * variation
    velocities[base + 2] = wind[2] + (hash01(i * 3.17 + 8.2) - 0.5) * VELOCITY_HORIZONTAL_JITTER
  }
  return velocities
}

export function createRainComputeRunner({
  particleCount,
  areaWidth,
  areaDepth,
  topY,
  rainSpeed,
  wind = [0.01, 0, 0.005],
  // HeightFieldContext の共有サンプラ（{ heightAt } を持つ）。
  // null なら地形なし = y=0 平面に衝突する
  heightSampler = null,
}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const halfW = areaWidth / 2
  const halfD = areaDepth / 2

  // --- 雨バッファ + スプラッシュバッファ（スプラッシュは雨粒と 1:1。life <= 0 なら非表示） ---
  const buffers = createParticleBuffers(particleCount, {
    pos: { itemSize: 3, data: createInitialPositions(particleCount, halfW, halfD, topY) },
    vel: { itemSize: 3, data: createInitialVelocities(particleCount, rainSpeed, wind) },
    splashPos: 3,
    splashVel: 3,
    splashLife: 1,
  })

  const positionNode = buffers.nodes.pos
  const velocityNode = buffers.nodes.vel
  const splashPosNode = buffers.nodes.splashPos
  const splashVelNode = buffers.nodes.splashVel
  const splashLifeNode = buffers.nodes.splashLife

  // --- 高さマップ ---
  // GPU バッファは HeightFieldContext が 1 個だけ保持し、共有サンプラ経由で参照する
  const hasHeightMap = !!heightSampler

  // --- ユニフォーム ---
  const timeNode = uniform(0)
  const deltaNode = uniform(DEFAULT_DELTA)
  const halfWNode = uniform(halfW)
  const halfDNode = uniform(halfD)
  const topYNode = uniform(topY)
  const rainSpeedNode = uniform(rainSpeed)
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

  // --- 雨コンピュートシェーダー ---
  const rainComputeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

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

    // Y 速度を落下方向に維持
    nextVel.y.assign(clamp(
      nextVel.y,
      rainSpeedNode.negate().mul(FALL_SPEED_MAX_RATIO),
      rainSpeedNode.negate().mul(FALL_SPEED_MIN_RATIO)
    ))

    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()

    // --- 地形高さサンプリング ---
    // 共有サンプラ（sampleHeightField のバイリニア補間。草の接地と同一実装）
    let groundY
    if (hasHeightMap) {
      groundY = heightSampler.heightAt(vec2(nextPos.x, nextPos.z)).toVar()
    } else {
      groundY = float(0.0).toVar()
    }

    // --- 衝突判定 ---
    const hitGround = nextPos.y.lessThanEqual(groundY)
    const outX = nextPos.x.abs().greaterThan(halfWNode)
    const outZ = nextPos.z.abs().greaterThan(halfDNode)
    const needsRespawn = hitGround.or(outX).or(outZ)

    // --- スプラッシュ発生 ---
    // 地面に衝突した場合のみスプラッシュを発生させる（エリア外脱出では発生しない）
    const splashPos = splashPosNode.element(instanceIndex)
    const splashVel = splashVelNode.element(instanceIndex)
    const splashLife = splashLifeNode.element(instanceIndex)

    // 衝突点でスプラッシュを発生: 放射方向にランダムな速度 + 上向き初速
    const splashSeed = timeNode.mul(0.73).add(idPhase.mul(37.1)).toVar()
    const splashAngle = splashSeed.mul(6.2832) // 0〜2π
    const splashRadius = float(SPLASH.radiusSpeed).add(
      sin(splashSeed.mul(13.7)).mul(SPLASH.radiusVariation)
    )
    const splashUp = float(SPLASH.upSpeed).add(
      cos(splashSeed.mul(17.3)).mul(SPLASH.upVariation)
    )

    const newSplashVel = vec3(
      cos(splashAngle).mul(splashRadius),
      splashUp,
      sin(splashAngle).mul(splashRadius)
    )

    // hitGround の時だけスプラッシュを初期化
    // 衝突点の位置を使い、Y は地表高さにスナップ
    const hitPos = vec3(nextPos.x, groundY, nextPos.z)

    splashPos.assign(vec3(
      select(hitGround, hitPos.x, splashPos.x),
      select(hitGround, hitPos.y, splashPos.y),
      select(hitGround, hitPos.z, splashPos.z)
    ))
    splashVel.assign(vec3(
      select(hitGround, newSplashVel.x, splashVel.x),
      select(hitGround, newSplashVel.y, splashVel.y),
      select(hitGround, newSplashVel.z, splashVel.z)
    ))
    splashLife.assign(select(hitGround, float(SPLASH.maxLife), splashLife))

    // --- 雨粒リスポーン ---
    const respawnSeed = timeNode.mul(0.41).add(idPhase.mul(23.7)).toVar()
    const respawnPos = vec3(
      sin(respawnSeed.mul(1.3).add(idPhase.mul(3.1))).mul(halfWNode),
      topYNode,
      cos(respawnSeed.mul(1.7).add(idPhase.mul(5.9))).mul(halfDNode)
    ).toVar()

    const respawnVel = vec3(
      windXNode.add(windForce.x.mul(RESPAWN_WIND_CARRY)).add(sin(respawnSeed.mul(2.3)).mul(RESPAWN_VELOCITY_JITTER)),
      rainSpeedNode.negate(),
      windZNode.add(windForce.z.mul(RESPAWN_WIND_CARRY)).add(cos(respawnSeed.mul(2.7)).mul(RESPAWN_VELOCITY_JITTER))
    ).toVar()

    const finalPos = vec3(
      select(needsRespawn, respawnPos.x, nextPos.x),
      select(needsRespawn, respawnPos.y, nextPos.y),
      select(needsRespawn, respawnPos.z, nextPos.z)
    ).toVar()

    const finalVel = vec3(
      select(needsRespawn, respawnVel.x, nextVel.x),
      select(needsRespawn, respawnVel.y, nextVel.y),
      select(needsRespawn, respawnVel.z, nextVel.z)
    ).toVar()

    pos.assign(finalPos)
    vel.assign(finalVel)
  })().compute(particleCount, [WORKGROUP_SIZE])

  // --- スプラッシュ更新コンピュートシェーダー ---
  // 放射状に広がり、重力で落下し、寿命で消える
  const splashComputeNode = Fn(() => {
    const sPos = splashPosNode.element(instanceIndex)
    const sVel = splashVelNode.element(instanceIndex)
    const sLife = splashLifeNode.element(instanceIndex)

    const currentLife = sLife.toVar()
    const currentVel = sVel.toVar()
    const currentPos = sPos.toVar()

    const frameScale = deltaNode.mul(60).toVar()

    // 寿命を減らす
    const nextLife = currentLife.sub(deltaNode).toVar()

    // 生存中のみ更新
    const alive = nextLife.greaterThan(0)

    // 重力を適用
    const nextVelY = currentVel.y.sub(float(SPLASH.gravity).mul(deltaNode)).toVar()

    // 水平減衰
    const nextVelX = currentVel.x.mul(SPLASH.damping).toVar()
    const nextVelZ = currentVel.z.mul(SPLASH.damping).toVar()

    const nextVel = vec3(nextVelX, nextVelY, nextVelZ).toVar()

    // 位置更新
    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()

    // 生存中なら更新、死亡なら位置を遠くに飛ばして非表示に
    sPos.assign(vec3(
      select(alive, nextPos.x, float(9999)),
      select(alive, nextPos.y, float(9999)),
      select(alive, nextPos.z, float(9999))
    ))
    sVel.assign(select(alive, nextVel, vec3(0, 0, 0)))
    sLife.assign(nextLife)
  })().compute(particleCount, [WORKGROUP_SIZE])

  return {
    particleCount,
    positionAttribute: buffers.attributes.pos,
    positionNode,
    velocityNode,

    // スプラッシュ
    splashPosNode,
    splashLifeNode,

    init(renderer) {
      renderer.compute(rainComputeNode)
      renderer.compute(splashComputeNode)
    },

    update(renderer, time, delta) {
      timeNode.value = time
      deltaNode.value = delta || DEFAULT_DELTA
      renderer.compute(rainComputeNode)
      renderer.compute(splashComputeNode)
    },

    destroy(renderer) {
      rainComputeNode.dispose()
      splashComputeNode.dispose()
      // 高さマップは HeightFieldContext 所有なのでここでは解放しない
      buffers.dispose(renderer)
    },
  }
}
