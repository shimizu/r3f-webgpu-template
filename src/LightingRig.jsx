function LightingRig() {
  return (
    <>
      {/* 環境光: 暗めに落として影の深さを稼ぐ */}
      <ambientLight intensity={0.5} color='#6a7888' />
      <hemisphereLight args={['#5a6878', '#2a2a34', 0.15]} position={[0, 12, 0]} />

      {/* メインキー: 弱いディレクショナルで曇天の拡散光 */}
      <directionalLight
        castShadow
        color='#8898a8'
        intensity={0.25}
        position={[4, 16, -10]}
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

      {/* ドラマチック主照: 斜め上からの強いスポット。地形の起伏を強調 */}
      <spotLight
        color='#d0dce8'
        intensity={35}
        angle={0.35}
        penumbra={0.6}
        decay={1.2}
        distance={45}
        position={[-5, 18, -8]}
      />

      {/* バックライト: 逆光で雨粒をシルエット化。エッジが白く光る */}
      <spotLight
        color='#b0c8e0'
        intensity={28}
        angle={0.4}
        penumbra={0.7}
        decay={1.0}
        distance={50}
        position={[3, 14, -18]}
      />

      {/* サイドフィル: 右手前からの弱い暖色で明暗のグラデーション */}
      <spotLight
        color='#a09080'
        intensity={6}
        angle={0.5}
        penumbra={0.9}
        decay={1.3}
        distance={28}
        position={[12, 8, 6]}
      />

      {/* 地表ウェット感: 低い位置から青白い光で濡れた反射を演出 */}
      <pointLight color='#5070a0' intensity={1.2} distance={14} position={[0, 0.5, 0]} />

      {/* 奥行きのドラマ: 奥側に冷たい青の明かり */}
      <pointLight color='#4060a0' intensity={1.5} distance={20} position={[-3, 3, -10]} />
    </>
  )
}

export default LightingRig
