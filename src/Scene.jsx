import { useState } from 'react'
import { useControls } from 'leva'
import { MapControls } from '@react-three/drei'

import LightingRig from './LightingRig'
import SceneEffects from './effects/SceneEffects'
// eslint-disable-next-line no-unused-vars
import MaterialSamplesLayer from './layers/MaterialSamplesLayer'
import SkyLayer from './layers/SkyLayer'
import GridLayer from './layers/GridLayer'
// eslint-disable-next-line no-unused-vars
import WaterBlobLayer from './layers/WaterBlobLayer'
// eslint-disable-next-line no-unused-vars
import WaterBoxLayer from './layers/WaterBoxLayer'
import WaterOceanLayer from './layers/WaterOceanLayer'
import Coordinate from './gis/CoordinateContext'
import { HORMUZ_VIEW } from './gis/views'
import GeojsonLayer from './layers/GeojsonLayer'
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import TerrainLayer from './layers/TerrainLayer'
import Labels3DLayer from './layers/Labels3DLayer'

// 移動体モックの生成域（hormuz.tif の bbox 45.85〜65.19 / 21.90〜32.12 の内側）。
// MovingEntitiesLayer の useMemo 依存になるため、inline ではなく定数で渡す
const ENTITY_REGION = {
  lonMin: 47,
  lonMax: 64,
  latMin: 22.5,
  latMax: 31.5,
  lonDrift: -3,
}

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
  const { showOcean } = useControls({
    showOcean: { value: true, label: '海面を表示' },
  })
  
  return (
    <>
      {/* 太陽光や環境光を一括管理するリグ */}
      <LightingRig />

      {/* ポストプロセッシング (Bloom + Tilt-Shift) */}
      <SceneEffects />

      {/* Preetham モデルによる動的な空の描画 */}
      <SkyLayer />

      {/* 地図閲覧に適したカメラ操作（左ドラッグで移動、右ドラッグで回転） */}
      <MapControls
        enableDamping
        minDistance={6}
        maxDistance={42}
        target={[0, 0, 0]}
      />

      {/* 青いグリッドレイヤー */}
      <GridLayer position={[0, -1, 0]} />

      {/* GIS: DEM 地形 + GeoJSON を同一投影コンテキストで自動整合 */}
      <Coordinate projection="equirectangular" view={HORMUZ_VIEW} position={[0, 0.5, 0]}>
        <TerrainLayer
          url="./dem/hormuz.tif"
          smooth={1.25}
          heightScale={0.5}
          baseHeight={1.5}
          seaLevel={0.19}
        />
        <GeojsonLayer url='./data/world.geojson' altitude={1.65} />
        {/* 移動体はホルムズ域内で生成し、地形より上（altitude）に浮かせる */}
        <MovingEntitiesLayer
          entityCount={entityCount}
          region={ENTITY_REGION}
          altitude={1.7}
        />
      </Coordinate>


      {/* 海面レイヤー（投影後の地形フットプリント 21.38 × 12.68 に合わせる） */}
      {showOcean && (
        <WaterOceanLayer
          width={21.3}
          height={12.6}
          depth={1}
          opacity={0.85}
          position={[0, 0.5, 0]}
        />
      )}

      {/* HTML ラベル */}
      <Labels3DLayer />

    </>
  )
}

export default Scene
