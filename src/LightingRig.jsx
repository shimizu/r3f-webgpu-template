function LightingRig() {
  return (
    <>
      {/* 室内環境光: 暖色系の天井反射 */}
      <ambientLight intensity={0.6} color='#e8ddd0' />
      <hemisphereLight args={['#d8d0c4', '#8a8478', 0.4]} position={[0, 12, 0]} />

      {/* デスクライト（メインキー）: 上からの暖白色、影くっきり */}
      <directionalLight
        castShadow
        color='#fff4e6'
        intensity={0.8}
        position={[2, 14, -6]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={48}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
        shadow-bias={-0.0001}
      />

      {/* スポットライト（卓上ランプ風）: 手元を明るく照らす */}
      <spotLight
        color='#fff0d8'
        intensity={10}
        angle={0.25}
        penumbra={0.7}
        decay={1.2}
        distance={35}
        position={[-4, 12, -4]}
      />

      {/* フィルライト: 反対側からの弱い光で影を柔らかく */}
      <spotLight
        color='#d0d8e0'
        intensity={3}
        angle={0.6}
        penumbra={0.9}
        decay={1.3}
        distance={30}
        position={[8, 8, 4]}
      />

      {/* 卓上面の反射光: 緑のマットからの間接光 */}
      <pointLight color='#506048' intensity={0.4} distance={12} position={[0, 0.5, 0]} />
    </>
  )
}

export default LightingRig
