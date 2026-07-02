const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

/**
 * projectLonLatGPU (projectionGPU.js) と同一数式の CPU 数値版。
 * ジオメトリ生成時に投影座標を焼き込む用途（TerrainLayer 等）で使い、
 * GPU 側で投影するレイヤー（GeojsonLayer 等）と結果が一致することを保証する。
 * 式・係数を変更する場合は projectionGPU.js と必ず同時に更新すること。
 *
 * @param {number} lon - 経度（度数法）
 * @param {number} lat - 緯度（度数法）
 * @param {Object} options - { centerLon, centerLat, worldScale, projectionType }
 * @returns {[number, number]} 投影平面上の [x, y]（x=東+, y=北+）
 */
export function projectLonLatCPU(lon, lat, options) {
  const {
    centerLon = 0,
    centerLat = 0,
    worldScale = 1,
    projectionType = 'equirectangular',
  } = options

  // wrapLambdaAndPhi と同じ single-step ラップ
  let lambda = (lon - centerLon) * DEG2RAD
  if (lambda > PI) lambda -= TAU
  if (lambda < -PI) lambda += TAU
  const phi = (lat - centerLat) * DEG2RAD
  const phi0 = centerLat * DEG2RAD

  switch (projectionType) {
    case 'mercator':
      return [
        lambda * worldScale,
        (Math.log(Math.tan(PI / 4 + (phi + phi0) * 0.5))
          - Math.log(Math.tan(PI / 4 + phi0 * 0.5))) * worldScale,
      ]
    case 'lambert-cylindrical':
      return [
        lambda * Math.cos(phi0) * worldScale,
        (Math.sin(phi + phi0) - Math.sin(phi0)) * worldScale,
      ]
    case 'natural-earth': {
      // GPU 実装同様、centerLat からの相対 φ に多項式を適用する
      const phi2 = phi * phi
      const phi4 = phi2 * phi2
      const phi6 = phi4 * phi2
      const phi8 = phi4 * phi4
      const phi12 = phi6 * phi6
      const xScale = 0.84719 - phi2 * 0.13063
        + phi12 * (-0.04515 + phi2 * 0.05494 - phi4 * 0.02326 + phi6 * 0.00331)
      const yScale = 1.01183
        + phi8 * (-0.02625 + phi2 * 0.01926 - phi4 * 0.00396)
      return [lambda * xScale * worldScale, phi * yScale * worldScale]
    }
    case 'equirectangular':
    default:
      return [lambda * Math.cos(phi0) * worldScale, phi * worldScale]
  }
}
