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

function createWaterBoxMaterial(waterNormalsTexture) {
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
    envMapIntensity: MATERIAL.envMapIntensity,
  })

  const waterNormals = texture(waterNormalsTexture)

  // --- 面の判定 ---
  // normalLocal.y ≈ 1 → 上面、≈ 0 → 側面、≈ -1 → 底面
  const topMask = smoothstep(float(0.5), float(0.9), normalLocal.y)
  const sideMask = normalLocal.y.abs().oneMinus().smoothstep(float(0.0), float(0.5))

  // --- 上面: ノーマルマップスクロールによる波 ---
  const uvCoord = uv()
  const scale = EFFECTS.normalMapScale
  const speed = EFFECTS.normalMapSpeed

  // 4方向にスクロールするノーマルマップを合成
  const uv0 = uvCoord.mul(scale).add(vec2(time.mul(speed), time.mul(speed * 0.7)))
  const uv1 = uvCoord.mul(scale * 1.1).sub(vec2(time.mul(speed * 0.8), time.mul(speed * -0.6)))
  const uv2 = uvCoord.mul(scale * 0.5).add(vec2(time.mul(speed * 0.4), time.mul(speed * 1.2)))
  const uv3 = uvCoord.mul(scale * 0.7).sub(vec2(time.mul(speed * -0.5), time.mul(speed * 0.9)))

  const n0 = waterNormals.sample(uv0)
  const n1 = waterNormals.sample(uv1)
  const n2 = waterNormals.sample(uv2)
  const n3 = waterNormals.sample(uv3)

  // 4サンプルを合成 → [-1, 1] に変換
  const combinedNormal = n0.add(n1).add(n2).add(n3).mul(0.25).mul(2.0).sub(1.0)
  const surfaceNormal = vec3(
    combinedNormal.x.mul(EFFECTS.normalStrength),
    float(1.0),
    combinedNormal.y.mul(EFFECTS.normalStrength)
  ).normalize()

  // 側面は元の法線をそのまま使う
  material.normalNode = mix(normalLocal, surfaceNormal, topMask)

  // --- 深度グラデーション ---
  const depthFactor = smoothstep(float(-0.5), float(0.5), positionLocal.y)

  // --- 上面カラー ---
  const waveShade = combinedNormal.x.mul(0.5).add(0.5)
  const surfaceColor = mix(
    color(COLORS.surfaceDark),
    color(COLORS.surfaceLight),
    waveShade
  )

  // --- 側面カラー: 深度グラデ + コースティクス + 波紋 ---
  const sideBase = mix(
    color(COLORS.sideDeep),
    color(COLORS.sideShallow),
    depthFactor.mul(0.8)
  )

  // コースティクス
  const causticA = mx_noise_float(
    vec3(
      positionWorld.x.mul(1.5).add(time.mul(0.15)),
      positionWorld.y.mul(1.3).sub(time.mul(0.12)),
      positionWorld.z.mul(1.2)
    )
  ).sin().abs()
  const causticB = mx_noise_float(
    vec3(
      positionWorld.x.mul(-1.2).add(time.mul(0.1)),
      positionWorld.y.mul(1.8).add(time.mul(0.14)),
      positionWorld.z.mul(0.9)
    )
  ).sin().abs()
  const causticPattern = causticA.mul(causticB).smoothstep(float(0.2), float(0.75))
  const causticDepthMask = depthFactor.oneMinus().smoothstep(float(0.1), float(0.6))
  const causticColor = mix(
    sideBase,
    color(COLORS.caustic),
    causticPattern.mul(causticDepthMask).mul(EFFECTS.causticIntensity)
  )

  // 波紋バンド
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(0.35, 0.35, 0.5))
      .add(vec3(time.mul(0.12), time.mul(-0.08), 0))
  ).mul(0.5)
  const sideBands = positionWorld.y
    .mul(2.2)
    .add(positionWorld.z.mul(0.5))
    .sub(time.mul(EFFECTS.waveSpeed))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(0.06)
  const sideColor = mix(causticColor, color(COLORS.ripple), sideRipple)

  // 上面と側面を合成
  material.colorNode = mix(sideColor, surfaceColor, topMask)

  // --- フレネル反射（上面のみ）---
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld.dot(viewDir).abs().oneMinus().pow(EFFECTS.fresnelPower)
  const reflectivity = fresnel.mul(EFFECTS.fresnelStrength).mul(topMask)
  material.colorNode = mix(material.colorNode, color(COLORS.reflection), reflectivity)

  // --- 透過度 ---
  const topOpacity = mix(float(0.5), float(0.75), fresnel)
  const sideOpacity = mix(float(0.92), float(0.65), depthFactor)
  material.opacityNode = mix(sideOpacity, topOpacity, topMask)

  // --- 光吸収カラー ---
  material.attenuationColorNode = mix(
    color(COLORS.attenuationDeep),
    color(COLORS.attenuationShallow),
    depthFactor.mul(0.9)
  )

  return material
}

function WaterOceanLayer({
  width = 200,
  height = 200,
  depth = 2,
  position = [0, 0, 0],
}) {
  const waterNormals = useLoader(TextureLoader, '/textures/waternormals.jpg')

  useEffect(() => {
    waterNormals.wrapS = RepeatWrapping
    waterNormals.wrapT = RepeatWrapping
  }, [waterNormals])

  const material = useMemo(
    () => createWaterBoxMaterial(waterNormals),
    [waterNormals]
  )

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  return (
    <group position={position}>
      <mesh
        castShadow
        receiveShadow
        scale={[width / 2, depth, height / 2]}
      >
        <boxGeometry args={[2, 1, 2, 1, 1, 1]} />
        <primitive object={material} attach='material' />
      </mesh>
    </group>
  )
}

export default WaterOceanLayer
