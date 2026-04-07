import { cos, float, log, select, sin, tan, vec3 } from 'three/tsl'

const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

/**
 * 経度を centerLon 基準で [-180, +180] の範囲に正規化します。
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
 * 座標リングの経度を連続的に正規化します。
 * 前の頂点との差が ±180 以内になるよう調整し、日付変更線での断裂を防ぎます。
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
 * リングを指定した垂直境界線 (lon = boundary) でクリップします (Sutherland-Hodgman アルゴリズム)。
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
 * 連続化されたリングを [minLon, maxLon] の範囲でクリップし、はみ出し部分を逆側に複製します。
 * これにより、地図を回転させた際に日付変更線をまたいでポリゴンが表示されます。
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

  // 左へはみ出した部分を +360 シフトしてメイン領域内（右端）に表示
  const shiftedLeftRings = normalizedRings.map((ring) => {
    const shifted = ring.map((p) => [p[0] - 360, p[1]])
    let clipped = clipRingAgainstBoundary(shifted, minLon, 'left')
    clipped = clipRingAgainstBoundary(clipped, maxLon, 'right')
    return clipped
  }).filter((ring) => ring.length >= 3)

  // 右へはみ出した部分を -360 シフトしてメイン領域内（左端）に表示
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

// ============================================================
// TSL (GPU) 側での地理計算
// ============================================================

/**
 * GPU 側で経度をラッピングし、緯度とともにラジアンへ変換します。
 */
function wrapLambdaAndPhi(lonNode, latNode, uniforms) {
  const { centerLonNode, centerLatNode } = uniforms

  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()

  const wrappedPositive = select(
    lambda.greaterThan(float(PI)), lambda.sub(float(TAU)), lambda
  ).toVar()
  const wrappedLambda = select(
    wrappedPositive.lessThan(float(-PI)), wrappedPositive.add(float(TAU)), wrappedPositive
  ).toVar()

  return { wrappedLambda, phi }
}

/** 
 * 等距円筒図法 (Equirectangular)
 * x = λ · cos(φ_0) · scale, y = φ · scale
 */
function equirectangularProjection(wrappedLambda, phi, uniforms) {
  const { worldScaleNode, cosCenterLatNode } = uniforms
  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}

/** 
 * メルカトル図法 (Mercator)
 * x = λ · scale, y = ln(tan(π/4 + φ/2)) · scale
 */
function mercatorProjection(wrappedLambda, phi, uniforms) {
  const { worldScaleNode, centerLatNode } = uniforms
  const centerLatRad = centerLatNode.mul(DEG2RAD)
  const y = log(tan(float(PI / 4).add(phi.add(centerLatRad).mul(0.5))))
    .sub(log(tan(float(PI / 4).add(centerLatRad.mul(0.5)))))
  return vec3(
    wrappedLambda.mul(worldScaleNode),
    y.mul(worldScaleNode),
    float(0)
  )
}

/** 
 * ランベルト正積円筒図法 (Lambert Cylindrical)
 * x = λ · cos(φ_0) · scale, y = sin(φ) · scale
 */
function lambertCylindricalProjection(wrappedLambda, phi, uniforms) {
  const { worldScaleNode, cosCenterLatNode, centerLatNode } = uniforms
  const centerLatRad = centerLatNode.mul(DEG2RAD)
  const y = sin(phi.add(centerLatRad)).sub(sin(centerLatRad))
  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    y.mul(worldScaleNode),
    float(0)
  )
}

/** 
 * Natural Earth I 図法
 * 多項式ベースの疑似円筒図法。d3-geo-projection の実装に準拠。
 */
function naturalEarthProjection(wrappedLambda, phi, uniforms) {
  const { worldScaleNode } = uniforms
  const phi2 = phi.mul(phi)
  const phi4 = phi2.mul(phi2)
  const phi6 = phi4.mul(phi2)
  const phi8 = phi4.mul(phi4)
  const phi12 = phi6.mul(phi6)

  // 多項式近似による X 座標計算
  const xScale = float(0.84719)
    .sub(phi2.mul(0.13063))
    .add(phi12.mul(
      float(-0.04515).add(phi2.mul(0.05494)).sub(phi4.mul(0.02326)).add(phi6.mul(0.00331))
    ))
  const x = wrappedLambda.mul(xScale)

  // 多項式近似による Y 座標計算
  const yScale = float(1.01183)
    .add(phi8.mul(
      float(-0.02625).add(phi2.mul(0.01926)).sub(phi4.mul(0.00396))
    ))
  const y = phi.mul(yScale)

  return vec3(
    x.mul(worldScaleNode),
    y.mul(worldScaleNode),
    float(0)
  )
}

const PROJECTIONS = {
  equirectangular: equirectangularProjection,
  mercator: mercatorProjection,
  'lambert-cylindrical': lambertCylindricalProjection,
  'natural-earth': naturalEarthProjection,
}

/**
 * 経度/緯度（lon/lat）の TSL ノードを受け取り、投影済みワールド座標の vec3 ノードを返します。
 * CPU 側（Geometry 生成時）と GPU 側（Shader 実行時）の両方で同じ計算式を共有するために設計されています。
 *
 * @param {Node} lonNode - 経度（度数法）の TSL ノード
 * @param {Node} latNode - 緯度（度数法）の TSL ノード
 * @param {Object} uniforms - 投影に使用する各種 Uniform（中心座標、スケールなど）
 * @param {string} [projectionType='equirectangular'] - 使用する図法名
 * @returns {Node} 投影後の位置（vec3）
 */
export function projectLonLatGPU(lonNode, latNode, uniforms, projectionType = 'equirectangular') {
  const { wrappedLambda, phi } = wrapLambdaAndPhi(lonNode, latNode, uniforms)
  const projectionFn = PROJECTIONS[projectionType] ?? equirectangularProjection
  return projectionFn(wrappedLambda, phi, uniforms)
}
