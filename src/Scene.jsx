import { useState } from 'react'
import { useControls } from 'leva'
import { MapControls } from '@react-three/drei'

import LightingRig from './LightingRig'
// eslint-disable-next-line no-unused-vars
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
// eslint-disable-next-line no-unused-vars
import GeojsonLayer from './layers/GeojsonLayer'
// eslint-disable-next-line no-unused-vars
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import TerrainLayer from './layers/TerrainLayer'
// eslint-disable-next-line no-unused-vars
import CloudLayer from './layers/CloudLayer'
// eslint-disable-next-line no-unused-vars
import Labels3DLayer from './layers/Labels3DLayer'
import GrassLayer from './layers/GrassLayer'

// 移動体モックの生成域（hormuz.tif の bbox 45.85〜65.19 / 21.90〜32.12 の内側）。
// MovingEntitiesLayer の useMemo 依存になるため、inline ではなく定数で渡す
// eslint-disable-next-line no-unused-vars
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
// TerrainLayer と GrassLayer（海面マスク）で共有する正規化海面標高
const SEA_LEVEL = 0.19

// eslint-disable-next-line no-unused-vars
function Scene({ entityCount = 2000 }) {
  const [heightInfo, setHeightInfo] = useState(null)
  const { showOcean, grassPlacement } = useControls({
    showOcean: { value: true, label: '海面を表示' },
    grassPlacement: {
      value: 'terrain',
      options: { '地形(DEM)': 'terrain', 'ステージ床': 'floor', 'なし': 'none' },
      label: '草の配置',
    },
  })
  const { wetness } = useControls('天候', {
    wetness: { value: 0, min: 0, max: 1, step: 0.01, label: '地面の濡れ' },
  })
  
  return (
    <>
      {/* 太陽光や環境光を一括管理するリグ */}
      <LightingRig />

      {/* ポストプロセッシング (Bloom + Tilt-Shift) */}
      {/*<SceneEffects />*/}

      {/* 室内・卓上トーンの空ドーム（静的グラデーション + fBM 雲） */}
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

      {/* GPU インスタンス草（1 ドローコール）。leva で 地形(DEM) / ステージ床 を切替。
          DEM 版は TerrainLayer の onHeightData（heightInfo）を待ってからマウントする */}
      {grassPlacement === 'floor' && <GrassLayer area={40} position={[0, -1, 0]} />}
      {grassPlacement === 'terrain' && heightInfo && (
        <GrassLayer
          heightInfo={heightInfo}
          seaLevel={SEA_LEVEL}
          bladeScale={0.4}
          position={[0, 0.5, 0]}
        />
      )}

      {/* GIS: DEM 地形 + GeoJSON を同一投影コンテキストで自動整合 */}
      <Coordinate projection="equirectangular" view={HORMUZ_VIEW} position={[0, 0.5, 0]}>
        <TerrainLayer
          url="./dem/hormuz.tif"
          smooth={1.25}
          heightScale={0.5}
          baseHeight={1.5}
          seaLevel={SEA_LEVEL}
          onHeightData={setHeightInfo}
          wetness={wetness}
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

      {/* 体積雲: 低層の積雲（地形フットプリントよりひと回り大きく） */}
      {/*
      <CloudLayer
        width={24}
        depth={15}
        thickness={2.5}
        coverage={0.45}
        type='cumulus'
        position={[0, 6, 0]}
      />      
      */}

      {/* 体積雲: 高層の巻雲（GrassLayer / 濡れ表現の動作確認のため一時無効化） */}
      {/*
      <CloudLayer
        width={21.3}
        depth={12.6}
        thickness={1.5}
        coverage={0.65}
        type='stratus'
        steps={12}
        position={[0, 5, 0]}
      />
      */}

      {/* HTML ラベル（動作確認のため一時無効化） */}
      {/*<Labels3DLayer />*/}

    </>
  )
}

export default Scene
