import { useEffect, useMemo } from 'react'
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
import { REGIONS, REGION_OPTIONS, regionFootprint } from './gis/regions'
import { HeightFieldProvider, useHeightField } from './gis/HeightFieldContext'
// eslint-disable-next-line no-unused-vars
import GeojsonLayer from './layers/GeojsonLayer'
// eslint-disable-next-line no-unused-vars
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import RainLayer from './layers/RainLayer'
import SnowLayer from './layers/SnowLayer'
import TerrainLayer from './layers/TerrainLayer'
import CloudLayer from './layers/CloudLayer'
import Labels3DLayer from './layers/Labels3DLayer'
import GrassLayer from './layers/GrassLayer'

/**
 * シーン全体の構成を定義するコンポーネント。
 *
 * 処理の流れ:
 * 1. 背景（空）、照明（ライトリグ）、カメラ操作（MapControls）を配置。
 * 2. GIS コンテキスト（Coordinate）を構築し、地理座標系を 3D 空間に投影。
 * 3. 投影された空間内に地図（GeoJSON）や移動体（MovingEntities）を描画。
 *
 * 地域固有の設定（DEM・ビュー・海面標高・移動体生成域等）は regions.js の
 * 地域プリセットに集約されており、leva の「地域」セレクタで切り替える。
 */
// 地形ハイトフィールドを全レイヤーで共有するため、Scene 本体を
// HeightFieldProvider でラップする（GPU バッファは Provider が 1 個だけ保持）
function Scene(props) {
  return (
    <HeightFieldProvider>
      <SceneContent {...props} />
    </HeightFieldProvider>
  )
}

// eslint-disable-next-line no-unused-vars
function SceneContent({ entityCount = 2000 }) {
  const { heightInfo, setHeightInfo } = useHeightField()
  const { regionId, showOcean, showGrass, grassPlacement, postfx } = useControls({
    regionId: { value: 'hormuz', options: REGION_OPTIONS, label: '地域' },
    showOcean: { value: true, label: '海面を表示' },
    // 草の表示トグル。GrassLayer 内の「草」フォルダに置くとオフ時に
    // フォルダごと消えて戻せなくなるため、マウント制御は Scene 側に置く
    showGrass: { value: true, label: '草を表示' },
    grassPlacement: {
      value: 'terrain',
      options: { '地形(DEM)': 'terrain', 'ステージ床': 'floor' },
      label: '草の配置',
    },
    // ポストFX（Bloom + Tilt-Shift + Film Grade）。GPU 負荷が高く TDR の
    // リスクがあるため既定オフ（steps≈12 の雲と併用時は特に注意）
    postfx: { value: false, label: 'ポストFX' },
  })
  const { rain, snow, wetness, cloudType, cloudCoverage, cloudQuality } = useControls('天候', {
    rain: { value: false, label: '雨' },
    snow: { value: false, label: '雪' },
    wetness: { value: 0, min: 0, max: 1, step: 0.01, label: '地面の濡れ（手動）' },
    cloudType: {
      value: 'stratus',
      options: { '層雲': 'stratus', '積雲': 'cumulus', '巻雲': 'cirrus' },
      label: '雲のタイプ',
    },
    cloudCoverage: { value: 0.65, min: 0, max: 1, step: 0.01, label: '雲量' },
    cloudQuality: {
      value: 'low',
      options: { '軽量': 'low', '高品質': 'high' },
      label: '雲の品質',
    },
  })
  const { snowAmount, snowLine, snowAspect, snowColor, snowRoughness } = useControls(
    '堆積 (雪/苔)',
    {
      snowAmount: { value: 0, min: 0, max: 1, step: 0.01, label: '量' },
      snowLine: { value: 0.55, min: 0, max: 1, step: 0.01, label: '堆積下限標高' },
      snowAspect: { value: 0.15, min: 0, max: 0.5, step: 0.01, label: '北斜面の効き' },
      snowColor: { value: '#eef4ff', label: '色（白=雪/緑=苔）' },
      snowRoughness: { value: 0.9, min: 0, max: 1, step: 0.01, label: 'ラフネス' },
    }
  )

  const region = REGIONS[regionId]
  // 海面・雲は heightInfo（DEM ロード完了）を待たずにマウントするため、
  // フットプリントは bbox + view から事前計算する
  const footprint = useMemo(() => regionFootprint(region), [region])

  // 地域切替時は旧地形の heightInfo を破棄する
  // （新 DEM ロード完了まで草・雨が旧地形の高さ場に配置されるのを防ぐ）
  useEffect(() => {
    setHeightInfo(null)
  }, [regionId, setHeightInfo])

  return (
    <>
      {/* 太陽光や環境光を一括管理するリグ */}
      <LightingRig />

      {/* ポストプロセッシング (Bloom + Tilt-Shift + Film Grade)。
          マウント時は R3F の自動描画から手動パイプライン描画に切り替わる */}
      {postfx && <SceneEffects />}

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

      {/* GPU インスタンス草（1 ドローコール）。leva で表示トグル + 地形(DEM) / ステージ床 を切替。
          DEM 版は TerrainLayer の onHeightData（heightInfo）を待ってからマウントする */}
      {showGrass && grassPlacement === 'floor' && <GrassLayer area={40} position={[0, -1, 0]} />}
      {showGrass && grassPlacement === 'terrain' && heightInfo && (
        <GrassLayer
          terrain
          seaLevel={region.seaLevel}
          bladeScale={0.4}
          position={[0, 0.5, 0]}
        />
      )}

      {/* GIS: DEM 地形 + GeoJSON を同一投影コンテキストで自動整合。
          地域切替は DEM 再ロードを伴うため key で TerrainLayer を再マウントする */}
      <Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
        <TerrainLayer
          key={region.id}
          url={region.demUrl}
          smooth={region.terrain.smooth}
          heightScale={region.terrain.heightScale}
          baseHeight={region.terrain.baseHeight}
          seaLevel={region.seaLevel}
          onHeightData={setHeightInfo}
          wetness={Math.max(wetness, rain ? 0.85 : 0)}
          snowAmount={snowAmount}
          snowing={snow}
          snowLine={snowLine}
          snowAspect={snowAspect}
          snowColor={snowColor}
          snowRoughness={snowRoughness}
        />
      </Coordinate>


      {/* 降雨: 地形フットプリントに合わせて散布し、共有ハイトフィールドで地形衝突。
          雨トグルで TerrainLayer の濡れ目標も駆動される（時定数追従は Terrain 側） */}
      {rain && heightInfo && (
        <RainLayer
          position={[0, 0.5, 0]}
          width={heightInfo.terrainWidth}
          depth={heightInfo.terrainDepth}
          topY={6}
          particleCount={15000}
        />
      )}

      {/* 降雪: 地形フットプリントに散布し、共有ハイトフィールドで着地静止 + フェード。
          雪トグルは TerrainLayer の堆積（snowing）もゆっくり駆動する */}
      {snow && heightInfo && (
        <SnowLayer
          position={[0, 0.5, 0]}
          width={heightInfo.terrainWidth}
          depth={heightInfo.terrainDepth}
          topY={6}
          particleCount={12000}
        />
      )}

      {/* 海面レイヤー（投影後の地形フットプリントに合わせる） */}
      {showOcean && (
        <WaterOceanLayer
          width={footprint.width}
          height={footprint.depth}
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

      {/* 体積雲（タイプ・雲量・品質は leva「天候」フォルダで変更。
          雲量は uniform 駆動、タイプ・品質の切替は再コンパイルが走る） */}
      <CloudLayer
        width={footprint.width}
        depth={footprint.depth}
        thickness={1.5}
        coverage={cloudCoverage}
        type={cloudType}
        steps={12}
        quality={cloudQuality}
        position={[0, region.cloudHeight, 0]}
      />

      {/* HTML ラベル（地名は地域プリセット由来） */}
      <Labels3DLayer labels={region.labels} />

    </>
  )
}

export default Scene
