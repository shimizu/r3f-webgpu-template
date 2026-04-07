import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import { TextureLoader, RepeatWrapping, FrontSide } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  cameraPosition,
  color,
  float,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  texture,
  time,
  uv,
  vec2,
  vec3,
} from 'three/tsl'

// --- マテリアル基本パラメータ ---
const MATERIAL = {
  transmission: 0.5,
  thickness: 2.0,
  roughness: 0.1,
  ior: 1.333,
  attenuationDistance: 2.0,
  attenuationColor: '#064a3e',
  clearcoat: 0.08,
  clearcoatRoughness: 0.08,
  envMapIntensity: 0.5,
}

// --- カラー ---
const COLORS = {
  surfaceLight: '#48c9b0',
  surfaceDark: '#1a8a7a',
  sideShallow: '#2eb8a0',
  sideDeep: '#0c5c52',
  caustic: '#5ee8c8',
  ripple: '#1a9080',
  reflection: '#87ceeb',
  attenuationShallow: '#0a6858',
  attenuationDeep: '#032820',
}

// --- エフェクト ---
const EFFECTS = {
  normalMapScale: 0.8,
  normalMapSpeed: 0.03,
  normalStrength: 1.5,
  causticIntensity: 0.3,
  fresnelPower: 2.5,
  fresnelStrength: 0.4,
  waveSpeed: 0.9,
}

const UV_SCROLL = {
  scaleRatios: [1.0, 1.1, 0.5, 0.7],
  speedRatios: [1.0, 0.7, 0.8, -0.6, 0.4, 1.2, -0.5, 0.9],
}

const NORMAL_COMBINE = {
  sampleWeight: 0.25,
  range: 2.0,
  offset: 1.0,
}

const CAUSTIC = {
  aScaleX: 1.5,
  aScaleY: 1.3,
  aScaleZ: 1.2,
  aTimeX: 0.15,
  aTimeY: 0.12,
  bScaleX: -1.2,
  bScaleY: 1.8,
  bScaleZ: 0.9,
  bTimeX: 0.1,
  bTimeY: 0.14,
  smoothMin: 0.2,
  smoothMax: 0.75,
  depthMin: 0.1,
  depthMax: 0.6,
}

const SIDE = {
  noiseScale: [0.35, 0.35, 0.5],
  noiseTimeX: 0.12,
  noiseTimeY: -0.08,
  bandFreqY: 2.2,
  bandFreqZ: 0.5,
  rippleMix: 0.06,
}

const SURFACE = {
  topMaskMin: 0.5,
  topMaskMax: 0.9,
  sideMaskMin: 0.0,
  sideMaskMax: 0.5,
  depthMin: -0.5,
  depthMax: 0.5,
  depthTintMix: 0.8,
  attenuationMix: 0.9,
  waveShadeScale: 0.5,
  waveShadeOffset: 0.5,
}

const OCEAN_OPACITY = {
  topMin: 0.5,
  topMax: 0.75,
  sideMin: 0.92,
  sideMax: 0.65,
}

const BOX_GEOMETRY_ARGS = [2, 1, 2, 1, 1, 1]

function createWaterBoxMaterial(waterNormalsTexture, opacity) {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: MATERIAL.transmission * opacity,
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
    envMapIntensity: MATERIAL.envMapIntensity,
  })

  const waterNormals = texture(waterNormalsTexture)

  // --- 面の判定 ---
  // normalLocal.y ≈ 1 → 上面、≈ 0 → 側面、≈ -1 → 底面
  const topMask = smoothstep(float(SURFACE.topMaskMin), float(SURFACE.topMaskMax), normalLocal.y)
  const sideMask = normalLocal.y.abs().oneMinus().smoothstep(float(SURFACE.sideMaskMin), float(SURFACE.sideMaskMax))

  // --- 上面: ノーマルマップスクロールによる波 ---
  const uvCoord = uv()
  const scale = EFFECTS.normalMapScale
  const speed = EFFECTS.normalMapSpeed

  // 4方向にスクロールするノーマルマップを合成
  const uv0 = uvCoord.mul(scale).add(vec2(time.mul(speed), time.mul(speed * UV_SCROLL.speedRatios[1])))
  const uv1 = uvCoord.mul(scale * UV_SCROLL.scaleRatios[1]).sub(vec2(time.mul(speed * UV_SCROLL.speedRatios[2]), time.mul(speed * UV_SCROLL.speedRatios[3])))
  const uv2 = uvCoord.mul(scale * UV_SCROLL.scaleRatios[2]).add(vec2(time.mul(speed * UV_SCROLL.speedRatios[4]), time.mul(speed * UV_SCROLL.speedRatios[5])))
  const uv3 = uvCoord.mul(scale * UV_SCROLL.scaleRatios[3]).sub(vec2(time.mul(speed * UV_SCROLL.speedRatios[6]), time.mul(speed * UV_SCROLL.speedRatios[7])))

  const n0 = waterNormals.sample(uv0)
  const n1 = waterNormals.sample(uv1)
  const n2 = waterNormals.sample(uv2)
  const n3 = waterNormals.sample(uv3)

  // 4サンプルを合成 → [-1, 1] に変換
  const combinedNormal = n0.add(n1).add(n2).add(n3).mul(NORMAL_COMBINE.sampleWeight).mul(NORMAL_COMBINE.range).sub(NORMAL_COMBINE.offset)
  const surfaceNormal = vec3(
    combinedNormal.x.mul(EFFECTS.normalStrength),
    float(1.0),
    combinedNormal.y.mul(EFFECTS.normalStrength)
  ).normalize()

  // 側面は元の法線をそのまま使う
  material.normalNode = mix(normalLocal, surfaceNormal, topMask)

  // --- 深度グラデーション ---
  const depthFactor = smoothstep(float(SURFACE.depthMin), float(SURFACE.depthMax), positionLocal.y)

  // --- 上面カラー ---
  const waveShade = combinedNormal.x.mul(SURFACE.waveShadeScale).add(SURFACE.waveShadeOffset)
  const surfaceColor = mix(
    color(COLORS.surfaceDark),
    color(COLORS.surfaceLight),
    waveShade
  )

  // --- 側面カラー: 深度グラデ + コースティクス + 波紋 ---
  const sideBase = mix(
    color(COLORS.sideDeep),
    color(COLORS.sideShallow),
    depthFactor.mul(SURFACE.depthTintMix)
  )

  // コースティクス
  const causticA = mx_noise_float(
    vec3(
      positionWorld.x.mul(CAUSTIC.aScaleX).add(time.mul(CAUSTIC.aTimeX)),
      positionWorld.y.mul(CAUSTIC.aScaleY).sub(time.mul(CAUSTIC.aTimeY)),
      positionWorld.z.mul(CAUSTIC.aScaleZ)
    )
  ).sin().abs()
  const causticB = mx_noise_float(
    vec3(
      positionWorld.x.mul(CAUSTIC.bScaleX).add(time.mul(CAUSTIC.bTimeX)),
      positionWorld.y.mul(CAUSTIC.bScaleY).add(time.mul(CAUSTIC.bTimeY)),
      positionWorld.z.mul(CAUSTIC.bScaleZ)
    )
  ).sin().abs()
  const causticPattern = causticA.mul(causticB).smoothstep(float(CAUSTIC.smoothMin), float(CAUSTIC.smoothMax))
  const causticDepthMask = depthFactor.oneMinus().smoothstep(float(CAUSTIC.depthMin), float(CAUSTIC.depthMax))
  const causticColor = mix(
    sideBase,
    color(COLORS.caustic),
    causticPattern.mul(causticDepthMask).mul(EFFECTS.causticIntensity)
  )

  // 波紋バンド
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(SIDE.noiseScale[0], SIDE.noiseScale[1], SIDE.noiseScale[2]))
      .add(vec3(time.mul(SIDE.noiseTimeX), time.mul(SIDE.noiseTimeY), 0))
  ).mul(0.5)
  const sideBands = positionWorld.y
    .mul(SIDE.bandFreqY)
    .add(positionWorld.z.mul(SIDE.bandFreqZ))
    .sub(time.mul(EFFECTS.waveSpeed))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(SIDE.rippleMix)
  const sideColor = mix(causticColor, color(COLORS.ripple), sideRipple)

  // 上面と側面を合成
  material.colorNode = mix(sideColor, surfaceColor, topMask)

  // --- フレネル反射（上面のみ）---
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld.dot(viewDir).abs().oneMinus().pow(EFFECTS.fresnelPower)
  const reflectivity = fresnel.mul(EFFECTS.fresnelStrength).mul(topMask)
  material.colorNode = mix(material.colorNode, color(COLORS.reflection), reflectivity)

  // --- 透過度 ---
  const topOpacity = mix(float(OCEAN_OPACITY.topMin), float(OCEAN_OPACITY.topMax), fresnel)
  const sideOpacity = mix(float(OCEAN_OPACITY.sideMin), float(OCEAN_OPACITY.sideMax), depthFactor)
  material.opacityNode = mix(sideOpacity, topOpacity, topMask).mul(float(opacity))

  // --- 光吸収カラー ---
  material.attenuationColorNode = mix(
    color(COLORS.attenuationDeep),
    color(COLORS.attenuationShallow),
    depthFactor.mul(SURFACE.attenuationMix)
  )

  return material
}

function WaterOceanLayer({
  width = 200,
  height = 200,
  depth = 2,
  opacity = 1.0,
  position = [0, 0, 0],
}) {
  const waterNormals = useLoader(TextureLoader, './textures/waternormals.jpg')

  useEffect(() => {
    waterNormals.wrapS = RepeatWrapping
    waterNormals.wrapT = RepeatWrapping
  }, [waterNormals])

  const material = useMemo(
    () => createWaterBoxMaterial(waterNormals, opacity),
    [waterNormals, opacity]
  )

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  return (
    <group position={position}>
      <mesh
        castShadow
        receiveShadow
        position={[0, -depth / 2, 0]}
        scale={[width / 2, depth, height / 2]}
      >
        <boxGeometry args={BOX_GEOMETRY_ARGS} />
        <primitive object={material} attach='material' />
      </mesh>
    </group>
  )
}

export default WaterOceanLayer
