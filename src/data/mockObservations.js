import {
  ENTITY_STATUS,
  ENTITY_TYPE,
  OBSERVATION_OFFSET,
  OBSERVATION_STRIDE,
} from '../compute/observationLayout'

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/**
 * 開発用のモック観測バッファを生成する。
 *
 * @param {number} entityCount - 生成するエンティティ数
 * @param {Object|null} region - 生成域。指定するとその bbox 内に散らばるローカルデータになる。
 *   { lonMin, lonMax, latMin, latMax, lonDrift = -2 }（lonDrift: 負で西進、単位は度）
 *   省略時は日付変更線またぎの全球テストデータ（lon -170 → 170 西進）
 */
export function createMockObservationBuffer(entityCount, region = null) {
  const rawObservationBuffer = new Float32Array(entityCount * OBSERVATION_STRIDE)

  for (let index = 0; index < entityCount; index += 1) {
    const baseIndex = index * OBSERVATION_STRIDE
    const isAircraft = index % 9 === 0

    let prevLon
    let lon
    let latBase
    if (region) {
      // region 内に一様分布させ、lonDrift 度だけ移動させる
      prevLon = region.lonMin + hash01(index * 0.31 + 1.7) * (region.lonMax - region.lonMin)
      lon = prevLon + (region.lonDrift ?? -2)
      latBase = region.latMin + hash01(index * 0.17 + 2.1) * (region.latMax - region.latMin)
    } else {
      // テスト用: 全エンティティが lon -170 → 170 へ日付変更線をまたいで西進する
      // （補間パスの Δlon ±180° 正規化により、0° 経由ではなく 180° 経由の最短経路になる）
      prevLon = -170
      lon = 170
      latBase = -90 + hash01(index * 0.17 + 2.1) * 180
    }
    const prevLat = latBase
    const lat = latBase
    const alt = isAircraft ? 2800 + hash01(index * 0.43 + 4.2) * 9000 : 0
    const prevAlt = isAircraft ? alt - 180 : 0
    const speed = isAircraft ? 250 : 15
    const heading = 270  // 西向き

    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lon] = lon
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lat] = lat
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.alt] = alt
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.timestamp] = 60
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLon] = prevLon
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLat] = prevLat
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevAlt] = prevAlt
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevTimestamp] = 0
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.speed] = speed
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.heading] = heading
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.type] = isAircraft
      ? ENTITY_TYPE.aircraft
      : ENTITY_TYPE.vessel
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.status] = isAircraft
      ? ENTITY_STATUS.approach
      : ENTITY_STATUS.cruising
  }

  return {
    entityCount,
    rawObservationBuffer,
  }
}
