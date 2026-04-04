function LightingRig() {
  return (
    <>
      <ambientLight intensity={0.08} color='#f4f1eb' />
      <hemisphereLight args={['#d6d3cf', '#4e4e4e', 0.55]} position={[0, 0, 12]} />

      <directionalLight
        castShadow
        color='#fff8ef'
        intensity={1.8}
        position={[6, -12, 14]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={48}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
        shadow-bias={-0.00008}
      />

      <spotLight
        color='#fffaf2'
        intensity={18}
        angle={0.5}
        penumbra={0.8}
        decay={1.2}
        distance={32}
        position={[-8, -9, 7]}
      />

      <spotLight
        color='#f8fbff'
        intensity={10}
        angle={0.55}
        penumbra={0.9}
        decay={1.25}
        distance={34}
        position={[10, -2, 9]}
      />

      <pointLight color='#fff1dd' intensity={2.4} distance={20} position={[0, -3, 6]} />
      <pointLight color='#d9e3f2' intensity={1.8} distance={20} position={[12, 4, 8]} />
    </>
  )
}

export default LightingRig
