import { useState } from 'react'
import { useControls } from 'leva'
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
import WaterOceanLayer from './layers/WaterOceanLayer'
import Coordinate from './gis/CoordinateContext'
import { WORLD_VIEW } from './gis/views'
import GeojsonLayer from './layers/GeojsonLayer'
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import TerrainLayer from './layers/TerrainLayer'

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
  const { showOcean } = useControls({ showOcean: true })
  
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

      {/* DEM 地形レイヤー */}
      <TerrainLayer
        url="./dem/hormuz.tif"
        smooth={0.1}
        heightScale={0.75}
        baseHeight={1}
        seaLevel={0.15}
        position={[0, 0, 0]}
      />

      {/* 海面レイヤー */}
      {showOcean && (
        <WaterOceanLayer
          width={15.9}
          height={15.9}
          depth={0.9}
          opacity={0.85}
          position={[0, 0, 0]}
        />
      )}

    </>
  )
}

export default Scene
