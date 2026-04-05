import { useMemo } from 'react'
import { BackSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  color,
  float,
  mix,
  mx_noise_float,
  normalLocal,
  smoothstep,
  time,
  vec3,
} from 'three/tsl'

// --- 空のグラデーション（室内・卓上） ---
const SKY_COLORS = {
  zenith: '#c8c0b8',       // 天井の暖かいベージュ
  horizon: '#a09890',      // 壁面のくすんだベージュ
  ground: '#706860',       // 床面の暗いブラウン
}

// --- 雲パラメータ（室内なので控えめなテクスチャ感） ---
const CLOUD = {
  coverage: 0.3,           // 雲量を下げて天井のムラ程度に
  sharpness: 0.1,          // ぼんやり
  baseScale: 1.2,          // 大きなムラ
  detailScale: 2.0,        // 細部
  speed: 0.005,            // ほぼ動かない
  brightness: 0.85,        // 明るめ
  shadowStrength: 0.1,     // 陰影は控えめ
  color: '#d8d0c8',        // 天井色に近い暖色
  shadowColor: '#a09888',  // 薄い影
}

// --- ドーム設定 ---
const DOME = {
  radius: 200,
  segments: 32,
}

function createSkyMaterial() {
  const material = new MeshBasicNodeMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
  })

  // Y-up シーン: normalLocal.y で高度を取得
  // BackSide なので法線は内向き、y がそのまま上方向
  const altitude = normalLocal.y

  // 空のグラデーション: 天頂→地平線→地面
  // altitude は -1(真下) ~ 0(水平) ~ +1(真上)
  const skyGradient = mix(
    color(SKY_COLORS.horizon),
    color(SKY_COLORS.zenith),
    smoothstep(float(-0.1), float(0.8), altitude)
  )
  const fullGradient = mix(
    color(SKY_COLORS.ground),
    skyGradient,
    smoothstep(float(-0.3), float(0.0), altitude)
  )

  // 雲: fBM ノイズで生成
  // Y-up シーン: 球面上の XZ 座標をノイズ入力に使用
  const cloudUV = vec3(
    normalLocal.x.mul(CLOUD.baseScale),
    normalLocal.z.mul(CLOUD.baseScale),
    0
  )
  const cloudUVAnimated = cloudUV.add(vec3(time.mul(CLOUD.speed), time.mul(CLOUD.speed * 0.3), 0))

  // 大きな雲の形状
  const baseNoise = mx_noise_float(cloudUVAnimated).mul(0.5).add(0.5)
  // 細部ディテール
  const detailNoise = mx_noise_float(
    cloudUVAnimated.mul(CLOUD.detailScale).add(vec3(time.mul(CLOUD.speed * 1.5), 0, 0))
  ).mul(0.5).add(0.5)
  // fBM 合成
  const cloudDensity = baseNoise.mul(0.7).add(detailNoise.mul(0.3))

  // coverage と sharpness で雲の範囲を制御
  const cloudMask = cloudDensity
    .sub(float(1.0 - CLOUD.coverage))
    .div(float(CLOUD.sharpness))
    .clamp(0, 1)

  // 雲は地平線より上のみ表示
  const cloudAltitudeMask = smoothstep(float(0.0), float(0.2), altitude)
  // 天頂付近は雲を薄く
  const cloudZenithFade = smoothstep(float(0.85), float(0.7), altitude)
  const finalCloudMask = cloudMask.mul(cloudAltitudeMask).mul(cloudZenithFade)

  // 雲の陰影: ノイズの勾配で疑似ライティング
  const cloudShadow = baseNoise.smoothstep(
    float(0.4),
    float(0.7)
  ).oneMinus().mul(CLOUD.shadowStrength)

  const cloudColor = mix(
    color(CLOUD.shadowColor),
    color(CLOUD.color),
    float(CLOUD.brightness).sub(cloudShadow)
  )

  // 空 + 雲を合成
  material.colorNode = mix(fullGradient, cloudColor, finalCloudMask)

  return material
}

function SkyLayer({ radius = DOME.radius }) {
  const skyMaterial = useMemo(() => createSkyMaterial(), [])

  return (
    <mesh>
      <sphereGeometry args={[radius, DOME.segments, DOME.segments]} />
      <primitive object={skyMaterial} attach='material' />
    </mesh>
  )
}

export default SkyLayer
