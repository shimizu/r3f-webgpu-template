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
      // GPU 実装同様、多項式は絶対緯度（φ + φ0）へ適用し、
      // 中心緯度の Y を差し引いて recenter する（d3-geo-projection の naturalEarth2Raw と同係数）
      const xScaleAt = (p) => {
        const p2 = p * p
        const p4 = p2 * p2
        const p6 = p4 * p2
        const p12 = p6 * p6
        return 0.84719 - p2 * 0.13063
          + p12 * (-0.04515 + p2 * 0.05494 - p4 * 0.02326 + p6 * 0.00331)
      }
      const yAt = (p) => {
        const p2 = p * p
        const p4 = p2 * p2
        const p8 = p4 * p4
        return p * (1.01183 + p8 * (-0.02625 + p2 * 0.01926 - p4 * 0.00396))
      }
      const phiAbs = phi + phi0
      return [
        lambda * xScaleAt(phiAbs) * worldScale,
        (yAt(phiAbs) - yAt(phi0)) * worldScale,
      ]
    }
    case 'equirectangular':
    default:
      return [lambda * Math.cos(phi0) * worldScale, phi * worldScale]
  }
}
