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

const FLOW = {
  timeX: 0.12,
  timeZ: 0.08,
  scaleZRatio: 0.8,
  detailTimeX: 0.18,
  detailTimeZ: 0.14,
  detailScaleZRatio: 0.75,
}

const SIDE = {
  noiseScale: [0.35, 0.35, 0.5],
  noiseTimeX: 0.12,
  noiseTimeY: -0.08,
  bandFreqY: 2.2,
  bandFreqZ: 0.5,
  bandSpeed: 0.9,
  pow: 3,
  rippleMix: 0.06,
}

const GLINT = {
  noiseScaleX: 0.4,
  noiseScaleZ: 0.35,
  noiseTimeX: 0.14,
  noiseTimeZ: 0.1,
  bandAFreqX: 2.8,
  bandAFreqZ: 2.0,
  bandASpeed: 2.0,
  bandANoiseAmp: 4,
  bandBFreqX: -1.8,
  bandBFreqZ: 2.5,
  bandBSpeed: 1.5,
  bandBWaveAmp: 5,
  smoothMin: 0.3,
  smoothMax: 0.8,
  reflectAdd: 0.15,
}

const CAUSTIC = {
  aScaleX: 1.5,
  aScaleZ: 1.3,
  aTimeX: 0.15,
  aTimeZ: 0.12,
  bScaleX: -1.2,
  bScaleZ: 1.8,
  bTimeX: 0.1,
  bTimeZ: 0.14,
  smoothMin: 0.2,
  smoothMax: 0.75,
  depthMin: 0.1,
  depthMax: 0.6,
}

const FOAM = {
  noiseScaleX: 3.0,
  noiseScaleZ: 2.8,
  noiseTimeX: 0.35,
  noiseTimeZ: 0.3,
}

const SURFACE = {
  edgeSmoothMin: 0.78,
  edgeSmoothMax: 1.0,
  waveShadeSmoothMin: -0.1,
  waveShadeSmoothMax: 0.1,
  waveShadeColorMix: 0.7,
  depthTintMix: 0.8,
  topMaskMix: 0.9,
  attenuationMix: 0.9,
  bodyOpacitySideMix: 0.9,
  topOpacitySideMix: 0.8,
  topOpacityTopMix: 0.6,
}

const CUBECAMERA_RESOLUTION = 256

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
      positionLocal.x.mul(WAVE.flowNoiseScale).add(time.mul(FLOW.timeX)),
      positionLocal.z.mul(WAVE.flowNoiseScale * FLOW.scaleZRatio).sub(time.mul(FLOW.timeZ)),
      0
    )
  ).mul(WAVE.flowNoiseAmplitude)

  const detailNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(WAVE.detailNoiseScale).add(time.mul(FLOW.detailTimeX)),
      positionLocal.z.mul(WAVE.detailNoiseScale * FLOW.detailScaleZRatio).sub(time.mul(FLOW.detailTimeZ)),
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
  const edgeFade = smoothstep(float(SURFACE.edgeSmoothMin), float(SURFACE.edgeSmoothMax), edgeDistance).oneMinus()

  const sideMask = normalLocal.y.abs().oneMinus().pow(SIDE.pow)
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(...SIDE.noiseScale)).add(vec3(time.mul(SIDE.noiseTimeX), time.mul(SIDE.noiseTimeY), 0))
  ).mul(0.5)
  const sideBands = positionLocal.y
    .mul(SIDE.bandFreqY)
    .add(positionLocal.z.mul(SIDE.bandFreqZ))
    .sub(time.mul(SIDE.bandSpeed))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(sideMask)

  const topDisplacement = waveHeight.mul(topMask).mul(edgeFade).mul(WAVE.displacementStrength)

  const waveShade = smoothstep(float(SURFACE.waveShadeSmoothMin), float(SURFACE.waveShadeSmoothMax), waveHeight)

  const glintNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(GLINT.noiseScaleX).add(time.mul(GLINT.noiseTimeX)),
      positionLocal.z.mul(GLINT.noiseScaleZ).sub(time.mul(GLINT.noiseTimeZ)),
      0
    )
  )
  const glintBandsA = positionLocal.x
    .mul(GLINT.bandAFreqX)
    .add(positionLocal.z.mul(GLINT.bandAFreqZ))
    .sub(time.mul(GLINT.bandASpeed))
    .add(glintNoise.mul(GLINT.bandANoiseAmp))
    .sin()
    .abs()
  const glintBandsB = positionLocal.x
    .mul(GLINT.bandBFreqX)
    .add(positionLocal.z.mul(GLINT.bandBFreqZ))
    .add(time.mul(GLINT.bandBSpeed))
    .add(waveHeight.mul(GLINT.bandBWaveAmp))
    .sin()
    .abs()
  const topGlint = glintBandsA
    .mul(glintBandsB)
    .smoothstep(float(GLINT.smoothMin), float(GLINT.smoothMax))
    .mul(topMask)
    .mul(edgeFade)

  // フェイクコースティクス
  const causticA = mx_noise_float(
    vec3(
      positionLocal.x.mul(CAUSTIC.aScaleX).add(time.mul(CAUSTIC.aTimeX)),
      positionLocal.z.mul(CAUSTIC.aScaleZ).sub(time.mul(CAUSTIC.aTimeZ)),
      0
    )
  ).sin().abs()
  const causticB = mx_noise_float(
    vec3(
      positionLocal.x.mul(CAUSTIC.bScaleX).add(time.mul(CAUSTIC.bTimeX)),
      positionLocal.z.mul(CAUSTIC.bScaleZ).add(time.mul(CAUSTIC.bTimeZ)),
      0
    )
  ).sin().abs()
  const causticPattern = causticA.mul(causticB)
    .smoothstep(float(CAUSTIC.smoothMin), float(CAUSTIC.smoothMax))
  const causticDepthMask = depthTint.oneMinus().smoothstep(float(CAUSTIC.depthMin), float(CAUSTIC.depthMax))
  const causticIntensity = causticPattern.mul(causticDepthMask).mul(EFFECTS.causticIntensity)

  // ホワイトウォーター
  const foamThreshold = waveHeight.smoothstep(
    float(EFFECTS.foamThresholdMin),
    float(EFFECTS.foamThresholdMax)
  )
  const foamNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(FOAM.noiseScaleX).add(time.mul(FOAM.noiseTimeX)),
      positionLocal.z.mul(FOAM.noiseScaleZ).sub(time.mul(FOAM.noiseTimeZ)),
      0
    )
  ).mul(0.5).add(0.5)
  const foam = foamThreshold.mul(foamNoise).mul(topMask).mul(edgeFade)

  // 水面カラー
  const surfaceColor = mix(color(COLORS.surfaceLight), color(COLORS.surfaceDark), waveShade.mul(SURFACE.waveShadeColorMix))
  const topColor = mix(surfaceColor, color(COLORS.surfaceGlint), topGlint.mul(EFFECTS.glintStrength))
  const topWithFoam = mix(topColor, color(COLORS.foam), foam.mul(EFFECTS.foamStrength))

  // 側面カラー
  const sideColor = mix(color(COLORS.sideDeep), color(COLORS.sideShallow), depthTint.mul(SURFACE.depthTintMix))
  const sideWithCaustic = mix(sideColor, color(COLORS.caustic), causticIntensity)
  const sideWithRipple = mix(sideWithCaustic, color(COLORS.sideRipple), sideRipple.mul(SIDE.rippleMix))

  const finalColor = mix(sideWithRipple, topWithFoam, topMask.mul(SURFACE.topMaskMix))

  // フレネル
  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(EFFECTS.fresnelPower)
  const topReflectivity = fresnel
    .mul(EFFECTS.fresnelStrength)
    .add(topGlint.mul(GLINT.reflectAdd))
    .mul(topMask)
  const reflectiveColor = mix(finalColor, color(COLORS.reflection), topReflectivity)

  // 透過度
  const bodyOpacity = mix(float(OPACITY.bodyMin), float(OPACITY.bodyMax), sideMask.mul(SURFACE.bodyOpacitySideMix))
  const topOpacity = mix(float(OPACITY.topMin), float(OPACITY.topMax), fresnel)
  const finalOpacity = mix(topOpacity, bodyOpacity, sideMask.mul(SURFACE.topOpacitySideMix).add(topMask.oneMinus().mul(SURFACE.topOpacityTopMix)))

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
    depthTint.mul(SURFACE.attenuationMix)
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
    <CubeCamera frames={1} resolution={CUBECAMERA_RESOLUTION} position={position}>
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
    <mesh castShadow receiveShadow position={[0, -depth / 2, 0]}>
      <boxGeometry args={[width, depth, height, ...segments]} />
      <primitive object={bodyMaterial} attach='material' />
    </mesh>
  )
}

export default WaterBoxLayer
