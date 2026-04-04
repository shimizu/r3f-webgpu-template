import { CubeCamera, Html } from '@react-three/drei'

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
const WATER_SAMPLE_INDEX = 5

const LABEL_STYLE = {
  color: '#f3f1ec',
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}

function SampleLabel({ position, label }) {
  return (
    <Html position={position} center transform distanceFactor={12}>
      <div style={LABEL_STYLE}>{label}</div>
    </Html>
  )
}

function SampleSphere({ sample, index }) {
  const isMirror = index === MIRROR_SAMPLE_INDEX
  const isWater = index === WATER_SAMPLE_INDEX
  const meshPosition = isMirror ? [0, 0, 0] : sample.position
  const rotation = [0, index === 4 ? Math.PI * 0.22 : 0, 0]

  const sphere = (environmentMap) => (
    <mesh castShadow receiveShadow position={meshPosition} rotation={rotation}>
      {isWater ? (
        <boxGeometry args={[2.45, 2.45, 2.45]} />
      ) : (
        <sphereGeometry args={[1.35, 96, 96]} />
      )}
      <meshPhysicalMaterial
        {...sample.material}
        envMap={environmentMap}
        reflectivity={isWater ? 1 : sample.material.reflectivity}
      />
    </mesh>
  )

  return (
    <group key={sample.label}>
      {isMirror || isWater ? (
        <CubeCamera frames={Infinity} resolution={256} position={sample.position}>
          {sphere}
        </CubeCamera>
      ) : (
        sphere()
      )}

      <SampleLabel
        position={[sample.position[0], sample.position[1] - 2.55, 0.42]}
        label={sample.label}
      />
    </group>
  )
}

function ExtrudedGridLayer() {
  const samples = [
    ...MATERIAL_SAMPLES,
    {
      position: [0, -4.7, 1.45],
      label: 'Water',
      material: {
        color: '#d9f3ff',
        roughness: 0.03,
        metalness: 0,
        transmission: 0.99,
        thickness: 3.6,
        transparent: true,
        opacity: 0.52,
        ior: 1.333,
        attenuationDistance: 4.8,
        attenuationColor: '#69c7ff',
        clearcoat: 1,
        clearcoatRoughness: 0.02,
      },
    },
  ]

  return (
    <group position={[0, 0, 0.02]}>
      {samples.map((sample, index) => (
        <SampleSphere key={sample.label} sample={sample} index={index} />
      ))}
    </group>
  )
}

export default ExtrudedGridLayer
