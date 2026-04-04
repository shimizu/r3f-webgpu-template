import { useEffect, useMemo } from 'react'
import { CubeCamera, Html } from '@react-three/drei'
import { DoubleSide } from 'three'
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

function createWaterMaterial() {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: 0.99,
    thickness: 3,
    roughness: 0.045,
    metalness: 0,
    ior: 1.333,
    attenuationDistance: 3.8,
    attenuationColor: '#41bfff',
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.35,
    side: DoubleSide,
    depthWrite: false,
  })

  const flowNoise = mx_noise_float(
    positionWorld.mul(vec3(0.72, 0.9, 0.62)).add(vec3(time.mul(0.22), time.mul(-0.08), 0))
  ).mul(0.11)
  const secondaryNoise = mx_noise_float(
    positionWorld.mul(vec3(1.5, 1.15, 1.1)).add(vec3(time.mul(-0.16), time.mul(0.21), 0))
  ).mul(0.06)
  const warpNoise = mx_noise_float(
    positionWorld.mul(vec3(0.34, 0.48, 0.25)).add(vec3(time.mul(0.09), time.mul(-0.05), 0))
  ).mul(1.8)
  const longWave = positionWorld.y
    .mul(0.6)
    .add(positionWorld.x.mul(0.18))
    .add(warpNoise)
    .sub(time.mul(0.72))
    .sin()
    .mul(0.02)
  const diagonalWave = positionWorld.x
    .mul(0.32)
    .sub(positionWorld.y.mul(0.24))
    .add(warpNoise.mul(0.7))
    .add(time.mul(0.54))
    .sin()
    .mul(0.012)
  const surfaceRipple = flowNoise.mul(0.8).add(secondaryNoise.mul(0.7)).add(longWave).add(diagonalWave)

  const edgeDistance = length(
    vec2(
      positionLocal.x.div(float(WATER_BOX_WIDTH * 0.5)),
      positionLocal.y.div(float(WATER_BOX_HEIGHT * 0.5))
    )
  )
  const edgeFactor = smoothstep(float(0.28), float(1.0), edgeDistance)

  const depthTint = smoothstep(
    float(-WATER_BOX_DEPTH * 0.5),
    float(WATER_BOX_DEPTH * 0.5),
    positionLocal.z
  )
  const bodyColor = mix(color('#effdff'), color('#20a5ea'), depthTint)
  const depthColor = mix(bodyColor, color('#0a5ea8'), depthTint.mul(0.7).add(0.18))
  const refractedColor = mix(depthColor, color('#7ce4ff'), surfaceRipple.mul(0.75).add(0.1))

  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(2.4)
  const finalColor = mix(refractedColor, color('#f7feff'), fresnel.mul(0.78).add(edgeFactor.mul(0.1)))

  const rippleNormal = normalLocal.add(
    vec3(
      longWave.mul(1.15).add(flowNoise.mul(0.2)),
      diagonalWave.mul(1.25).add(secondaryNoise.mul(0.16)),
      surfaceRipple.mul(0.12)
    )
  ).normalize()

  material.colorNode = finalColor
  material.normalNode = rippleNormal
  material.transmissionNode = mix(float(0.94), float(0.99), fresnel.mul(0.22))
  material.thicknessNode = mix(float(2.8), float(4.4), depthTint.mul(0.42).add(edgeFactor.mul(0.22)))
  material.attenuationColorNode = mix(color('#a8f4ff'), color('#148bd5'), depthTint.mul(0.82))
  material.opacityNode = float(0.9)

  return material
}

function WaterBoxLayer() {
  const material = useMemo(() => createWaterMaterial(), [])

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  return (
    <group>
      <CubeCamera frames={1} resolution={256} position={WATER_BOX_CENTER}>
        {(environmentMap) => {
          material.envMap = environmentMap

          return (
            <mesh castShadow receiveShadow position={WATER_BOX_CENTER}>
              <boxGeometry args={[WATER_BOX_WIDTH, WATER_BOX_HEIGHT, WATER_BOX_DEPTH]} />
              <primitive object={material} attach='material' />
            </mesh>
          )
        }}
      </CubeCamera>

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
