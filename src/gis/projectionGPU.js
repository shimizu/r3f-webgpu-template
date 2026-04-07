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
 * 座標リングの lon を連続的に正規化する。
 * 最初の頂点を centerLon 基準で正規化し、後続は前の頂点との差が ±180 以内になるよう調整。
 */
export function normalizeRing(ring, centerLon) {
  if (ring.length === 0) return ring

  const result = new Array(ring.length)
  let prevLon = normalizeLon(ring[0][0], centerLon)
  result[0] = [prevLon, ring[0][1]]

  for (let i = 1; i < ring.length; i += 1) {
    let delta = ring[i][0] - prevLon
    while (delta > 180) delta -= 360
    while (delta < -180) delta += 360
    const lon = prevLon + delta
    result[i] = [lon, ring[i][1]]
    prevLon = lon
  }

  return result
}

/**
 * リングを垂直線 (lon = boundary) でクリップする (Sutherland-Hodgman)。
 * side='left' は boundary 以上を残す、side='right' は boundary 以下を残す。
 */
function clipRingAgainstBoundary(ring, boundary, side) {
  if (ring.length === 0) return ring
  const output = []
  const isInside = (lon) => side === 'left' ? lon >= boundary : lon <= boundary

  for (let i = 0; i < ring.length; i += 1) {
    const curr = ring[i]
    const next = ring[(i + 1) % ring.length]
    const currIn = isInside(curr[0])
    const nextIn = isInside(next[0])

    if (currIn) output.push(curr)

    if (currIn !== nextIn) {
      const t = (boundary - curr[0]) / (next[0] - curr[0])
      const lat = curr[1] + (next[1] - curr[1]) * t
      output.push([boundary, lat])
    }
  }
  return output
}

/**
 * normalizeRing 済みのリング群を [minLon, maxLon] でクリップする。
 * はみ出した部分は ±360 シフトして反対側にも追加する。
 * 戻り値は earcut に渡せるリング群の配列（複数ポリゴンになりうる）。
 */
export function clipAndSplitRings(normalizedRings, centerLon) {
  const minLon = centerLon - 180
  const maxLon = centerLon + 180

  // メイン領域: [minLon, maxLon] にクリップ
  const mainRings = normalizedRings.map((ring) => {
    let clipped = clipRingAgainstBoundary(ring, minLon, 'left')
    clipped = clipRingAgainstBoundary(clipped, maxLon, 'right')
    return clipped
  }).filter((ring) => ring.length >= 3)

  // はみ出し部分: +360 シフトして [minLon, maxLon] にクリップ（左端に出現）
  const shiftedLeftRings = normalizedRings.map((ring) => {
    const shifted = ring.map((p) => [p[0] - 360, p[1]])
    let clipped = clipRingAgainstBoundary(shifted, minLon, 'left')
    clipped = clipRingAgainstBoundary(clipped, maxLon, 'right')
    return clipped
  }).filter((ring) => ring.length >= 3)

  // はみ出し部分: -360 シフトして [minLon, maxLon] にクリップ（右端に出現）
  const shiftedRightRings = normalizedRings.map((ring) => {
    const shifted = ring.map((p) => [p[0] + 360, p[1]])
    let clipped = clipRingAgainstBoundary(shifted, minLon, 'left')
    clipped = clipRingAgainstBoundary(clipped, maxLon, 'right')
    return clipped
  }).filter((ring) => ring.length >= 3)

  const result = []
  if (mainRings.length > 0) result.push(mainRings)
  if (shiftedLeftRings.length > 0) result.push(shiftedLeftRings)
  if (shiftedRightRings.length > 0) result.push(shiftedRightRings)
  return result
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
