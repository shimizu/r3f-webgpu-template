/*
  雨パーティクルの GPU コンピュートシステム。

  runBarsCompute.js と同じパターンで、
  StorageBufferAttribute + TSL compute shader を使い、
  毎フレーム GPU 上でパーティクル位置を更新する。

  地形の高さデータ（heightMap）を読み取り専用バッファとして渡し、
  パーティクルが地表に到達したらリスポーンさせる。
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

const WORKGROUP_SIZE = 64
const DEFAULT_DELTA = 1 / 60

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// 初期位置をエリア内にランダム分布させる
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

// 初期速度: 下向き + 風
function createInitialVelocities(particleCount, rainSpeed, wind) {
  const velocities = new Float32Array(particleCount * 3)
  for (let i = 0; i < particleCount; i++) {
    const base = i * 3
    const variation = 0.8 + hash01(i * 1.23 + 5.7) * 0.4
    velocities[base] = wind[0] + (hash01(i * 2.31 + 1.4) - 0.5) * 0.005
    velocities[base + 1] = -rainSpeed * variation
    velocities[base + 2] = wind[2] + (hash01(i * 3.17 + 8.2) - 0.5) * 0.005
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

  // --- コンピュートシェーダー ---
  const computeNode = Fn(() => {
    const pos = positionNode.element(instanceIndex)
    const vel = velocityNode.element(instanceIndex)

    const currentPos = pos.toVar()
    const currentVel = vel.toVar()

    const frameScale = deltaNode.mul(60).toVar()
    const idPhase = float(instanceIndex).mul(0.17).toVar()

    // 風のジッター（微小な揺らぎで自然さを出す）
    const jitter = vec3(
      sin(timeNode.mul(2.1).add(idPhase.mul(31.7)).add(currentPos.y.mul(4.3))).mul(0.003),
      float(0.0),
      cos(timeNode.mul(1.8).add(idPhase.mul(47.3)).add(currentPos.y.mul(3.1))).mul(0.003)
    ).mul(frameScale).toVar()

    const nextVel = currentVel.add(jitter).toVar()
    const nextPos = currentPos.add(nextVel.mul(frameScale)).toVar()

    // --- 地形高さサンプリング ---
    let groundY
    if (hasHeightMap) {
      // パーティクルの XZ → 地形グリッド UV
      const u = nextPos.x.add(terrainHalfWNode).div(terrainWidthNode).toVar()
      const v = nextPos.z.add(terrainHalfDNode).div(terrainDepthNode).toVar()
      const uClamped = clamp(u, 0.0, 0.999).toVar()
      const vClamped = clamp(v, 0.0, 0.999).toVar()

      // グリッドインデックス計算
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

    // リスポーン位置: エリア内ランダム、天井付近
    const respawnSeed = timeNode.mul(0.41).add(idPhase.mul(23.7)).toVar()
    const respawnPos = vec3(
      sin(respawnSeed.mul(1.3).add(idPhase.mul(3.1))).mul(halfWNode),
      topYNode,
      cos(respawnSeed.mul(1.7).add(idPhase.mul(5.9))).mul(halfDNode)
    ).toVar()

    // リスポーン速度: 下向き + 風 + 微小変動
    const respawnVel = vec3(
      windXNode.add(sin(respawnSeed.mul(2.3)).mul(0.003)),
      rainSpeedNode.negate(),
      windZNode.add(cos(respawnSeed.mul(2.7)).mul(0.003))
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
