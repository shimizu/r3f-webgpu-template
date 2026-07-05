export const WORLD_VIEW = {
  centerLon: 130,
  centerLat: 0,
  worldScale: 4.6,
  altitudeScale: 0,
  sampleLonStep: 0.2,
  sampleLatStep: 0.2,
  projectionType: 'equirectangular', //mercator,  equirectangular , natural-earth
}

// DEM 地形に紐づく地域ビュー（旧 HORMUZ_VIEW 等）は regions.js の region.view に
// 移設した。ここには DEM を持たない汎用ビューだけを残す。
// フットプリントの計算式（幅 = Δλ·cos(centerLat)·worldScale 等）は
// regions.js の regionFootprint() を参照

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
