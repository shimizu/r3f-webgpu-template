import { CubeCamera } from '@react-three/drei'

const SPHERE_GEOMETRY = { radius: 1.35, segments: 96 }

const MATERIAL_SAMPLES = [
  {
    position: [7.4, 0, 1.45],
    label: 'Matte',
    material: {
      color: '#8faece',
      roughness: 0.9,
      metalness: 0.02,
      clearcoat: 0.02,
      clearcoatRoughness: 0.3,
    },
  },
  {
    position: [3.7, 0, 1.45],
    label: 'Semi Gloss',
    material: {
      color: '#88a6c8',
      roughness: 0.22,
      metalness: 0.04,
      clearcoat: 0.82,
      clearcoatRoughness: 0.04,
    },
  },
  {
    position: [0, 0, 1.45],
    label: 'Metal',
    cubeCamera: { frames: Infinity, resolution: 256 },
    material: {
      color: '#d4a017',
      roughness: 0.3,
      metalness: 1,
      clearcoat: 0,
      clearcoatRoughness: 0,
    },
  },
  {
    position: [-3.7, 0, 1.45],
    label: 'Mirror',
    cubeCamera: { frames: Infinity, resolution: 256 },
    material: {
      color: '#f3f4f6',
      roughness: 0.01,
      metalness: 1,
      clearcoat: 0,
      clearcoatRoughness: 0,
    },
  },
  {
    position: [-7.4, 0, 1.45],
    label: 'Glass',
    material: {
      color: '#8f8f96',
      roughness: 0.02,
      metalness: 0,
      transmission: 0.94,
      thickness: 2.2,
      transparent: true,
      opacity: 0.32,
      ior: 1.24,
      attenuationDistance: 9,
      attenuationColor: '#d8dbe2',
      clearcoat: 0.46,
      clearcoatRoughness: 0.02,
    },
  },
]

function SampleSphere({ sample }) {
  const useCubeCamera = !!sample.cubeCamera
  const meshPosition = useCubeCamera ? [0, 0, 0] : sample.position
  const isGlass = sample.label === 'Glass'
  const rotation = [0, isGlass ? Math.PI * 0.22 : 0, 0]

  const sphere = (environmentMap) => (
    <mesh castShadow={!useCubeCamera} receiveShadow position={meshPosition} rotation={rotation}>
      <sphereGeometry args={[SPHERE_GEOMETRY.radius, SPHERE_GEOMETRY.segments, SPHERE_GEOMETRY.segments]} />
      <meshPhysicalMaterial {...sample.material} envMap={environmentMap} />
    </mesh>
  )

  return (
    <group key={sample.label}>
      {useCubeCamera && (
        <mesh castShadow position={sample.position}>
          <sphereGeometry args={[SPHERE_GEOMETRY.radius, SPHERE_GEOMETRY.segments, SPHERE_GEOMETRY.segments]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>
      )}
      {useCubeCamera ? (
        <CubeCamera frames={sample.cubeCamera.frames} resolution={sample.cubeCamera.resolution} position={sample.position}>
          {sphere}
        </CubeCamera>
      ) : (
        sphere()
      )}
    </group>
  )
}

function MaterialSamplesLayer({ position = [0, 0, 0.02] }) {
  return (
    <group position={position}>
      {MATERIAL_SAMPLES.map((sample) => (
        <SampleSphere key={sample.label} sample={sample} />
      ))}
    </group>
  )
}

export default MaterialSamplesLayer
