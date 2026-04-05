import { useEffect, useMemo, useRef } from 'react'
import { useLoader } from '@react-three/fiber'
import { TextureLoader, RepeatWrapping, PlaneGeometry, Vector3, FrontSide } from 'three'
import { WaterMesh } from 'three/addons/objects/WaterMesh.js'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  color,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  smoothstep,
  time,
  vec3,
} from 'three/tsl'

// --- 水面設定 ---
const WATER_CONFIG = {
  waterColor: 0x001e0f,
  sunColor: 0xffffff,
  sunDirection: new Vector3(0.70707, 0.70707, 0.0),
  distortionScale: 3.7,
  size: 1.0,
  alpha: 1.0,
  resolutionScale: 0.5,
}

// --- 側面マテリアル設定 ---
const SIDE_MATERIAL = {
  transmission: 0.4,
  thickness: 2.0,
  roughness: 0.15,
  ior: 1.333,
  attenuationDistance: 1.5,
  attenuationColor: '#064a3e',
}

const SIDE_COLORS = {
  shallow: '#48c9b0',
  deep: '#0c5c52',
  caustic: '#5ee8c8',
  ripple: '#1a9080',
}

// --- 側面の水中マテリアル ---
function createUnderwaterMaterial() {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: SIDE_MATERIAL.transmission,
    thickness: SIDE_MATERIAL.thickness,
    roughness: SIDE_MATERIAL.roughness,
    metalness: 0,
    ior: SIDE_MATERIAL.ior,
    attenuationDistance: SIDE_MATERIAL.attenuationDistance,
    attenuationColor: SIDE_MATERIAL.attenuationColor,
    side: FrontSide,
    depthWrite: true,
  })

  // 深度グラデーション: ワールド Y で上=浅い色、下=深い色
  const depthFactor = smoothstep(float(-2.0), float(0.0), positionWorld.y)
  const baseColor = mix(
    color(SIDE_COLORS.deep),
    color(SIDE_COLORS.shallow),
    depthFactor
  )

  // コースティクス: 水中の集光パターン
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
  const causticPattern = causticA.mul(causticB)
    .smoothstep(float(0.2), float(0.75))
  const causticMask = depthFactor.oneMinus().smoothstep(float(0.1), float(0.6))
  const causticIntensity = causticPattern.mul(causticMask).mul(0.3)

  // 波紋バンド: 横縞のゆらぎアニメーション
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(0.35, 0.35, 0.5))
      .add(vec3(time.mul(0.12), time.mul(-0.08), 0))
  ).mul(0.5)
  const sideBands = positionWorld.y
    .mul(2.2)
    .add(positionWorld.z.mul(0.5))
    .sub(time.mul(0.9))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(0.08)

  // カラー合成
  const withCaustic = mix(baseColor, color(SIDE_COLORS.caustic), causticIntensity)
  const withRipple = mix(withCaustic, color(SIDE_COLORS.ripple), sideRipple)
  material.colorNode = withRipple

  // 透過度: 上ほど透明、下ほど不透明
  material.opacityNode = mix(float(0.92), float(0.6), depthFactor)

  return material
}

// --- 側面・底面パネル ---
function WaterSides({ width, height, depth }) {
  const material = useMemo(() => createUnderwaterMaterial(), [])

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  const halfW = width / 2
  const halfH = height / 2
  const y = -depth / 2

  return (
    <group>
      {/* 前面 (Z+) */}
      <mesh position={[0, y, halfH]} material={material}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      {/* 背面 (Z-) */}
      <mesh position={[0, y, -halfH]} rotation={[0, Math.PI, 0]} material={material}>
        <planeGeometry args={[width, depth]} />
      </mesh>
      {/* 右面 (X+) */}
      <mesh position={[halfW, y, 0]} rotation={[0, -Math.PI / 2, 0]} material={material}>
        <planeGeometry args={[height, depth]} />
      </mesh>
      {/* 左面 (X-) */}
      <mesh position={[-halfW, y, 0]} rotation={[0, Math.PI / 2, 0]} material={material}>
        <planeGeometry args={[height, depth]} />
      </mesh>
      {/* 底面 */}
      <mesh position={[0, -depth, 0]} rotation={[Math.PI / 2, 0, 0]} material={material}>
        <planeGeometry args={[width, height]} />
      </mesh>
    </group>
  )
}

// --- WaterMesh (上面) ---
function WaterSurface({ waterNormals, width, height, position, rotation }) {
  const waterRef = useRef()

  useEffect(() => {
    if (!waterRef.current) return

    const geometry = new PlaneGeometry(width, height)
    const water = new WaterMesh(geometry, {
      waterNormals,
      sunDirection: WATER_CONFIG.sunDirection,
      sunColor: WATER_CONFIG.sunColor,
      waterColor: WATER_CONFIG.waterColor,
      distortionScale: WATER_CONFIG.distortionScale,
      size: WATER_CONFIG.size,
      alpha: WATER_CONFIG.alpha,
      resolutionScale: WATER_CONFIG.resolutionScale,
    })

    water.position.set(...position)
    water.rotation.set(...rotation)

    const parent = waterRef.current
    parent.add(water)

    return () => {
      parent.remove(water)
      geometry.dispose()
      water.material.dispose()
    }
  }, [waterNormals, width, height, position, rotation])

  return <group ref={waterRef} />
}

function WaterOceanLayer({
  width = 200,
  height = 200,
  depth = 2,
  position = [0, 0, 0],
  rotation = [-Math.PI / 2, 0, 0],
}) {
  const waterNormals = useLoader(TextureLoader, '/textures/waternormals.jpg')

  useEffect(() => {
    waterNormals.wrapS = RepeatWrapping
    waterNormals.wrapT = RepeatWrapping
  }, [waterNormals])

  return (
    <group position={position}>
      <WaterSurface
        waterNormals={waterNormals}
        width={width}
        height={height}
        position={[0, 0, 0]}
        rotation={rotation}
      />
      <WaterSides width={width} height={height} depth={depth} />
    </group>
  )
}

export default WaterOceanLayer
