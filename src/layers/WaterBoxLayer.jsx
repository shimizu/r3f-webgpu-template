import { useEffect, useMemo } from 'react'
import { CubeCamera, Html } from '@react-three/drei'
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
    transmission: 0.98,
    thickness: 2.9,
    roughness: 0.05,
    metalness: 0,
    ior: 1.333,
    attenuationDistance: 4.2,
    attenuationColor: '#5cc7ff',
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.1,
  })

  const waveNoise = mx_noise_float(
    positionWorld.mul(0.9).add(vec3(0, 0, time.mul(0.18)))
  ).mul(0.08)
  const waveBands = positionLocal.x
    .mul(5.4)
    .add(time.mul(1.4))
    .sin()
    .mul(positionLocal.y.mul(4.2).sub(time.mul(1.1)).sin())
    .mul(0.05)
  const surfaceRipple = waveNoise.add(waveBands)

  const depthTint = smoothstep(float(-BOX_HALF_SIZE), float(BOX_HALF_SIZE), positionLocal.z)
  const bodyColor = mix(color('#dcfbff'), color('#1491d9'), depthTint)
  const deepColor = mix(bodyColor, color('#0a5ea8'), surfaceRipple.add(0.16))

  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(2.8)
  const finalColor = mix(deepColor, color('#f7feff'), fresnel.mul(0.72))

  const rippleNormal = normalLocal.add(
    vec3(
      positionLocal.y.mul(7.5).add(time.mul(1.2)).sin().mul(0.18).add(waveNoise),
      positionLocal.x.mul(6.2).sub(time.mul(1.35)).sin().mul(0.14).add(waveBands),
      surfaceRipple.mul(0.55)
    )
  ).normalize()

  material.colorNode = finalColor
  material.normalNode = rippleNormal
  material.opacityNode = fresnel.mul(0.18).add(0.58)

  return material
}

function WaterBoxLayer() {
  const material = useMemo(() => createWaterMaterial(), [])

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  return (
    <group>
      <CubeCamera frames={Infinity} resolution={256} position={[0, -4.7, 1.45]}>
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
