export const WORLD_VIEW = {
  centerLon: 130,
  centerLat: 0,
  worldScale: 4.6,
  altitudeScale: 0,
  sampleLonStep: 0.2,
  sampleLatStep: 0.2,
  projectionType: 'equirectangular', //mercator,  equirectangular , natural-earth
}

// hormuz.tif (lon 45.850〜65.1875, lat 21.8958〜32.1167) 周辺のビュー。
// worldScale=71.1 → 投影後フットプリント 幅 ≈ 21.38 × 奥行 ≈ 12.68 units
// (幅 = Δλ·cos(centerLat)·worldScale, 奥行 = Δφ·worldScale)。
// TerrainLayer は <Coordinate> 配下では bbox + この worldScale から自動でサイズが決まる
export const HORMUZ_VIEW = {
  centerLon: 55.51875,
  centerLat: 27.00625,
  worldScale: 71.1,
  altitudeScale: 0,
  sampleLonStep: 0.2,
  sampleLatStep: 0.2,
  projectionType: 'equirectangular',
}

export const JAPAN_VIEW = {
  centerLon: 136.5,
  centerLat: 36.5,
  worldScale: 80,
  altitudeScale: 0,
  extentLon: 18,
  extentLat: 16,
  sampleLonStep: 0.05,
  sampleLatStep: 0.05,
  projectionType: 'equirectangular',
}
