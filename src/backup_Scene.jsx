import { useState } from 'react'
import { MapControls } from '@react-three/drei'

import LightingRig from './LightingRig'
import SceneEffects from './effects/SceneEffects'
import MaterialSamplesLayer from './layers/MaterialSamplesLayer'
import RainLayer from './layers/RainLayer'
import SkyLayer from './layers/SkyLayer'
import GridLayer from './layers/GridLayer'
import TerrainLayer from './layers/TerrainLayer'
import WaterBlobLayer from './layers/WaterBlobLayer'
import WaterBoxLayer from './layers/WaterBoxLayer'
import WaterOceanLayer from './layers/WaterOceanLayer'

/*
  このファイルの処理の流れ

  1. Scene が 3D シーン全体の見た目を組み立てる
     背景色、ライト、カメラ操作、各レイヤーを
     1 つの React コンポーネントとして並べている。

  2. MapControls がカメラ操作を担当する
     左ドラッグで平行移動、右ドラッグで回転、ホイールでズームできるようにして、
     地図を観察しやすい操作感を用意している。

  3. 各レイヤーがジオラマ舞台を描画する
     SkyLayer: Preetham モデルによる大気散乱の空
     StageLayer: 工作マット風 floor
     MaterialSamplesLayer: マテリアルサンプル球体5種
     WaterBoxLayer: TSL 水面シミュレーション

  つまり Scene.jsx は、
  「シーンの見た目と操作を定義する」
  「全レイヤーを直接合成する」
  という画面構成の入口になっている。
*/
function Scene({ rainEnabled = true }) {
  const [heightInfo, setHeightInfo] = useState(null)
  return (
    <>
      {/* 雨天フォグ: 一時無効化
      <fog attach="fog" args={['#6a7580', 20, 60]} />
      */}

      <LightingRig />
      <SkyLayer />

      {/* カメラ操作。
          このシーンでは左ドラッグを PAN にして、
          地図を「掴んで動かす」感覚を優先している。 */}
      <MapControls
        enableDamping
        minDistance={6}
        maxDistance={42}
        target={[0, 0, 0]}
      />

      {/*位置確認用
      <mesh>
        <boxGeometry  args={[10,10,10]}/>
        <meshNormalMaterial/>
      </mesh>        
 
      <group position={[0, 0, 0]} rotation={[0, 0, 0]}>
        <StageLayer />
        <MaterialSamplesLayer />
        <WaterBoxLayer
          width={8}
          height={8}
          depth={2}
          position={[-10, 2, -6]}
        />
        <WaterBlobLayer
          width={8}
          height={8}
          depth={6}
          position={[0, 2, -6]}
        />
        </group>
        <WaterOceanLayer
          width={15.9}
          height={15.9}
          depth={2}
          opacity={0.5}
          position={[0, 2.0001, 0]}
        />
        

        //ブルーム確認用: 高 emissive の光る球体 
        <mesh position={[0, 5, 0]}>
          <sphereGeometry args={[0.5, 32, 32]} />
          <meshStandardMaterial
            color='#ff6600'
            emissive='#ff6600'
            emissiveIntensity={5}
          />
        </mesh>

        //ポストプロセッシング: Bloom + Godrays 
        <SceneEffects />

     */}

        <GridLayer position={[0, -2, 0]} />

        <WaterOceanLayer
          width={15.99}
          height={15.99}
          depth={2}
          opacity={0.5}
          position={[0, 0, 0]}
        />

        <TerrainLayer
          url="./dem/taiwan.tif"
          texture="./dem/taiwan.png"
          heightScale={0.5}
          baseHeight={2}
          smooth={1}
          position={[0, 0, 0]}
          onHeightData={setHeightInfo}
          seaLevel={0.27}
          colors={{
            deepOcean: '#0a1a3a',
            shallowOcean: '#1a6a8a',
            shore: '#c2b280',
            lowland: '#4a8a3a',
            highland: '#9fdf8a',
            mountain: '#8a7a6a',
            peak: '#f0f0f0',
            side: '#3a2a1a',
          }}
        />

        {rainEnabled && (
          <RainLayer
            heightInfo={heightInfo}
            position={[0, 0, 0]}
            width={15.9}
            depth={15.9}
            topY={6}
            particleCount={30000}
          />
        )}

        {/*<axesHelper args={[10]} />*/}
        
    </>
  )
}

export default Scene
