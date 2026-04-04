import { CubeCamera } from '@react-three/drei'

const MATERIAL_SAMPLES = [
  {
    position: [-7.4, 0, 1.45],
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
    position: [-3.7, 0, 1.45],
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
    material: {
      color: '#d9dbde',
      roughness: 0.18,
      metalness: 1,
      clearcoat: 0.22,
      clearcoatRoughness: 0.08,
    },
  },
  {
    position: [3.7, 0, 1.45],
    label: 'Mirror',
    material: {
      color: '#f3f4f6',
      roughness: 0.01,
      metalness: 1,
      clearcoat: 0,
      clearcoatRoughness: 0,
    },
  },
  {
    position: [7.4, 0, 1.45],
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

const MIRROR_SAMPLE_INDEX = 3

function SampleSphere({ sample, index }) {
  const isMirror = index === MIRROR_SAMPLE_INDEX
  const meshPosition = isMirror ? [0, 0, 0] : sample.position
  const rotation = [0, index === 4 ? Math.PI * 0.22 : 0, 0]

  const sphere = (environmentMap) => (
    <mesh castShadow receiveShadow position={meshPosition} rotation={rotation}>
      <sphereGeometry args={[1.35, 96, 96]} />
      <meshPhysicalMaterial {...sample.material} envMap={environmentMap} />
    </mesh>
  )

  return (
    <group key={sample.label}>
      {isMirror ? (
        <CubeCamera frames={Infinity} resolution={256} position={sample.position}>
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
      {MATERIAL_SAMPLES.map((sample, index) => (
        <SampleSphere key={sample.label} sample={sample} index={index} />
      ))}
    </group>
  )
}

export default MaterialSamplesLayer
