import { useEffect, useMemo } from 'react'
import { Html } from '@react-three/drei'
import { DoubleSide } from 'three'
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
  time,
  vec3,
} from 'three/tsl'
import { FLOOR_HEIGHT, FLOOR_WIDTH } from './stageDimensions'

const LABEL_STYLE = {
  color: '#f3f1ec',
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

const WATER_BOX_WIDTH = FLOOR_WIDTH
const WATER_BOX_HEIGHT = FLOOR_HEIGHT
const WATER_BOX_DEPTH = 1.1
const WATER_BOX_TOP_OFFSET = 0.04
const WATER_BOX_CENTER = [0, 0, WATER_BOX_TOP_OFFSET + WATER_BOX_DEPTH * 0.5]
const WATER_SURFACE_Z = WATER_BOX_TOP_OFFSET + WATER_BOX_DEPTH
const WATER_SURFACE_SEGMENTS_X = 160
const WATER_SURFACE_SEGMENTS_Y = 96

function createWaveHeightNode() {
  const flowNoise = mx_noise_float(
    positionWorld.mul(vec3(0.09, 0.12, 0.03)).add(vec3(time.mul(0.18), time.mul(-0.04), 0))
  ).mul(0.22)
  const secondaryNoise = mx_noise_float(
    positionWorld.mul(vec3(0.16, 0.1, 0.04)).add(vec3(time.mul(-0.12), time.mul(0.16), 0))
  ).mul(0.14)
  const warpNoise = mx_noise_float(
    positionWorld.mul(vec3(0.04, 0.05, 0.02)).add(vec3(time.mul(0.08), time.mul(-0.03), 0))
  ).mul(2.1)

  const longWave = positionWorld.y
    .mul(0.52)
    .add(positionWorld.x.mul(0.14))
    .add(warpNoise)
    .sub(time.mul(0.68))
    .sin()
    .mul(0.18)

  const diagonalWave = positionWorld.x
    .mul(0.28)
    .sub(positionWorld.y.mul(0.21))
    .add(warpNoise.mul(0.75))
    .add(time.mul(0.44))
    .sin()
    .mul(0.11)

  return flowNoise.add(secondaryNoise).add(longWave).add(diagonalWave).mul(0.55)
}

function createWaterBodyMaterial() {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: 0.99,
    thickness: 3,
    roughness: 0.05,
    metalness: 0,
    ior: 1.333,
    attenuationDistance: 4,
    attenuationColor: '#41bfff',
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    side: DoubleSide,
    depthWrite: false,
  })

  const depthTint = smoothstep(
    float(-WATER_BOX_DEPTH * 0.5),
    float(WATER_BOX_DEPTH * 0.5),
    positionLocal.z
  )
  const bodyColor = mix(color('#dffcff'), color('#1f9ce3'), depthTint)
  const deepColor = mix(bodyColor, color('#0b5ba5'), depthTint.mul(0.82))

  material.colorNode = deepColor
  material.opacityNode = float(0.72)
  material.attenuationColorNode = mix(color('#b7fbff'), color('#148bd5'), depthTint)

  return material
}

function createWaterSurfaceMaterial() {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: 0.98,
    thickness: 0.8,
    roughness: 0.035,
    metalness: 0,
    ior: 1.333,
    attenuationDistance: 2.4,
    attenuationColor: '#63d7ff',
    clearcoat: 1,
    clearcoatRoughness: 0.015,
    side: DoubleSide,
    depthWrite: false,
  })

  const waveHeight = createWaveHeightNode()
  const depthTint = smoothstep(float(-0.2), float(0.2), waveHeight)
  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(2.35)

  const waterColor = mix(color('#65d6ff'), color('#0e67b5'), depthTint.add(0.28))
  const surfaceColor = mix(waterColor, color('#f6feff'), fresnel.mul(0.74))

  material.positionNode = positionLocal.add(vec3(0, 0, waveHeight))
  material.colorNode = surfaceColor
  material.normalNode = normalLocal.add(
    vec3(
      waveHeight.mul(1.6),
      waveHeight.mul(1.2),
      float(1)
    )
  ).normalize()
  material.opacityNode = fresnel.mul(0.12).add(0.82)

  return material
}

function WaterBoxLayer() {
  const bodyMaterial = useMemo(() => createWaterBodyMaterial(), [])
  const surfaceMaterial = useMemo(() => createWaterSurfaceMaterial(), [])

  useEffect(() => {
    return () => {
      bodyMaterial.dispose()
      surfaceMaterial.dispose()
    }
  }, [bodyMaterial, surfaceMaterial])

  return (
    <group>
      <mesh castShadow receiveShadow position={WATER_BOX_CENTER}>
        <boxGeometry args={[WATER_BOX_WIDTH, WATER_BOX_HEIGHT, WATER_BOX_DEPTH]} />
        <primitive object={bodyMaterial} attach='material' />
      </mesh>

      <mesh position={[0, 0, WATER_SURFACE_Z]} rotation={[0, 0, 0]}>
        <planeGeometry
          args={[
            WATER_BOX_WIDTH,
            WATER_BOX_HEIGHT,
            WATER_SURFACE_SEGMENTS_X,
            WATER_SURFACE_SEGMENTS_Y,
          ]}
        />
        <primitive object={surfaceMaterial} attach='material' />
      </mesh>

      <Html
        position={[0, -(WATER_BOX_HEIGHT * 0.5) - 1.2, 0.42]}
        center
        transform
        distanceFactor={12}
      >
        <div style={LABEL_STYLE}>Water</div>
      </Html>
    </group>
  )
}

export default WaterBoxLayer
