import { MapControls } from '@react-three/drei'

import LightingRig from './LightingRig'
import MaterialSamplesLayer from './layers/MaterialSamplesLayer'
import SkyLayer from './layers/SkyLayer'
import StageLayer from './layers/StageLayer'
import WaterBlobLayer from './layers/WaterBlobLayer'

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
function Scene() {
  return (
    <>
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
      */}

      <group position={[0, 0, 0]} rotation={[0, 0, 0]}>
        <StageLayer />
        <MaterialSamplesLayer />
        <WaterBlobLayer
          width={20}
          height={8}
          depth={2.5}
          position={[0, 0, -3]}
        />
      </group>
    </>
  )
}

export default Scene
