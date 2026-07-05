import { fromArrayBuffer } from 'geotiff'

/*
  土地被覆（Dynamic World）ヘルパー。

  public/landcover/*.tif（Byte 1 バンド、クラス値 0..8、EPSG:4326）の読み込みと、
  クラス定数・パレット・座標変換をここに一元化する。共有は LandCoverContext が担う。

  カテゴリカルデータなので補間は厳禁:
  - readRasters は縮小せずフル解像度で読む（geotiff の resample はバイリニアで
    クラス境界に幽霊クラスが出る。DEM の MAX_DEM_SIZE 縮小はコピーしないこと）
  - GPU 側は DataTexture を NearestFilter + mipmap なしで扱う（LandCoverContext）
  - CPU サンプラも nearest（classAtWorld）
*/

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

// Dynamic World のクラス値（public/landcover/README.md のバンド定義）
export const LC = {
  WATER: 0,
  TREES: 1,
  GRASS: 2,
  FLOODED_VEGETATION: 3,
  CROPS: 4,
  SHRUB_AND_SCRUB: 5,
  BUILT: 6,
  BARE: 7,
  SNOW_AND_ICE: 8,
}

export const LC_CLASS_COUNT = 9

// レイヤー別の許可クラス。樹木は森林のみ、草は草地 + 農地 + 低木
// （flooded_vegetation は面積 0.1% のため除外。water/built/bare/snow は生育対象外）
export const TREE_CLASSES = [LC.TREES]
export const GRASS_CLASSES = [LC.GRASS, LC.CROPS, LC.SHRUB_AND_SCRUB]

// クラス値 → 地形 albedo の既定パレット（インデックス = クラス値）。
// water はプレースホルダ（TerrainLayer は water クラスに既存の水深 mix を使う）
export const DEFAULT_LC_PALETTE = [
  '#1a6a8a', // 0 water（未使用: 水深 mix で置換）
  '#3d6b35', // 1 trees      森林の深緑
  '#8faf62', // 2 grass      明るい草色
  '#5f9a78', // 3 flooded_vegetation
  '#c9b458', // 4 crops      農地の黄土
  '#a3a05c', // 5 shrub_and_scrub
  '#9b968f', // 6 built      市街地のグレー
  '#c2a46e', // 7 bare       裸地（既定 highland と同系）
  '#e8edf2', // 8 snow_and_ice
]

/**
 * 土地被覆 GeoTIFF をフル解像度で読む（縮小・補間なし）。
 * @returns {Promise<{data: Uint8Array, width: number, height: number,
 *                    bbox: [number, number, number, number]}>}
 *          bbox は [lonMin, latMin, lonMax, latMax]
 */
export async function loadLandCover(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`landcover fetch failed: ${response.status} ${url}`)
  const arrayBuffer = await response.arrayBuffer()
  const tiff = await fromArrayBuffer(arrayBuffer)
  const image = await tiff.getImage()
  const bbox = image.getBoundingBox()
  const width = image.getWidth()
  const height = image.getHeight()
  const rasters = await image.readRasters()
  const band = rasters[0]
  const data = band instanceof Uint8Array ? band : Uint8Array.from(band)
  return { data, width, height, bbox }
}

/**
 * world XZ → [lon, lat] の逆投影（equirectangular 専用）。
 * projectLonLatCPU の equirectangular 分岐 + <Coordinate> の Y-up 読み替え
 * （north = -Z、TerrainLayer.buildTerrainGeometry の posAt と同規約）の逆変換。
 * 草・木の iPos（原点中心の world XZ）から土地被覆をサンプルする際に使う。
 */
export function createWorldToLonLat(view) {
  const { centerLon = 0, centerLat = 0, worldScale = 1 } = view
  const invX = 1 / (worldScale * Math.cos(centerLat * DEG2RAD))
  return (x, z) => [
    centerLon + x * invX * RAD2DEG,
    centerLat - (z / worldScale) * RAD2DEG,
  ]
}

/**
 * world XZ → クラス値 (0..8) の CPU nearest サンプラを作る。
 * equirectangular 以外の投影は未対応（warn して null を返し、呼び出し側は
 * 土地被覆フィルタなしで続行する）。対応する場合は projectionCPU の逆関数化が必要。
 */
export function createClassAtWorld(info, view) {
  if ((view.projectionType ?? 'equirectangular') !== 'equirectangular') {
    console.warn(
      `landcover: projectionType "${view.projectionType}" は未対応です。` +
      '土地被覆フィルタを無効化します（equirectangular のみ対応）'
    )
    return null
  }
  const worldToLonLat = createWorldToLonLat(view)
  const [lonMin, latMin, lonMax, latMax] = info.bbox
  const { data, width, height } = info
  const invLon = width / (lonMax - lonMin)
  const invLat = height / (latMax - latMin)
  return (x, z) => {
    const [lon, lat] = worldToLonLat(x, z)
    const col = Math.min(Math.max(Math.floor((lon - lonMin) * invLon), 0), width - 1)
    const row = Math.min(Math.max(Math.floor((latMax - lat) * invLat), 0), height - 1)
    return data[row * width + col]
  }
}

/**
 * DEM uv → 土地被覆 uv の affine 係数（lcU = u·su + ou, lcV = v·sv + ov）。
 * 両 uv とも lon/lat 線形・v=1 が北の規約（TerrainLayer の topUvs / LandCoverContext
 * の行反転済み DataTexture）なので、bbox 比だけで投影に依存せず厳密に求まる。
 * TerrainLayer の土地被覆配色が使う。bbox は [lonMin, latMin, lonMax, latMax]。
 */
export function demUvToLcUvCoeffs(demBbox, lcBbox) {
  const [dLonMin, dLatMin, dLonMax, dLatMax] = demBbox
  const [lLonMin, lLatMin, lLonMax, lLatMax] = lcBbox
  const lonSpan = lLonMax - lLonMin
  const latSpan = lLatMax - lLatMin
  return {
    su: (dLonMax - dLonMin) / lonSpan,
    ou: (dLonMin - lLonMin) / lonSpan,
    sv: (dLatMax - dLatMin) / latSpan,
    ov: (dLatMin - lLatMin) / latSpan,
  }
}
