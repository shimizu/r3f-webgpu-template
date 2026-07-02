import { useEffect, useMemo } from 'react'
import { BackSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  color,
  dot,
  exp,
  float,
  hash,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalize,
  positionGeometry,
  screenCoordinate,
  smoothstep,
  time,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

/*
  TSL raymarching による体積雲レイヤー。

  単位ボックス (-0.5..0.5) を mesh の scale で [width, thickness, depth] に
  引き伸ばし、フラグメントシェーダ内で AABB 交差 → 固定ステップの raymarch を行う。
  密度は「weather 場 → coverage remap → 垂直プロファイル → base shape → detail 侵食」
  の順で組織化し、サンプルごとに太陽方向へ短い光学深度マーチを行って
  Beer 減衰 + powder + Henyey-Greenstein 位相でライティングする。

  Coordinate（GIS 投影）とは無関係のワールド座標レイヤー。
  制限: シーン深度クランプを持たないため、不透明物がボックス内部に
  食い込む配置では貫通して見える（雲は地形より上に置くこと）。
*/

// ============================================================
// 調整用パラメータ
// ============================================================

// --- 太陽と空（LightingRig の directionalLight position [-20,12,0] と
//     SkyLayer の SKY_COLORS に揃えた共有定数） ---
const SUN_LEN = Math.hypot(-20, 12, 0)
const SUN = {
  direction: [-20 / SUN_LEN, 12 / SUN_LEN, 0 / SUN_LEN], // 正規化済み（雲 → 太陽向き）
  color: '#fff4e6',
}
const AMBIENT = {
  zenith: '#c8c0b8',   // SkyLayer SKY_COLORS.zenith
  horizon: '#a09890',  // SkyLayer SKY_COLORS.horizon
}

// --- march 制御 ---
const MARCH = {
  transmittanceMin: 0.015, // 透過率がここを下回ったら早期終了
  densityEps: 0.01,        // ライティング計算をスキップする密度下限
  alphaEps: 1e-4,          // 前割り解除時のゼロ除算ガード
  edgeFadeStart: 0.38,     // ボックス XZ 端フェード開始（|local| がこの値まで密度1）
  edgeFadeEnd: 0.5,        //   〃 終了（壁でスパッと切れるのを防ぐ）
}

// --- 雲種プリセット ---
// weatherScale: XZ の周波数（cirrus は X を落として繊維状に引き伸ばす）
// profile: 垂直プロファイル smoothstep(b0,b1,h) × (1 - smoothstep(t0,t1,h))
// detailStyle: 'billow'（worley 反転 = もこもこ侵食）/ 'wispy'（worley そのまま = 糸状の切れ目）
// wind*: 3 つのノイズ場を別速度で流す（再生成ではなくオフセット移動 = 沸騰防止）
// extinction / lightStepWorld はワールド距離基準 [1/unit], [unit]
const CLOUD_TYPES = {
  cumulus: {
    weatherScale: [0.28, 0.28],
    weatherOctaves: 3,
    coverageSoftness: 0.28,
    coverageBias: 0,
    profile: { b0: 0, b1: 0.1, t0: 0.45, t1: 1.05 },
    towerByWeather: 0.5,
    shapeScale: [0.5, 0.5, 0.5],
    shapeAmount: 0.42,
    detailScale: 1.8,
    detailAmount: 0.4,
    detailStyle: 'billow',
    extinction: 3.0,
    phaseG: 0.45,
    sunEnergy: 2.2,
    ambientStrength: 0.55,
    powderScale: 4.0,
    windWeather: [0.012, 0.006],
    windShape: [0.02, 0.01],
    windDetail: [0.05, -0.025],
    shear: 0,
    lightSteps: 4,
    lightStepWorld: 0.35,
  },
  stratus: {
    weatherScale: [0.16, 0.16],
    weatherOctaves: 2,
    coverageSoftness: 0.45,
    coverageBias: 0.1,
    profile: { b0: 0.05, b1: 0.3, t0: 0.6, t1: 0.95 },
    towerByWeather: 0,
    shapeScale: [0.35, 0.5, 0.35],
    shapeAmount: 0.28,
    detailScale: 1.2,
    detailAmount: 0.2,
    detailStyle: 'billow',
    extinction: 1.6,
    phaseG: 0.3,
    sunEnergy: 1.8,
    ambientStrength: 0.65,
    powderScale: 2.0,
    windWeather: [0.006, 0.003],
    windShape: [0.01, 0.005],
    windDetail: [0.024, -0.012],
    shear: 0,
    lightSteps: 3,
    lightStepWorld: 0.3,
  },
  cirrus: {
    weatherScale: [0.06, 0.35],
    weatherOctaves: 3,
    coverageSoftness: 0.22,
    coverageBias: -0.05,
    profile: { b0: 0.25, b1: 0.5, t0: 0.55, t1: 0.85 },
    towerByWeather: 0,
    shapeScale: [0.12, 0.5, 0.7],
    shapeAmount: 0.18,
    detailScale: 2.5,
    detailAmount: 0.3,
    detailStyle: 'wispy',
    extinction: 0.9,
    phaseG: 0.6,
    sunEnergy: 2.6,
    ambientStrength: 0.5,
    powderScale: 0.5,
    windWeather: [0.04, 0.004],
    windShape: [0.055, 0.006],
    windDetail: [0.09, -0.01],
    shear: 0.6,
    lightSteps: 3,
    lightStepWorld: 0.25,
  },
}

// --- コンポーネント既定値 ---
// steps は raymarch のサンプル数（GPU コスト直結）。重い場合は 32 まで下げる
const CLOUD_DEFAULTS = {
  width: 24,
  depth: 15,
  thickness: 2.5,
  coverage: 0.45,
  type: 'cumulus',
  steps: 48,
}
// inline 配列を避けるためのモジュール定数（useMemo は使わないが慣例に合わせる）
const DEFAULT_POSITION = [0, 6, 0]

// ============================================================
// ヘルパー
// ============================================================

// 単位ボックス (-0.5..0.5) とレイの交差区間 [t0, t1] を返す
// （three/examples/jsm/tsl/utils/Raymarching.js の hitBox と同一）
const hitBox = /*@__PURE__*/ Fn(({ orig, dir }) => {
  const boxMin = vec3(-0.5)
  const boxMax = vec3(0.5)

  const invDir = dir.reciprocal()

  const tminTmp = boxMin.sub(orig).mul(invDir)
  const tmaxTmp = boxMax.sub(orig).mul(invDir)

  const tmin = min(tminTmp, tmaxTmp)
  const tmax = max(tminTmp, tmaxTmp)

  const t0 = max(tmin.x, max(tmin.y, tmin.z))
  const t1 = min(tmax.x, min(tmax.y, tmax.z))

  return vec2(t0, t1)
})

// x を [low, high] → [0, 1] へ再マップして clamp（雲密度の侵食に使う）
const remapClamped = /*@__PURE__*/ Fn(([x, low, high]) => {
  return clamp(x.sub(low).div(max(high.sub(low), 1e-4)), 0, 1)
})

// Henyey-Greenstein 位相関数。g は JS 数値なので係数を前計算する
function hgPhase(cosTheta, g) {
  const g2 = g * g
  return float((1 - g2) / (4 * Math.PI))
    .div(cosTheta.mul(-2 * g).add(1 + g2).pow(1.5))
}

// ============================================================
// 密度関数ファクトリ
// ============================================================

// preset と coverage から密度サンプラ Fn(([localPos]) => 0..1) を構築する。
// ノイズ座標はワールド空間（scale による歪みなし・複数マウントで位相が変わる）。
// ライトマーチはボックス外の localPos も渡すが、プロファイルと端フェードで自然に 0 になる
function createSampleDensity(preset, coverage) {
  // coverage は「remap の閾値シフト」として効かせる（最終密度への乗算ではない）。
  // coverage が大きい → threshold が下がる → weather のより広い領域が雲化する
  const covered = Math.min(Math.max(coverage + preset.coverageBias, 0), 1)
  const threshold = 1 - covered
  let upper = Math.min(threshold + preset.coverageSoftness, 1)
  if (upper - threshold < 1e-4) upper = threshold + 1e-4

  return Fn(([localPos]) => {
    const worldP = modelWorldMatrix.mul(vec4(localPos, 1)).xyz
    const h = clamp(localPos.y.add(0.5), 0, 1) // 層内の高さ割合 0..1

    // --- ボックス XZ 端フェード ---
    const edge = smoothstep(MARCH.edgeFadeStart, MARCH.edgeFadeEnd, localPos.x.abs()).oneMinus()
      .mul(smoothstep(MARCH.edgeFadeStart, MARCH.edgeFadeEnd, localPos.z.abs()).oneMinus())

    // --- cirrus: 高さシアで筋を斜めに流す ---
    const px = preset.shear !== 0 ? worldP.x.add(h.mul(preset.shear)) : worldP.x

    // --- 1) weather 場（2D, XZ）---
    // mx_fractal_noise はオクターブ合成で ±1 を超えうるので正規化後に clamp 必須
    const weatherP = vec3(
      px.mul(preset.weatherScale[0]).add(time.mul(preset.windWeather[0])),
      worldP.z.mul(preset.weatherScale[1]).add(time.mul(preset.windWeather[1])),
      0
    )
    const weather = clamp(
      mx_fractal_noise_float(weatherP, preset.weatherOctaves).mul(0.5).add(0.5), 0, 1
    )

    // --- 2) coverage remap ---
    const base = smoothstep(threshold, upper, weather)

    // --- 3) 垂直プロファイル ---
    // 減少側の smoothstep(edge0 > edge1) は仕様未定義なので必ず oneMinus 形で書く
    const { b0, b1, t0, t1 } = preset.profile
    let profile = smoothstep(b0, b1, h).mul(smoothstep(t0, t1, h).oneMinus())
    if (preset.towerByWeather > 0) {
      // weather の強い場所ほど雲頂が高い（塔状に育つ）
      const hTop = mix(float(1 - preset.towerByWeather), float(1), weather)
      profile = profile.mul(smoothstep(hTop.mul(0.6), hTop, h).oneMinus())
    }
    const shaped = base.mul(profile).mul(edge)

    // --- 4) base shape（3D fBM）で侵食 ---
    const shapeP = vec3(
      px.mul(preset.shapeScale[0]).add(time.mul(preset.windShape[0])),
      worldP.y.mul(preset.shapeScale[1]),
      worldP.z.mul(preset.shapeScale[2]).add(time.mul(preset.windShape[1]))
    )
    const shape = clamp(mx_fractal_noise_float(shapeP, 3).mul(0.5).add(0.5), 0, 1)
    const eroded = remapClamped(shaped, shape.oneMinus().mul(preset.shapeAmount), float(1))

    // --- 5) detail 侵食（加算ではなく削り。高さ依存で挙動を切替） ---
    // mx_worley_noise は距離ベース（0 = 特徴点中心）なので billow では反転して使う
    const detailP = vec3(
      px.mul(preset.detailScale).add(time.mul(preset.windDetail[0])),
      worldP.y.mul(preset.detailScale),
      worldP.z.mul(preset.detailScale).add(time.mul(preset.windDetail[1]))
    )
    const worley = clamp(mx_worley_noise_float(detailP), 0, 1)
    const detail = preset.detailStyle === 'wispy' ? worley : worley.oneMinus()
    // 上部: pow でふわふわ / 下部: 反転で削れる（whippy）
    const modifier = mix(detail.oneMinus(), detail.pow(4), smoothstep(0.2, 0.4, h))
      .mul(preset.detailAmount)

    return remapClamped(eroded, modifier, float(1))
  })
}

// ============================================================
// マテリアルファクトリ
// ============================================================

function createCloudMaterial({ type, coverage, steps }) {
  const preset = CLOUD_TYPES[type] ?? CLOUD_TYPES[CLOUD_DEFAULTS.type]
  const sampleDensity = createSampleDensity(preset, coverage)

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    side: BackSide, // カメラがボックス内に入っても描けるように内面を描画
    depthWrite: false,
    fog: false,
  })

  const marched = Fn(() => {
    // --- レイ設定（ボックスローカル空間） ---
    const vOrigin = varying(vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1))))
    const vDirection = varying(positionGeometry.sub(vOrigin))
    const rayDir = vDirection.normalize().toVar()

    const bounds = vec2(hitBox({ orig: vOrigin, dir: rayDir })).toVar()
    bounds.x.greaterThan(bounds.y).discard()
    bounds.assign(vec2(max(bounds.x, 0), bounds.y)) // camera-inside 対応

    const stepLocal = bounds.y.sub(bounds.x).div(steps).toVar()

    // 開始点ジッターでスライス状バンディングを散らす。
    // テンポラル再構成を持たないので time は混ぜない（混ぜるとシマーになる）
    const jitter = hash(screenCoordinate.x.add(screenCoordinate.y.mul(913.719)))
    const pos = vOrigin.add(rayDir.mul(bounds.x.add(stepLocal.mul(jitter)))).toVar()
    const stepVec = rayDir.mul(stepLocal).toVar()

    // --- ローカル↔ワールドの光学距離換算 ---
    // scale が非等方（width ≠ thickness ≠ depth）でも Beer 減衰が
    // ワールド距離基準になるよう、1 step の実距離を求める
    const stepWorld = modelWorldMatrix.mul(vec4(stepVec, 0)).xyz.length().toVar()

    // 太陽方向をローカルへ逆変換し、ライトステップがワールドで
    // lightStepWorld の長さになるようスケールする
    const sunWorld = vec3(SUN.direction[0], SUN.direction[1], SUN.direction[2])
    const sunLocal = normalize(modelWorldMatrixInverse.mul(vec4(sunWorld, 0)).xyz).toVar()
    const sunWorldPerLocal = modelWorldMatrix.mul(vec4(sunLocal, 0)).xyz.length()
    const lightStepVec = sunLocal.mul(float(preset.lightStepWorld).div(sunWorldPerLocal)).toVar()

    // --- 位相・アンビエント（ループ不変） ---
    const rayDirWorld = normalize(modelWorldMatrix.mul(vec4(rayDir, 0)).xyz)
    const phase = hgPhase(dot(rayDirWorld, sunWorld), preset.phaseG).toVar()
    const sunRadiance = color(SUN.color).mul(preset.sunEnergy)

    // --- front-to-back のエネルギー保存積分 ---
    const accumT = float(1).toVar()   // 透過率
    const accumC = vec3(0).toVar()    // 前割り済み放射輝度

    Loop(steps, () => {
      const d = sampleDensity(pos).toVar()

      If(d.greaterThan(MARCH.densityEps), () => {
        // 太陽方向への短い光学深度マーチ（lightSteps は JS 数値なので展開。
        // sampleDensity は Fn なのでシェーダ関数呼び出しになりコード爆発しない）
        const opticalDepth = float(0).toVar()
        for (let j = 1; j <= preset.lightSteps; j += 1) {
          opticalDepth.addAssign(sampleDensity(pos.add(lightStepVec.mul(j))))
        }
        const lightT = exp(opticalDepth.mul(-(preset.extinction * preset.lightStepWorld)))
        // powder: 薄い縁で散乱が立ち上がる近似 1 - exp(-2ρ)
        const powder = exp(d.mul(-2 * preset.powderScale)).oneMinus()

        const ambient = mix(
          color(AMBIENT.horizon),
          color(AMBIENT.zenith),
          clamp(pos.y.add(0.5), 0, 1)
        ).mul(preset.ambientStrength)
        const radiance = sunRadiance.mul(lightT).mul(powder).mul(phase).add(ambient)

        const stepT = exp(d.mul(-preset.extinction).mul(stepWorld))
        accumC.addAssign(radiance.mul(accumT).mul(stepT.oneMinus()))
        accumT.mulAssign(stepT)
      })

      pos.addAssign(stepVec)

      If(accumT.lessThan(MARCH.transmittanceMin), () => {
        Break()
      })
    })

    // 前割りを解除して通常の α ブレンドへ渡す
    const alpha = accumT.oneMinus()
    return vec4(accumC.div(max(alpha, MARCH.alphaEps)), alpha)
  })()

  material.colorNode = marched.rgb
  material.opacityNode = marched.a

  return material
}

// ============================================================
// コンポーネント
// ============================================================

/**
 * 体積雲レイヤー。
 *
 * @param {number} width - XZ 範囲の幅（ワールド単位）
 * @param {number} depth - XZ 範囲の奥行
 * @param {number} thickness - 雲層の厚み（Y）
 * @param {number} coverage - 雲量 0..1（remap 閾値シフト: 面積が変わる）
 * @param {string} type - 'cumulus' | 'stratus' | 'cirrus'
 * @param {number} steps - raymarch サンプル数（重い場合は 32 へ）
 * @param {Array} position - 雲ボックス中心のワールド座標
 */
function CloudLayer({
  width = CLOUD_DEFAULTS.width,
  depth = CLOUD_DEFAULTS.depth,
  thickness = CLOUD_DEFAULTS.thickness,
  coverage = CLOUD_DEFAULTS.coverage,
  type = CLOUD_DEFAULTS.type,
  steps = CLOUD_DEFAULTS.steps,
  position = DEFAULT_POSITION,
}) {
  // 位置・寸法は modelWorldMatrix が吸収するので material 依存はシェーダ定数のみ
  const material = useMemo(
    () => createCloudMaterial({ type, coverage, steps }),
    [type, coverage, steps]
  )

  useEffect(() => () => material.dispose(), [material])

  return (
    // renderOrder: 透明の距離ソートは大きな箱では不安定なので、
    // 海面（WaterOceanLayer）より後に描くことを明示する
    <mesh position={position} scale={[width, thickness, depth]} renderOrder={10}>
      <boxGeometry args={[1, 1, 1]} />
      <primitive object={material} attach='material' />
    </mesh>
  )
}

export default CloudLayer
