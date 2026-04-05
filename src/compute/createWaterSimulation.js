/*
  ハイトフィールド水シミュレーション compute エンジン

  256x256 の StorageTexture に水面の状態を格納し、
  波動方程式で毎フレーム更新する。

  テクスチャチャンネル:
    R = 水面の高さ
    G = 速度（高さの変化率）
    B = 法線 X 成分
    A = 法線 Z 成分

  3つの compute パス:
    1. update: 波動方程式（近傍平均 → 速度 → 高さ）
    2. normal: 高さ勾配から法線を計算
    3. drop:   指定位置にコサイン減衰の波紋を追加
*/
import { FloatType, RGBAFormat } from 'three'
import { StorageTexture } from 'three/webgpu'
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'

const SIM_SIZE = 256
const WORKGROUP_SIZE = 64
const TOTAL_THREADS = SIM_SIZE * SIM_SIZE

// 波動方程式パラメータ
const WAVE_STIFFNESS = 2.0   // 近傍平均への追従速度
const WAVE_DAMPING = 0.995   // 速度の減衰率（1フレームあたり0.5%減衰）

function createSimTexture() {
  const tex = new StorageTexture(SIM_SIZE, SIM_SIZE)
  tex.type = FloatType
  tex.format = RGBAFormat
  return tex
}

// instanceIndex → 2D座標
function indexToCoord() {
  const x = int(instanceIndex.mod(SIM_SIZE))
  const y = int(instanceIndex.div(SIM_SIZE))
  return ivec2(x, y)
}

function createUpdateCompute(texRead, texWrite) {
  return Fn(() => {
    const coord = indexToCoord()
    const x = coord.x
    const y = coord.y

    const info = textureLoad(texRead, coord, 0).toVar()

    // 4近傍の高さを取得（境界クランプ）
    const left = textureLoad(texRead, ivec2(x.sub(1).max(0), y), 0)
    const right = textureLoad(texRead, ivec2(x.add(1).min(SIM_SIZE - 1), y), 0)
    const up = textureLoad(texRead, ivec2(x, y.sub(1).max(0)), 0)
    const down = textureLoad(texRead, ivec2(x, y.add(1).min(SIM_SIZE - 1)), 0)

    // 波動方程式
    const average = left.x.add(right.x).add(up.x).add(down.x).mul(0.25)
    const velocity = info.y.add(average.sub(info.x).mul(WAVE_STIFFNESS)).mul(WAVE_DAMPING)
    const height = info.x.add(velocity)

    // 法線は別パスで計算するので BA はそのまま保持
    textureStore(texWrite, coord, vec4(height, velocity, info.z, info.w)).toWriteOnly()
  })().compute(TOTAL_THREADS, [WORKGROUP_SIZE])
}

function createNormalCompute(texRead, texWrite) {
  return Fn(() => {
    const coord = indexToCoord()
    const x = coord.x
    const y = coord.y

    const info = textureLoad(texRead, coord, 0).toVar()

    // 隣接テクセルの高さから有限差分で法線を計算
    const hRight = textureLoad(texRead, ivec2(x.add(1).min(SIM_SIZE - 1), y), 0).x
    const hUp = textureLoad(texRead, ivec2(x, y.add(1).min(SIM_SIZE - 1)), 0).x

    const delta = float(1.0 / SIM_SIZE)

    // 接線ベクトル: dx = (delta, hRight - h, 0), dy = (0, hUp - h, delta)
    // cross(dy, dx) = (-(hRight-h)*delta, delta*delta, -(hUp-h)*delta) は不要
    // 簡略化: normalX = (h - hRight), normalZ = (h - hUp)
    // Y成分は再構成時に sqrt(1 - nx*nx - nz*nz) で復元
    const nx = info.x.sub(hRight)
    const nz = info.x.sub(hUp)

    textureStore(texWrite, coord, vec4(info.x, info.y, nx, nz)).toWriteOnly()
  })().compute(TOTAL_THREADS, [WORKGROUP_SIZE])
}

function createDropCompute(texRead, texWrite, centerU, radiusU, strengthU) {
  return Fn(() => {
    const coord = indexToCoord()

    const info = textureLoad(texRead, coord, 0).toVar()

    // テクセル座標 → 正規化座標 (0~1)
    const uv = vec2(
      float(coord.x).div(SIM_SIZE),
      float(coord.y).div(SIM_SIZE)
    )

    // ドロップ中心との距離
    const dist = uv.sub(centerU).length().div(radiusU)

    // コサイン減衰: 半径内のみ影響
    const drop = float(1.0).sub(dist).max(0.0)
    const dropVal = float(0.5).sub(drop.mul(Math.PI).cos().mul(0.5))

    const newHeight = info.x.add(dropVal.mul(strengthU))

    textureStore(texWrite, coord, vec4(newHeight, info.y, info.z, info.w)).toWriteOnly()
  })().compute(TOTAL_THREADS, [WORKGROUP_SIZE])
}

export function createWaterSimulation() {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  // ピンポンテクスチャ
  let texA = createSimTexture()
  let texB = createSimTexture()

  // ドロップ用 uniform
  const dropCenter = uniform(vec2(0.5, 0.5))
  const dropRadius = uniform(0.03)
  const dropStrength = uniform(0.01)

  // compute ノード: A→B と B→A の2セット（ピンポン用）
  const updateAtoB = createUpdateCompute(texA, texB)
  const updateBtoA = createUpdateCompute(texB, texA)
  const normalAtoB = createNormalCompute(texA, texB)
  const normalBtoA = createNormalCompute(texB, texA)
  const dropAtoB = createDropCompute(texA, texB, dropCenter, dropRadius, dropStrength)
  const dropBtoA = createDropCompute(texB, texA, dropCenter, dropRadius, dropStrength)

  // 現在どちらが「読み取り側」かを追跡
  let phase = 0 // 0: A が最新, 1: B が最新

  // ドロップキュー
  const pendingDrops = []

  return {
    get currentTexture() {
      return phase === 0 ? texA : texB
    },

    texA,
    texB,

    init(renderer) {
      // 初期波紋を追加
      for (let i = 0; i < 15; i++) {
        const x = 0.2 + Math.random() * 0.6
        const z = 0.2 + Math.random() * 0.6
        const r = 0.02 + Math.random() * 0.04
        const s = 0.005 + Math.random() * 0.01
        this.addDrop(x, z, r, s)
      }

      // 初期ドロップを処理
      this._processPendingDrops(renderer)

      // 数ステップ回して波を広げる
      for (let i = 0; i < 20; i++) {
        this._stepSimulation(renderer)
      }
      this._computeNormals(renderer)
    },

    addDrop(x, z, radius, strength) {
      pendingDrops.push({ x, z, radius, strength })
    },

    update(renderer) {
      this._processPendingDrops(renderer)

      // 毎フレーム2回更新（安定性のため）
      this._stepSimulation(renderer)
      this._stepSimulation(renderer)

      // 法線を計算
      this._computeNormals(renderer)
    },

    _processPendingDrops(renderer) {
      while (pendingDrops.length > 0) {
        const drop = pendingDrops.shift()
        dropCenter.value.set(drop.x, drop.z)
        dropRadius.value = drop.radius
        dropStrength.value = drop.strength

        if (phase === 0) {
          renderer.compute(dropAtoB)
          phase = 1
        } else {
          renderer.compute(dropBtoA)
          phase = 0
        }
      }
    },

    _stepSimulation(renderer) {
      if (phase === 0) {
        renderer.compute(updateAtoB)
        phase = 1
      } else {
        renderer.compute(updateBtoA)
        phase = 0
      }
    },

    _computeNormals(renderer) {
      if (phase === 0) {
        renderer.compute(normalAtoB)
        phase = 1
      } else {
        renderer.compute(normalBtoA)
        phase = 0
      }
    },

    destroy() {
      updateAtoB.dispose()
      updateBtoA.dispose()
      normalAtoB.dispose()
      normalBtoA.dispose()
      dropAtoB.dispose()
      dropBtoA.dispose()
      texA.dispose()
      texB.dispose()
    },
  }
}
