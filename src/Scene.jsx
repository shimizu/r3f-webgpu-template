import { useState } from 'react'
import { MapControls } from '@react-three/drei'

import LightingRig from './LightingRig'
// eslint-disable-next-line no-unused-vars
import SceneEffects from './effects/SceneEffects'
// eslint-disable-next-line no-unused-vars
import MaterialSamplesLayer from './layers/MaterialSamplesLayer'
import SkyLayer from './layers/SkyLayer'
// eslint-disable-next-line no-unused-vars
import GridLayer from './layers/GridLayer'
// eslint-disable-next-line no-unused-vars
import WaterBlobLayer from './layers/WaterBlobLayer'
// eslint-disable-next-line no-unused-vars
import WaterBoxLayer from './layers/WaterBoxLayer'
// eslint-disable-next-line no-unused-vars
import WaterOceanLayer from './layers/WaterOceanLayer'
import Coordinate from './gis/CoordinateContext'
import { WORLD_VIEW } from './gis/views'
import GeojsonLayer from './layers/GeojsonLayer'
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'

/**
 * シーン全体の構成を定義するコンポーネント。
 * 
 * 処理の流れ:
 * 1. 背景（空）、照明（ライトリグ）、カメラ操作（MapControls）を配置。
 * 2. GIS コンテキスト（Coordinate）を構築し、地理座標系を 3D 空間に投影。
 * 3. 投影された空間内に地図（GeoJSON）や移動体（MovingEntities）を描画。
 */
function Scene({ entityCount = 2000 }) {
  // eslint-disable-next-line no-unused-vars
  const [heightInfo, setHeightInfo] = useState(null)
  
  return (
    <>
      {/* 太陽光や環境光を一括管理するリグ */}
      <LightingRig />
      
      {/* Preetham モデルによる動的な空の描画 */}
      <SkyLayer />

      {/* 地図閲覧に適したカメラ操作（左ドラッグで移動、右ドラッグで回転） */}
      <MapControls
        enableDamping
        minDistance={6}
        maxDistance={42}
        target={[0, 0, 0]}
      />

      {/* 
          GIS コンテキスト:
          地理座標（lon/lat）を 3D 空間（x/y/z）へ投影する設定を提供します。
          ここでは等距円筒図法を使用し、XZ 平面に配置されるよう回転させています。
      */}
      <Coordinate 
        projection="equirectangular" 
        view={WORLD_VIEW} 
        position={[0, -1.249, -10]} 
        rotation={[-Math.PI / 2, 0, -Math.PI]}
      >
        {/* 世界地図のベクトルデータレイヤー */}
        <GeojsonLayer url='./data/world.geojson' />
        
        {/* リアルタイム補間を用いた移動体のパーティクルレイヤー */}
        <MovingEntitiesLayer key={entityCount} entityCount={entityCount} />
      </Coordinate>
    </>
  )
}

export default Scene
