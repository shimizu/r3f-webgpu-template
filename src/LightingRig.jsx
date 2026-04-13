function LightingRig() {
  return (
    <>
      {/* 室内環境光: 暖色系の天井反射 */}
      <ambientLight intensity={0.6} color='#e8ddd0' />
      <hemisphereLight args={['#d8d0c4', '#8a8478', 0.4]} position={[0, 12, 0]} />

      {/* メインキー: x軸に沿って右→左への強い平行光 */}
      <directionalLight
        castShadow
        color='#fff4e6'
        intensity={1.5}
        position={[-20, 12, 0]}
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={0.5}
        shadow-camera-far={60}
        shadow-camera-left={-25}
        shadow-camera-right={25}
        shadow-camera-top={25}
        shadow-camera-bottom={-25}
        shadow-bias={-0.001}
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
