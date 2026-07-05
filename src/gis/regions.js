/*
  地域プリセット定義。

  「どの地域をジオラマ化するか」に紐づく設定（DEM・bbox・ビュー・海面標高・
  地形パラメータ・ラベル等）を 1 オブジェクトに集約する。Scene.jsx は leva の
  地域セレクタで REGIONS から 1 つ選び、各レイヤーへ配線するだけにする。

  - view: <Coordinate> に渡す投影ビュー（旧 views.js の HORMUZ_VIEW 相当）
  - seaLevel: 正規化標高（0..1、縮小 + ブラー済み DEM の min..max 基準）の海面値。
    物理的な 0 m ではなく lookdev で調整した見た目基準の値（地形の海色マスクと
    草の生育下限が参照する）
  - terrain: TerrainLayer の形状パラメータ
  - labels: Labels3DLayer に出す地名（ワールド座標）
*/

const DEG2RAD = Math.PI / 180

export const REGIONS = {
  hormuz: {
    id: 'hormuz',
    label: 'ホルムズ海峡',
    demUrl: './dem/hormuz.tif',
    // hormuz.tif の実 bbox（geotiff の getBoundingBox() と同値）
    bbox: { lonMin: 45.85, lonMax: 65.1875, latMin: 21.895833, latMax: 32.116667 },
    view: {
      centerLon: 55.51875,
      centerLat: 27.00625,
      worldScale: 71.1, // → フットプリント 約 21.38 × 12.68 units（regionFootprint 参照）
      altitudeScale: 0,
      sampleLonStep: 0.2,
      sampleLatStep: 0.2,
      projectionType: 'equirectangular',
    },
    seaLevel: 0.19,
    terrain: { smooth: 1.25, heightScale: 0.5, baseHeight: 1.5 },
    cloudHeight: 5,
    labels: [
      { id: 'iran', text: 'イラン', position: [0.5, 2, 4] },
      { id: 'hormuz', text: 'ホルムズ海峡', position: [-1, 1, 0] },
    ],
    // MovingEntitiesLayer 用の移動体モック生成域（bbox の内側）
    entityRegion: { lonMin: 47, lonMax: 64, latMin: 22.5, latMax: 31.5, lonDrift: -3 },
  },

  taiwan: {
    id: 'taiwan',
    label: '台湾',
    demUrl: './dem/taiwan.tif',
    // taiwan.tif の実 bbox
    bbox: { lonMin: 119.7625, lonMax: 122.504167, latMin: 21.7625, latMax: 25.329167 },
    view: {
      centerLon: 121.133333,
      centerLat: 23.545833,
      worldScale: 200, // → フットプリント 約 8.77 × 12.45 units（縦長の島）
      altitudeScale: 0,
      sampleLonStep: 0.05,
      sampleLatStep: 0.05,
      projectionType: 'equirectangular',
    },
    // 初期値。hormuz の比率（0m 正規化値 0.534 に対し採用値 0.19）に合わせた
    // 出発点で、taiwan の 0m 正規化値は 0.608。lookdev で要微調整
    seaLevel: 0.22,
    terrain: { smooth: 1.25, heightScale: 0.5, baseHeight: 1.5 },
    cloudHeight: 5,
    labels: [{ id: 'taiwan', text: '台湾', position: [0, 2.5, 0] }],
    entityRegion: null,
  },
}

// leva の select 用 { ラベル: id } マップ
export const REGION_OPTIONS = Object.fromEntries(
  Object.values(REGIONS).map((r) => [r.label, r.id])
)

// 投影後の地形フットプリント（XZ スパン、world units）を bbox + view から求める。
// equirectangular 前提: 幅 = Δλ·cos(centerLat)·worldScale, 奥行 = Δφ·worldScale（Δ は rad）。
// heightInfo（DEM ロード完了）を待たずにマウントするレイヤー（海面・雲）のサイズ決定に使う
export function regionFootprint({ bbox, view }) {
  const width =
    (bbox.lonMax - bbox.lonMin) * DEG2RAD * Math.cos(view.centerLat * DEG2RAD) * view.worldScale
  const depth = (bbox.latMax - bbox.latMin) * DEG2RAD * view.worldScale
  return { width, depth }
}
