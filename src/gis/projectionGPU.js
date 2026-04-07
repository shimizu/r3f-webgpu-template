import { float, select, vec3 } from 'three/tsl'

const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

/**
 * lon を centerLon 基準で [-180, +180] の範囲に正規化する。
 * earcut 前処理用。GPU 側の wrappedLambda と同じ折り返し規約。
 *
 * @param {number} lon - 経度（度数法）
 * @param {number} centerLon - 中心経度（度数法）
 * @returns {number} 正規化された経度
 */
export function normalizeLon(lon, centerLon) {
  let offset = lon - centerLon
  while (offset > 180) offset -= 360
  while (offset < -180) offset += 360
  return offset + centerLon
}

/**
 * lon/lat の TSL ノードを受け取り、投影済みワールド座標の vec3 ノードを返す。
 * プロジェクト唯一の投影関数。
 *
 * @param {Node} lonNode - 経度（度数法）の TSL ノード
 * @param {Node} latNode - 緯度（度数法）の TSL ノード
 * @param {Object} uniforms - { centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode }
 * @returns {Node} vec3(worldX, worldY, 0)
 */
export function projectLonLatGPU(lonNode, latNode, uniforms) {
  const { centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode } = uniforms

  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()

  const wrappedPositive = select(
    lambda.greaterThan(float(PI)), lambda.sub(float(TAU)), lambda
  ).toVar()
  const wrappedLambda = select(
    wrappedPositive.lessThan(float(-PI)), wrappedPositive.add(float(TAU)), wrappedPositive
  ).toVar()

  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}
