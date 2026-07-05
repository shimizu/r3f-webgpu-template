import { useEffect, useMemo } from 'react'
import { useControls } from 'leva'
import { uniform } from 'three/tsl'
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
import { deriveLayerInputs } from './scenario/weather'
import { useScenario } from './scenario/useScenario'
// eslint-disable-next-line no-unused-vars
import GeojsonLayer from './layers/GeojsonLayer'
// eslint-disable-next-line no-unused-vars
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import RainLayer from './layers/RainLayer'
import SnowLayer from './layers/SnowLayer'
import HeightFogLayer from './layers/HeightFogLayer'
import LightningLayer from './layers/LightningLayer'
import TornadoLayer from './layers/TornadoLayer'
import FireLayer from './layers/FireLayer'
import SmokeLayer from './layers/SmokeLayer'
import TerrainLayer from './layers/TerrainLayer'
import CloudLayer from './layers/CloudLayer'
import Labels3DLayer from './layers/Labels3DLayer'
import GrassLayer from './layers/GrassLayer'
import TreeLayer from './layers/TreeLayer'

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
  const { regionId, showOcean, postfx } = useControls({
    regionId: { value: 'hormuz', options: REGION_OPTIONS, label: '地域' },
    showOcean: { value: true, label: '海面を表示' },
    // ポストFX（Bloom + Tilt-Shift + Film Grade）。GPU 負荷が高く TDR の
    // リスクがあるため既定オフ（steps≈12 の雲と併用時は特に注意）
    postfx: { value: false, label: 'ポストFX' },
  })
  // 「草」フォルダは GrassLayer 内の詳細パラメータと leva がマージする。
  // 表示トグルを Scene 側に置くことで、非表示中もフォルダが残り再表示できる
  const { showGrass, grassPlacement } = useControls('草', {
    showGrass: { value: false, label: '表示' },
    grassPlacement: {
      value: 'terrain',
      options: { '地形(DEM)': 'terrain', 'ステージ床': 'floor' },
      label: '配置',
    },
  })
  // 「木」フォルダも同じマージ方式（TreeLayer 内の詳細パラメータと合流）
  const { showTrees, treePlacement } = useControls('木', {
    showTrees: { value: false, label: '表示' },
    treePlacement: {
      value: 'terrain',
      options: { '地形(DEM)': 'terrain', 'ステージ床': 'floor' },
      label: '配置',
    },
  })
  const {
    rain,
    rainIntensity,
    snow,
    fogAmount,
    lightningRate,
    tornadoStrength,
    fireProgress,
    floodLevel,
    wetness,
    cloudType,
    cloudCoverage,
    cloudQuality,
  } = useControls('天候', {
    rain: { value: false, label: '雨' },
    rainIntensity: { value: 0.6, min: 0, max: 1, step: 0.01, label: '雨量' },
    snow: { value: false, label: '雪' },
    fogAmount: { value: 0, min: 0, max: 1, step: 0.01, label: '霧' },
    lightningRate: { value: 0, min: 0, max: 20, step: 0.5, label: '雷（回/分）' },
    tornadoStrength: { value: 0, min: 0, max: 1, step: 0.01, label: '竜巻' },
    fireProgress: { value: 0, min: 0, max: 1, step: 0.005, label: '山火事（延焼）' },
    floodLevel: { value: 0, min: 0, max: 0.6, step: 0.005, label: '浸水（水位上昇）' },
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

  // シナリオ再生（leva「シナリオ」フォルダ）。選択中はシナリオの weather が
  // 手動（天候フォルダ）より優先される。連動ルールは deriveLayerInputs に集約
  const scenarioWeather = useScenario()
  const manualWeather = {
    rainIntensity: rain ? rainIntensity : 0,
    snowIntensity: snow ? 1 : 0,
    fogDensity: fogAmount,
    floodLevel,
    wetness,
    cloudCoverage,
    cloudType,
    lightningRate,
    tornadoStrength,
    fireProgress,
  }
  const inputs = deriveLayerInputs(scenarioWeather ?? manualWeather)

  // 山火事の発火点: 地形内側（端 12% を除く）の最高標高セルを決定的に選ぶ
  // （尾根から燃え広がる見た目になり、リロードでも再現される）
  const fireIgnition = useMemo(() => {
    if (!heightInfo) return null
    const { heights, cols, rows, terrainWidth, terrainDepth } = heightInfo
    const margin = 0.12
    let best = { v: -Infinity, c: 0, r: 0 }
    for (let r = Math.floor(rows * margin); r < rows * (1 - margin); r += 3) {
      for (let c = Math.floor(cols * margin); c < cols * (1 - margin); c += 3) {
        const v = heights[r * cols + c]
        if (v > best.v) best = { v, c, r }
      }
    }
    return [
      (best.c / (cols - 1)) * terrainWidth - terrainWidth / 2,
      (best.r / (rows - 1)) * terrainDepth - terrainDepth / 2,
    ]
  }, [heightInfo])
  // 延焼半径: 進行 0..1 → 地形対角の 4 割まで
  const fireRadius = heightInfo
    ? inputs.fireProgress *
      Math.hypot(heightInfo.terrainWidth, heightInfo.terrainDepth) * 0.4
    : 0

  // 雷フラッシュ uniform: LightningLayer が書き、CloudLayer（雲内発光）が読む。
  // 安定参照必須（CloudLayer のシェーダ再構築を避ける）
  const lightningFlash = useMemo(() => uniform(0), [])

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

      {/* 高さフォグ（scene.fogNode）。マウントしっぱなしで density を uniform 駆動
          （条件マウントにすると全マテリアル再コンパイルが走る）。
          手動時はスライダー 0 で完全無効。シナリオはキーフレームで明示駆動 */}
      <HeightFogLayer density={inputs.fogDensity} baseY={0.5} />

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

      {/* GPU インスタンス樹木（1 ドローコール。針葉樹 + 広葉樹の混在）。
          草と同じく leva「木」フォルダの表示トグル + 配置切替 */}
      {showTrees && treePlacement === 'floor' && <TreeLayer area={40} position={[0, -1, 0]} />}
      {showTrees && treePlacement === 'terrain' && heightInfo && (
        <TreeLayer
          terrain
          seaLevel={region.seaLevel}
          treeScale={0.35}
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
          elevationStops={region.terrain.elevationStops}
          seaLevel={region.seaLevel}
          onHeightData={setHeightInfo}
          wetness={inputs.wetnessTarget}
          snowAmount={snowAmount}
          snowing={inputs.snowing}
          fireIgnition={fireIgnition}
          fireRadius={fireRadius}
          snowLine={snowLine}
          snowAspect={snowAspect}
          snowColor={snowColor}
          snowRoughness={snowRoughness}
        />
      </Coordinate>


      {/* 降雨: 地形フットプリントに合わせて散布し、共有ハイトフィールドで地形衝突。
          雨は TerrainLayer の濡れ目標も駆動する（連動は deriveLayerInputs、
          時定数追従は Terrain 側） */}
      {inputs.rainActive && heightInfo && (
        <RainLayer
          position={[0, 0.5, 0]}
          width={heightInfo.terrainWidth}
          depth={heightInfo.terrainDepth}
          topY={6}
          particleCount={15000}
          intensity={inputs.rainIntensity}
        />
      )}

      {/* 降雪: 地形フットプリントに散布し、共有ハイトフィールドで着地静止 + フェード。
          雪は TerrainLayer の堆積（snowing）もゆっくり駆動する */}
      {inputs.snowActive && heightInfo && (
        <SnowLayer
          position={[0, 0.5, 0]}
          width={heightInfo.terrainWidth}
          depth={heightInfo.terrainDepth}
          topY={6}
          particleCount={12000}
          intensity={inputs.snowIntensity}
        />
      )}

      {/* 稲妻: ポアソン過程で落雷（rate 0 なら完全 idle）。ボルト + 地形を照らす
          フラッシュライト + 雲内発光（lightningFlash uniform 経由）を同期駆動 */}
      {heightInfo && (
        <LightningLayer
          position={[0, 0.5, 0]}
          rate={inputs.lightningRate}
          topY={region.cloudHeight - 1.2}
          flashUniform={lightningFlash}
        />
      )}

      {/* 竜巻: vortex 風場のデブリ + メッシュ漏斗雲。中心は緩い軌道で移動し、
          強さはシナリオ / 天候フォルダから uniform 駆動 */}
      {inputs.tornadoActive && heightInfo && (
        <TornadoLayer
          position={[0, 0.5, 0]}
          topY={region.cloudHeight - 0.9}
          strength={inputs.tornadoStrength}
        />
      )}

      {/* 山火事の炎 + 火の粉: TerrainLayer の延焼マスクと同じ発火点・半径で
          燃焼前線リングに沿って燃える（uniform 駆動） */}
      {inputs.fireActive && heightInfo && fireIgnition && (
        <FireLayer
          position={[0, 0.5, 0]}
          ignition={fireIgnition}
          radius={fireRadius}
        />
      )}

      {/* 山火事の煙: 延焼マスクの XZ ゲート付き smoke プリセット雲。
          山火事中は通常雲の coverage が自動で絞られる（deriveLayerInputs） */}
      {inputs.fireActive && heightInfo && fireIgnition && (
        <SmokeLayer
          position={[0, 2.2, 0]}
          width={footprint.width}
          depth={footprint.depth}
          thickness={3}
          ignition={fireIgnition}
          radius={fireRadius}
        />
      )}

      {/* 海面レイヤー（投影後の地形フットプリントに合わせる）。
          浸水で水位が上がり、水位・雨量に応じて泥水に濁る */}
      {showOcean && (
        <WaterOceanLayer
          width={footprint.width}
          height={footprint.depth}
          depth={1}
          opacity={0.85}
          position={[0, 0.5, 0]}
          floodLevel={inputs.floodLevel}
          murkiness={inputs.murkiness}
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

      {/* 体積雲（タイプ・雲量は weather 経由、品質は leva「天候」フォルダ。
          雲量は uniform 駆動、タイプ・品質の切替は再コンパイルが走る） */}
      <CloudLayer
        width={footprint.width}
        depth={footprint.depth}
        thickness={1.5}
        coverage={inputs.cloudCoverage}
        type={inputs.cloudType}
        steps={12}
        quality={cloudQuality}
        position={[0, region.cloudHeight, 0]}
        flashNode={lightningFlash}
      />

      {/* HTML ラベル（地名は地域プリセット由来） */}
      <Labels3DLayer labels={region.labels} />

    </>
  )
}

export default Scene
