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
  vec3,
} from 'three/tsl'

const LABEL_STYLE = {
  color: '#f3f1ec',
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

const BOX_SIZE = 2.45
const BOX_HALF_SIZE = BOX_SIZE * 0.5

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
  const waveBands = positionLocal.y
    .mul(4.6)
    .sub(time.mul(1.65))
    .sin()
    .mul(positionLocal.x.mul(7.4).add(time.mul(1.18)).sin())
    .mul(0.08)
  const surfaceRipple = flowNoise.add(secondaryNoise).add(waveBands)

  const edgeDistance = length(positionLocal.xy).div(float(BOX_HALF_SIZE * 1.414))
  const edgeFactor = smoothstep(float(0.28), float(1.0), edgeDistance)

  const depthTint = smoothstep(float(-BOX_HALF_SIZE), float(BOX_HALF_SIZE), positionLocal.z)
  const bodyColor = mix(color('#effdff'), color('#20a5ea'), depthTint)
  const depthColor = mix(bodyColor, color('#0a5ea8'), depthTint.mul(0.7).add(0.18))
  const refractedColor = mix(depthColor, color('#7ce4ff'), surfaceRipple.add(0.12))

  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(2.4)
  const finalColor = mix(refractedColor, color('#f7feff'), fresnel.mul(0.78).add(edgeFactor.mul(0.1)))

  const rippleNormal = normalLocal.add(
    vec3(
      positionLocal.y.mul(8.6).sub(time.mul(1.5)).sin().mul(0.12).add(flowNoise.mul(0.45)),
      positionLocal.x.mul(7.1).add(time.mul(1.3)).sin().mul(0.1).add(secondaryNoise.mul(0.35)),
      surfaceRipple.mul(0.3)
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
      <CubeCamera frames={1} resolution={256} position={[0, -4.7, 1.45]}>
        {(environmentMap) => {
          material.envMap = environmentMap

          return (
            <mesh castShadow receiveShadow position={[0, -4.7, 1.45]}>
              <boxGeometry args={[BOX_SIZE, BOX_SIZE, BOX_SIZE]} />
              <primitive object={material} attach='material' />
            </mesh>
          )
        }}
      </CubeCamera>

      <Html position={[0, -7.25, 0.42]} center transform distanceFactor={12}>
        <div style={LABEL_STYLE}>Water</div>
      </Html>
    </group>
  )
}

export default WaterBoxLayer
