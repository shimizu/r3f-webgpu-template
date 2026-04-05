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

// --- ジオメトリ ---
const SPHERE_SEGMENTS = 128

// --- マテリアル基本パラメータ ---
const MATERIAL = {
  transmission: 0.75,
  thickness: 1.8,
  roughness: 0.12,
  ior: 1.333,
  attenuationDistance: 2.5,
  attenuationColor: '#064a3e',
  clearcoat: 0.05,
  clearcoatRoughness: 0.1,
  envMapIntensity: 0.6,
}

// --- blob 形状パラメータ ---
const BLOB = {
  flattenPower: 0.35,       // 上面の平坦化度合い (0=球のまま, 1=完全に平ら)
  bottomFlatten: 0.5,       // 底面の平坦化
  edgeRound: 0.85,          // 端の丸み (0=角張る, 1=丸い)
  bulgeStrength: 0.15,      // 側面の膨らみ
  pulseSpeed: 0.3,          // 脈動の速さ
  pulseStrength: 0.02,      // 脈動の振幅
  noiseScale: 0.8,          // blob 変形ノイズのスケール
  noiseStrength: 0.08,      // blob 変形ノイズの強さ
}

// --- 波パラメータ ---
const WAVE = {
  swellAmplitude: 0.18,
  swellFreqZ: 0.6,
  swellFreqX: 0.15,
  swellSpeed: 0.55,
  crossSwellAmplitude: 0.1,
  crossSwellFreqX: 0.45,
  crossSwellFreqZ: 0.3,
  crossSwellSpeed: 0.4,
  windWaveAmplitude: 0.06,
  windWaveFreqZ: 1.8,
  windWaveFreqX: 0.6,
  windWaveSpeed: 1.4,
  flowNoiseScale: 0.25,
  flowNoiseAmplitude: 0.1,
  detailNoiseScale: 0.8,
  detailNoiseAmplitude: 0.03,
  displacementStrength: 0.7,
  normalStrengthX: 2.5,
  normalStrengthZ: 2.0,
}

// --- カラーパレット ---
const COLORS = {
  surfaceLight: '#48c9b0',
  surfaceDark: '#1a8a7a',
  surfaceGlint: '#e0f7f0',
  foam: '#e8fcf8',
  sideShallow: '#2eb8a0',
  sideDeep: '#0c5c52',
  caustic: '#5ee8c8',
  sideRipple: '#1a9080',
  reflection: '#87ceeb',
  attenuationShallow: '#0a6858',
  attenuationDeep: '#032820',
}

// --- エフェクト強度 ---
const EFFECTS = {
  causticIntensity: 0.35,
  foamThresholdMin: 0.18,
  foamThresholdMax: 0.35,
  foamStrength: 0.8,
  glintStrength: 0.35,
  fresnelPower: 2.5,
  fresnelStrength: 0.45,
}

// --- 透過度 ---
const OPACITY = {
  bodyMin: 0.75,
  bodyMax: 0.9,
  topMin: 0.35,
  topMax: 0.65,
}

// 波の高さを計算（上面用）
function createWaveHeightNode() {
  const swell = positionLocal.z
    .mul(WAVE.swellFreqZ)
    .add(positionLocal.x.mul(WAVE.swellFreqX))
    .sub(time.mul(WAVE.swellSpeed))
    .sin()
    .mul(WAVE.swellAmplitude)

  const crossSwell = positionLocal.x
    .mul(WAVE.crossSwellFreqX)
    .sub(positionLocal.z.mul(WAVE.crossSwellFreqZ))
    .add(time.mul(WAVE.crossSwellSpeed))
    .sin()
    .mul(WAVE.crossSwellAmplitude)

  const windWave = positionLocal.z
    .mul(WAVE.windWaveFreqZ)
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

// blob 形状の positionNode を構築
// 球体の頂点を変形して、上面が平坦で端が丸い水の塊にする
function createBlobPositionNode(width, height, depth) {
  const halfW = width * 0.5
  const halfH = height * 0.5
  const halfD = depth * 0.5

  // 球体のローカル座標（-1〜1 に正規化された球面上）
  const px = positionLocal.x
  const py = positionLocal.y
  const pz = positionLocal.z

  // --- 1. 楕円体にスケール ---
  // 球体を width x depth x height の楕円体に
  const scaledX = px.mul(halfW)
  const scaledY = py.mul(halfD)
  const scaledZ = pz.mul(halfH)

  // --- 2. 上面の平坦化 ---
  // Y > 0 の部分を潰して水面を平らにする
  const topRegion = smoothstep(float(0.0), float(0.6), py)
  const flattenedY = mix(scaledY, float(halfD).mul(BLOB.flattenPower), topRegion)

  // --- 3. 底面の平坦化 ---
  // Y < 0 の部分も少し平らに
  const bottomRegion = smoothstep(float(0.0), float(-0.6), py)
  const flattenedY2 = mix(flattenedY, float(-halfD).mul(BLOB.bottomFlatten), bottomRegion)

  // --- 4. 側面の膨らみ ---
  // 中間の高さで少し外側に膨らむ（水の表面張力的な感じ）
  const midRegion = py.abs().oneMinus().smoothstep(float(0.0), float(0.8))
  const bulge = midRegion.mul(BLOB.bulgeStrength)
  const bulgedX = scaledX.mul(float(1.0).add(bulge))
  const bulgedZ = scaledZ.mul(float(1.0).add(bulge))

  // --- 5. ゆっくりした脈動 ---
  const pulse = time.mul(BLOB.pulseSpeed).sin().mul(BLOB.pulseStrength)
  const pulseScale = float(1.0).add(pulse.mul(midRegion))

  // --- 6. ノイズによる有機的な変形 ---
  const blobNoise = mx_noise_float(
    vec3(
      px.mul(BLOB.noiseScale).add(time.mul(0.05)),
      py.mul(BLOB.noiseScale),
      pz.mul(BLOB.noiseScale).sub(time.mul(0.03))
    )
  ).mul(BLOB.noiseStrength)

  // 法線方向にノイズ変形（球体なので positionLocal.normalize() ≈ normalLocal）
  const noiseDisp = normalLocal.mul(blobNoise)

  // --- 7. 上面の波ディスプレースメント ---
  const waveHeight = createWaveHeightNode()
  const waveDisp = waveHeight.mul(topRegion).mul(WAVE.displacementStrength)

  // 最終位置
  const finalX = bulgedX.mul(pulseScale).add(noiseDisp.x)
  const finalY = flattenedY2.add(waveDisp).mul(pulseScale).add(noiseDisp.y)
  const finalZ = bulgedZ.mul(pulseScale).add(noiseDisp.z)

  return vec3(finalX, finalY, finalZ)
}

function createWaterBlobMaterial(environmentMap, { width, height, depth }) {
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

  const halfD = depth * 0.5

  // positionNode で blob 形状に変形
  material.positionNode = createBlobPositionNode(width, height, depth)

  // --- マスク類 ---
  // topMask: 球体の上半分（Y > 0）= 水面
  const topMask = smoothstep(float(0.0), float(0.5), positionLocal.y)
  // depthTint: 深さによる色の変化
  const depthTint = smoothstep(float(-1.0), float(1.0), positionLocal.y)
  // edgeFade: XZ 平面上の端
  const edgeDistance = length(vec2(positionLocal.x, positionLocal.z))
  const edgeFade = smoothstep(float(0.9), float(0.6), edgeDistance)
  // sideMask: 側面（法線 Y が小さい = 側面）
  const sideMask = normalLocal.y.abs().oneMinus().pow(2)

  // --- 波の高さ（エフェクト計算用）---
  const waveHeight = createWaveHeightNode()
  const waveShade = smoothstep(float(-0.1), float(0.1), waveHeight)

  // --- きらめき ---
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

  // --- コースティクス ---
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
  const causticPattern = causticA.mul(causticB).smoothstep(float(0.2), float(0.75))
  const causticDepthMask = depthTint.oneMinus().smoothstep(float(0.1), float(0.6))
  const causticIntensity = causticPattern.mul(causticDepthMask).mul(EFFECTS.causticIntensity)

  // --- 泡 ---
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

  // --- 側面の波紋 ---
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

  // --- カラー合成 ---
  const surfaceColor = mix(color(COLORS.surfaceLight), color(COLORS.surfaceDark), waveShade.mul(0.7))
  const topColor = mix(surfaceColor, color(COLORS.surfaceGlint), topGlint.mul(EFFECTS.glintStrength))
  const topWithFoam = mix(topColor, color(COLORS.foam), foam.mul(EFFECTS.foamStrength))

  const sideColor = mix(color(COLORS.sideDeep), color(COLORS.sideShallow), depthTint.mul(0.8))
  const sideWithCaustic = mix(sideColor, color(COLORS.caustic), causticIntensity)
  const sideWithRipple = mix(sideWithCaustic, color(COLORS.sideRipple), sideRipple.mul(0.06))

  const finalColor = mix(sideWithRipple, topWithFoam, topMask.mul(0.9))

  // --- フレネル ---
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

  // --- 透過度 ---
  const bodyOpacity = mix(float(OPACITY.bodyMin), float(OPACITY.bodyMax), sideMask.mul(0.9))
  const topOpacity = mix(float(OPACITY.topMin), float(OPACITY.topMax), fresnel)
  const finalOpacity = mix(topOpacity, bodyOpacity, sideMask.mul(0.8).add(topMask.oneMinus().mul(0.6)))

  material.colorNode = reflectiveColor
  material.normalNode = normalLocal.add(
    vec3(
      waveHeight.mul(topMask).mul(WAVE.normalStrengthX),
      float(1),
      waveHeight.mul(topMask).mul(WAVE.normalStrengthZ)
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

function WaterBlobLayer({
  width = 20,
  height = 8,
  depth = 2.5,
  position = [0, 0, 0],
}) {
  return (
    <CubeCamera frames={1} resolution={256} position={position}>
      {(environmentMap) => (
        <WaterBlobMesh
          environmentMap={environmentMap}
          width={width}
          height={height}
          depth={depth}
          position={position}
        />
      )}
    </CubeCamera>
  )
}

function WaterBlobMesh({ environmentMap, width, height, depth, position }) {
  const blobMaterial = useMemo(
    () => createWaterBlobMaterial(environmentMap, { width, height, depth }),
    [environmentMap, width, height, depth]
  )

  useEffect(() => {
    return () => {
      blobMaterial.dispose()
    }
  }, [blobMaterial])

  // position.y を水面（上面）の位置にするため、blob の上面分だけ下げる
  // CubeCamera が position を適用済みなので、ここでは Y オフセットのみ
  const topOffset = depth * 0.5 * BLOB.flattenPower
  return (
    <mesh castShadow receiveShadow position={[0, -topOffset, 0]}>
      <sphereGeometry args={[1, SPHERE_SEGMENTS, SPHERE_SEGMENTS]} />
      <primitive object={blobMaterial} attach='material' />
    </mesh>
  )
}

export default WaterBlobLayer
