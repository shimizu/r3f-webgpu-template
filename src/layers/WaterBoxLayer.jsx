import { useEffect, useMemo } from 'react'
import { CubeCamera } from '@react-three/drei'
import { FrontSide } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  cameraPosition,
  color,
  float,
  length,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  time,
  vec2,
  vec3,
} from 'three/tsl'

// --- ジオメトリデフォルト ---
// [X, Y, Z] 各軸の分割数。大きいほど波の解像度が上がるがGPU負荷も増える
const DEFAULT_SEGMENTS = [64, 16, 64]

// --- マテリアル基本パラメータ ---
const MATERIAL = {
  transmission: 0.75,       // 光の透過率。夏の透き通った海
  thickness: 1.8,           // 透過計算上の仮想厚み。薄めで明るい水中に
  roughness: 0.12,          // 表面の粗さ。夏の穏やかな海面
  ior: 1.333,               // 屈折率。水の物理値
  attenuationDistance: 2.5,  // 光が吸収される距離。長めで明るい浅瀬感
  attenuationColor: '#064a3e', // 吸収後に残る色。エメラルドグリーン寄り
  clearcoat: 0.05,          // クリアコート層の強さ。水面の薄い光沢膜
  clearcoatRoughness: 0.1,  // クリアコートの粗さ
  envMapIntensity: 0.6,     // 環境マップの反射強度。空の映り込み控えめ
}

// --- 波パラメータ ---
const WAVE = {
  // うねり (swell): 遠洋から来るゆっくりした大きな波
  swellAmplitude: 0.28,     // うねりの高さ
  swellFreqY: 0.6,          // Y方向の波長 (小さい=長い波)
  swellFreqX: 0.15,         // X方向の波長成分 (斜め方向を作る)
  swellSpeed: 0.55,         // うねりの進行速度
  // 交差うねり: メインうねりと交差する波
  crossSwellAmplitude: 0.15,
  crossSwellFreqX: 0.45,
  crossSwellFreqY: 0.3,
  crossSwellSpeed: 0.4,
  // 風波 (wind wave): 風で直接起きる中程度の波
  windWaveAmplitude: 0.1,
  windWaveFreqY: 1.8,       // うねりより短い波長
  windWaveFreqX: 0.6,
  windWaveSpeed: 1.4,       // うねりより速い
  // さざなみ: Perlinノイズによる細かい表面の揺らぎ
  flowNoiseScale: 0.25,     // ノイズのスケール (小さい=大きな模様)
  flowNoiseAmplitude: 0.15, // さざなみの高さ
  detailNoiseScale: 0.8,    // 細部ノイズのスケール
  detailNoiseAmplitude: 0.05, // 細部の高さ (控えめ)
  // ディスプレースメントと法線
  displacementStrength: 0.9, // 頂点変位の全体スケール
  normalStrengthX: 3.0,     // 法線摂動のX成分強度。光の反射パターンに影響
  normalStrengthY: 2.5,     // 法線摂動のY成分強度
}

// --- カラーパレット ---
const COLORS = {
  surfaceLight: '#48c9b0',   // 水面の明るい部分 (波の山)。鮮やかなターコイズ
  surfaceDark: '#1a8a7a',    // 水面の暗い部分 (波の谷)。深めのエメラルド
  surfaceGlint: '#e0f7f0',   // 水面のきらめき色。白に近い淡緑
  foam: '#e8fcf8',           // 波頭の泡の色。白い泡
  sideShallow: '#2eb8a0',    // 側面の浅い部分。明るいターコイズ
  sideDeep: '#0c5c52',       // 側面の深い部分。濃いエメラルド
  caustic: '#5ee8c8',        // コースティクス (水中の集光) の色。明るい緑
  sideRipple: '#1a9080',     // 側面の波紋色
  reflection: '#87ceeb',     // フレネル反射色。夏の空の青
  attenuationShallow: '#0a6858', // 光吸収色 (浅部)
  attenuationDeep: '#032820',    // 光吸収色 (深部)
}

// --- エフェクト強度 ---
const EFFECTS = {
  causticIntensity: 0.35,    // コースティクスの明るさ。夏の強い陽光
  foamThresholdMin: 0.18,    // 泡が出始める波高の下限。少し早めに泡立つ
  foamThresholdMax: 0.35,    // 泡が最大になる波高の上限
  foamStrength: 0.8,         // 泡の不透明度。白い波頭を強調
  glintStrength: 0.35,       // 水面きらめきの強さ。夏の陽光の反射
  fresnelPower: 2.5,         // フレネル指数。やや緩やかに
  fresnelStrength: 0.45,     // フレネル反射の最大強度。控えめに空を映す
}

// --- 透過度 ---
const OPACITY = {
  bodyMin: 0.75,  // 側面の最小不透明度
  bodyMax: 0.9,   // 側面の最大不透明度
  topMin: 0.35,   // 上面の最小不透明度 (正面から見た時)。透き通った海面
  topMax: 0.65,   // 上面の最大不透明度 (斜めから見た時、フレネル連動)
}

function createWaveHeightNode() {
  const swell = positionLocal.z
    .mul(WAVE.swellFreqY)
    .add(positionLocal.x.mul(WAVE.swellFreqX))
    .sub(time.mul(WAVE.swellSpeed))
    .sin()
    .mul(WAVE.swellAmplitude)

  const crossSwell = positionLocal.x
    .mul(WAVE.crossSwellFreqX)
    .sub(positionLocal.z.mul(WAVE.crossSwellFreqY))
    .add(time.mul(WAVE.crossSwellSpeed))
    .sin()
    .mul(WAVE.crossSwellAmplitude)

  const windWave = positionLocal.z
    .mul(WAVE.windWaveFreqY)
    .add(positionLocal.x.mul(WAVE.windWaveFreqX))
    .sub(time.mul(WAVE.windWaveSpeed))
    .sin()
    .mul(WAVE.windWaveAmplitude)

  const flowNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(WAVE.flowNoiseScale).add(time.mul(0.12)),
      positionLocal.z.mul(WAVE.flowNoiseScale * 0.8).sub(time.mul(0.08)),
      0
    )
  ).mul(WAVE.flowNoiseAmplitude)

  const detailNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(WAVE.detailNoiseScale).add(time.mul(0.18)),
      positionLocal.z.mul(WAVE.detailNoiseScale * 0.75).sub(time.mul(0.14)),
      0
    )
  ).mul(WAVE.detailNoiseAmplitude)

  return swell.add(crossSwell).add(windWave).add(flowNoise).add(detailNoise)
}

function createWaterBodyMaterial(environmentMap, { width, height, depth }) {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: MATERIAL.transmission,
    thickness: MATERIAL.thickness,
    roughness: MATERIAL.roughness,
    metalness: 0,
    ior: MATERIAL.ior,
    attenuationDistance: MATERIAL.attenuationDistance,
    attenuationColor: MATERIAL.attenuationColor,
    clearcoat: MATERIAL.clearcoat,
    clearcoatRoughness: MATERIAL.clearcoatRoughness,
    side: FrontSide,
    depthWrite: true,
    envMap: environmentMap,
    envMapIntensity: MATERIAL.envMapIntensity,
  })

  const waveHeight = createWaveHeightNode()

  const depthTint = smoothstep(
    float(-depth * 0.5),
    float(depth * 0.5),
    positionLocal.y
  )
  const topMask = smoothstep(
    float(depth * 0.1),
    float(depth * 0.5),
    positionLocal.y
  )
  const edgeDistance = length(
    vec2(
      positionLocal.x.div(float(width * 0.5)),
      positionLocal.z.div(float(height * 0.5))
    )
  )
  const edgeFade = smoothstep(float(0.78), float(1.0), edgeDistance).oneMinus()

  const sideMask = normalLocal.y.abs().oneMinus().pow(3)
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(0.35, 0.35, 0.5)).add(vec3(time.mul(0.12), time.mul(-0.08), 0))
  ).mul(0.5)
  const sideBands = positionLocal.y
    .mul(2.2)
    .add(positionLocal.z.mul(0.5))
    .sub(time.mul(0.9))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(sideMask)

  const topDisplacement = waveHeight.mul(topMask).mul(edgeFade).mul(WAVE.displacementStrength)

  const waveShade = smoothstep(float(-0.1), float(0.1), waveHeight)

  const glintNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(0.4).add(time.mul(0.14)),
      positionLocal.z.mul(0.35).sub(time.mul(0.1)),
      0
    )
  )
  const glintBandsA = positionLocal.x
    .mul(2.8)
    .add(positionLocal.z.mul(2.0))
    .sub(time.mul(2.0))
    .add(glintNoise.mul(4))
    .sin()
    .abs()
  const glintBandsB = positionLocal.x
    .mul(-1.8)
    .add(positionLocal.z.mul(2.5))
    .add(time.mul(1.5))
    .add(waveHeight.mul(5))
    .sin()
    .abs()
  const topGlint = glintBandsA
    .mul(glintBandsB)
    .smoothstep(float(0.3), float(0.8))
    .mul(topMask)
    .mul(edgeFade)

  // フェイクコースティクス
  const causticA = mx_noise_float(
    vec3(
      positionLocal.x.mul(1.5).add(time.mul(0.15)),
      positionLocal.z.mul(1.3).sub(time.mul(0.12)),
      0
    )
  ).sin().abs()
  const causticB = mx_noise_float(
    vec3(
      positionLocal.x.mul(-1.2).add(time.mul(0.1)),
      positionLocal.z.mul(1.8).add(time.mul(0.14)),
      0
    )
  ).sin().abs()
  const causticPattern = causticA.mul(causticB)
    .smoothstep(float(0.2), float(0.75))
  const causticDepthMask = depthTint.oneMinus().smoothstep(float(0.1), float(0.6))
  const causticIntensity = causticPattern.mul(causticDepthMask).mul(EFFECTS.causticIntensity)

  // ホワイトウォーター
  const foamThreshold = waveHeight.smoothstep(
    float(EFFECTS.foamThresholdMin),
    float(EFFECTS.foamThresholdMax)
  )
  const foamNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(3.0).add(time.mul(0.35)),
      positionLocal.z.mul(2.8).sub(time.mul(0.3)),
      0
    )
  ).mul(0.5).add(0.5)
  const foam = foamThreshold.mul(foamNoise).mul(topMask).mul(edgeFade)

  // 水面カラー
  const surfaceColor = mix(color(COLORS.surfaceLight), color(COLORS.surfaceDark), waveShade.mul(0.7))
  const topColor = mix(surfaceColor, color(COLORS.surfaceGlint), topGlint.mul(EFFECTS.glintStrength))
  const topWithFoam = mix(topColor, color(COLORS.foam), foam.mul(EFFECTS.foamStrength))

  // 側面カラー
  const sideColor = mix(color(COLORS.sideDeep), color(COLORS.sideShallow), depthTint.mul(0.8))
  const sideWithCaustic = mix(sideColor, color(COLORS.caustic), causticIntensity)
  const sideWithRipple = mix(sideWithCaustic, color(COLORS.sideRipple), sideRipple.mul(0.06))

  const finalColor = mix(sideWithRipple, topWithFoam, topMask.mul(0.9))

  // フレネル
  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(EFFECTS.fresnelPower)
  const topReflectivity = fresnel
    .mul(EFFECTS.fresnelStrength)
    .add(topGlint.mul(0.15))
    .mul(topMask)
  const reflectiveColor = mix(finalColor, color(COLORS.reflection), topReflectivity)

  // 透過度
  const bodyOpacity = mix(float(OPACITY.bodyMin), float(OPACITY.bodyMax), sideMask.mul(0.9))
  const topOpacity = mix(float(OPACITY.topMin), float(OPACITY.topMax), fresnel)
  const finalOpacity = mix(topOpacity, bodyOpacity, sideMask.mul(0.8).add(topMask.oneMinus().mul(0.6)))

  material.positionNode = positionLocal.add(vec3(0, topDisplacement, 0))
  material.colorNode = reflectiveColor
  material.normalNode = normalLocal.add(
    vec3(
      topDisplacement.mul(WAVE.normalStrengthX),
      float(1),
      topDisplacement.mul(WAVE.normalStrengthY)
    )
  ).normalize()
  material.opacityNode = finalOpacity
  material.attenuationColorNode = mix(
    color(COLORS.attenuationShallow),
    color(COLORS.attenuationDeep),
    depthTint.mul(0.9)
  )

  return material
}

function WaterBoxLayer({
  width = 6,
  height = 6,
  depth = 1.5,
  position = [0, 0, 0],
  segments = DEFAULT_SEGMENTS,
}) {
  return (
    <CubeCamera frames={1} resolution={256} position={position}>
      {(environmentMap) => (
        <WaterBoxMesh
          environmentMap={environmentMap}
          width={width}
          height={height}
          depth={depth}
          position={position}
          segments={segments}
        />
      )}
    </CubeCamera>
  )
}

function WaterBoxMesh({ environmentMap, width, height, depth, position, segments }) {
  const bodyMaterial = useMemo(
    () => createWaterBodyMaterial(environmentMap, { width, height, depth }),
    [environmentMap, width, height, depth]
  )

  useEffect(() => {
    return () => {
      bodyMaterial.dispose()
    }
  }, [bodyMaterial])

  return (
    <mesh castShadow receiveShadow position={position}>
      <boxGeometry args={[width, depth, height, ...segments]} />
      <primitive object={bodyMaterial} attach='material' />
    </mesh>
  )
}

export default WaterBoxLayer
