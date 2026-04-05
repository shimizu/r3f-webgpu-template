/*
  雨パーティクルの GPU コンピュートシステム。

  runBarsCompute.js と同じパターンで、
  StorageBufferAttribute + TSL compute shader を使い、
  毎フレーム GPU 上でパーティクル位置を更新する。

  地形の高さデータ（heightMap）を読み取り専用バッファとして渡し、
  パーティクルが地表に到達したらリスポーンさせる。

  3D ノイズ風場:
  パーティクルの位置 + 時間から 3 オクターブの sin/cos FBM で
  風ベクトルを合成し、空間的に変化する乱流・突風・渦を表現する。
*/
import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  clamp,
  cos,
  float,
  instanceIndex,
  int,
  select,
  sin,
  storage,
  uniform,
  vec3,
} from 'three/tsl'

// ============================================================
// 調整用パラメータ — ここを変えれば見た目が変わる
// ============================================================

const WORKGROUP_SIZE = 64
const DEFAULT_DELTA = 1 / 60

// --- 初期速度のばらつき ---
const VELOCITY_VARIATION_MIN = 0.8   // 落下速度の最小倍率
const VELOCITY_VARIATION_MAX = 1.2   // 落下速度の最大倍率 (min + range)
const VELOCITY_HORIZONTAL_JITTER = 0.005 // 初期水平速度のランダム幅

// --- 3D ノイズ風場 ---
const WIND_FIELD = {
  turbulenceScale: 0.25,     // ノイズの空間周波数（小さい = 大きなうねり）
  turbulenceStrength: 0.012, // 乱流の強さ
  timeScale: 0.3,            // ノイズの時間変化速度
  yDamping: 0.3,             // Y 方向の風の減衰（重力に対して弱めにする）
  gustFrequency: 0.4,        // 突風の時間変動周波数
  gustStrength: 0.008,       // 突風の追加強度
  gustSpatialScale: { x: 0.05, z: 0.07 }, // 突風の空間変動スケール
  octaves: [
    { freq: 1.0, amp: 1.0 },   // オクターブ 1: 大きなうねり
    { freq: 2.3, amp: 0.5 },   // オクターブ 2: 中程度の渦
    { freq: 4.7, amp: 0.25 },  // オクターブ 3: 細かい乱流
  ],
}

// --- 速度制限 ---
const MAX_HORIZONTAL_SPEED = 0.06    // 水平速度の上限（発散防止）
const FALL_SPEED_MIN_RATIO = 0.3     // 落下速度の最小倍率（rainSpeed に対して）
const FALL_SPEED_MAX_RATIO = 1.5     // 落下速度の最大倍率

// --- リスポーン ---
const RESPAWN_WIND_CARRY = 0.5       // リスポーン時に風場の影響をどれだけ引き継ぐか
const RESPAWN_VELOCITY_JITTER = 0.005 // リスポーン速度の微小ランダム幅

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
  heightData = null,
  heightCols = 0,
  heightRows = 0,
  terrainWidth = 0,
  terrainDepth = 0,
}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const halfW = areaWidth / 2
  const halfD = areaDepth / 2

  // --- バッファ作成 ---
  const initialPositions = createInitialPositions(particleCount, halfW, halfD, topY)
  const initialVelocities = createInitialVelocities(particleCount, rainSpeed, wind)

  const positionAttribute = new StorageBufferAttribute(initialPositions, 3)
  const velocityAttribute = new StorageBufferAttribute(initialVelocities, 3)

  // --- TSL ノード ---
  const positionNode = storage(positionAttribute, 'vec3', particleCount)
  const velocityNode = storage(velocityAttribute, 'vec3', particleCount)

  // 高さマップ（地形衝突用）
  let heightMapNode = null
  const hasHeightMap = heightData && heightCols > 0 && heightRows > 0
  if (hasHeightMap) {
    const heightMapAttribute = new StorageBufferAttribute(
      new Float32Array(heightData), 1
    )
    heightMapNode = storage(heightMapAttribute, 'float', heightCols * heightRows).toReadOnly()
  }

  // --- ユニフォーム ---
  const timeNode = uniform(0)
  const deltaNode = uniform(DEFAULT_DELTA)
  const halfWNode = uniform(halfW)
  const halfDNode = uniform(halfD)
  const topYNode = uniform(topY)
  const rainSpeedNode = uniform(rainSpeed)
  const windXNode = uniform(wind[0])
  const windZNode = uniform(wind[2])

  // 地形パラメータ
  const heightColsNode = uniform(heightCols)
  const heightRowsNode = uniform(heightRows)
  const terrainHalfWNode = uniform(terrainWidth / 2)
  const terrainHalfDNode = uniform(terrainDepth / 2)
  const terrainWidthNode = uniform(terrainWidth)
  const terrainDepthNode = uniform(terrainDepth)

  // 風場ユニフォーム
  const turbScaleNode = uniform(WIND_FIELD.turbulenceScale)
  const turbStrengthNode = uniform(WIND_FIELD.turbulenceStrength)
  const gustFreqNode = uniform(WIND_FIELD.gustFrequency)
  const gustStrengthNode = uniform(WIND_FIELD.gustStrength)

  // --- コンピュートシェーダー ---
  const computeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

    // --- 3D ノイズ風場 ---
    const noiseX = currentPos.x.mul(turbScaleNode).toVar()
    const noiseY = currentPos.y.mul(turbScaleNode).toVar()
    const noiseZ = currentPos.z.mul(turbScaleNode).toVar()
    const noiseT = timeNode.mul(WIND_FIELD.timeScale).toVar()

    const windFX = float(0).toVar()
    const windFY = float(0).toVar()
    const windFZ = float(0).toVar()

    // オクターブ 1: 大きなうねり
    const f1 = float(WIND_FIELD.octaves[0].freq)
    const a1 = float(WIND_FIELD.octaves[0].amp)
    windFX.addAssign(sin(noiseX.mul(f1).mul(1.7).add(noiseZ.mul(2.3)).add(noiseT.mul(1.1))).mul(a1))
    windFY.addAssign(cos(noiseY.mul(f1).mul(1.3).add(noiseX.mul(1.9)).add(noiseT.mul(0.7))).mul(a1).mul(WIND_FIELD.yDamping))
    windFZ.addAssign(sin(noiseZ.mul(f1).mul(2.1).add(noiseY.mul(1.7)).add(noiseT.mul(0.9))).mul(a1))

    // オクターブ 2: 中程度の渦
    const f2 = float(WIND_FIELD.octaves[1].freq)
    const a2 = float(WIND_FIELD.octaves[1].amp)
    windFX.addAssign(cos(noiseX.mul(f2).mul(3.1).add(noiseY.mul(4.7)).add(noiseT.mul(1.9))).mul(a2))
    windFY.addAssign(sin(noiseZ.mul(f2).mul(2.7).add(noiseX.mul(3.3)).add(noiseT.mul(1.3))).mul(a2).mul(WIND_FIELD.yDamping))
    windFZ.addAssign(cos(noiseZ.mul(f2).mul(3.7).add(noiseY.mul(2.9)).add(noiseT.mul(1.7))).mul(a2))

    // オクターブ 3: 細かい乱流
    const f3 = float(WIND_FIELD.octaves[2].freq)
    const a3 = float(WIND_FIELD.octaves[2].amp)
    windFX.addAssign(sin(noiseX.mul(f3).mul(5.3).add(noiseZ.mul(7.1)).add(noiseT.mul(2.7))).mul(a3))
    windFY.addAssign(cos(noiseY.mul(f3).mul(4.9).add(noiseZ.mul(6.3)).add(noiseT.mul(2.1))).mul(a3).mul(WIND_FIELD.yDamping))
    windFZ.addAssign(sin(noiseZ.mul(f3).mul(6.7).add(noiseX.mul(5.9)).add(noiseT.mul(2.9))).mul(a3))

    // 突風: 低周波の時間変動で風全体が一時的に強まる
    const gustPhase = timeNode.mul(gustFreqNode).add(
      currentPos.x.mul(WIND_FIELD.gustSpatialScale.x).add(
        currentPos.z.mul(WIND_FIELD.gustSpatialScale.z)
      )
    ).toVar()
    const gustFactor = sin(gustPhase).mul(0.5).add(0.5).toVar()
    const gustBoost = gustFactor.mul(gustStrengthNode).toVar()

    // 風場の合成: 乱流 + 突風
    const windForce = vec3(
      windFX.mul(turbStrengthNode).add(gustBoost.mul(sin(gustPhase.mul(1.3)))),
      windFY.mul(turbStrengthNode),
      windFZ.mul(turbStrengthNode).add(gustBoost.mul(cos(gustPhase.mul(0.9))))
    ).mul(frameScale).toVar()

    // 速度更新: 現在速度に風場を加算
    const nextVel = currentVel.add(windForce).toVar()

    // 水平速度をクランプして発散を防ぐ
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
    let groundY
    if (hasHeightMap) {
      const u = nextPos.x.add(terrainHalfWNode).div(terrainWidthNode).toVar()
      const v = nextPos.z.add(terrainHalfDNode).div(terrainDepthNode).toVar()
      const uClamped = clamp(u, 0.0, 0.999).toVar()
      const vClamped = clamp(v, 0.0, 0.999).toVar()

      const col = int(uClamped.mul(heightColsNode.sub(1)))
      const row = int(vClamped.mul(heightRowsNode.sub(1)))
      const heightIndex = row.mul(int(heightColsNode)).add(col)

      groundY = heightMapNode.element(heightIndex).toVar()
    } else {
      groundY = float(0.0).toVar()
    }

    // --- リスポーン判定 ---
    const hitGround = nextPos.y.lessThanEqual(groundY)
    const outX = nextPos.x.abs().greaterThan(halfWNode)
    const outZ = nextPos.z.abs().greaterThan(halfDNode)
    const needsRespawn = hitGround.or(outX).or(outZ)

    const respawnSeed = timeNode.mul(0.41).add(idPhase.mul(23.7)).toVar()
    const respawnPos = vec3(
      sin(respawnSeed.mul(1.3).add(idPhase.mul(3.1))).mul(halfWNode),
      topYNode,
      cos(respawnSeed.mul(1.7).add(idPhase.mul(5.9))).mul(halfDNode)
    ).toVar()

    // リスポーン速度: 下向き + ベース風 + 風場の影響を一部引き継ぎ
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

  return {
    particleCount,
    positionAttribute,
    positionNode,
    velocityNode,

    init(renderer) {
      renderer.compute(computeNode)
    },

    update(renderer, time, delta) {
      timeNode.value = time
      deltaNode.value = delta || DEFAULT_DELTA
      renderer.compute(computeNode)
    },

    destroy() {
      computeNode.dispose()
    },
  }
}
