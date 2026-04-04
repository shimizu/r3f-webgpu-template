function LightingRig() {
  return (
    <>
      <ambientLight intensity={0.42} color='#c7d1dc' />
      <hemisphereLight
        args={['#f7fbff', '#52606c', 1.15]}
        position={[0, 0, 12]}
      />

      <directionalLight
        castShadow
        color='#fff4dc'
        intensity={2.4}
        position={[10, -6, 16]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
      />

      <spotLight
        castShadow
        color='#ffe7c2'
        intensity={26}
        angle={0.34}
        penumbra={0.5}
        decay={1.3}
        distance={48}
        position={[-12, 10, 14]}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />

      <pointLight color='#7fd6ff' intensity={18} distance={28} position={[14, 12, 8]} />
      <pointLight color='#ff8b4d' intensity={10} distance={18} position={[-10, -12, 6]} />
    </>
  )
}

export default LightingRig
