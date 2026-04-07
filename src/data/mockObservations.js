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

export function createMockObservationBuffer(entityCount) {
  const rawObservationBuffer = new Float32Array(entityCount * OBSERVATION_STRIDE)

  for (let index = 0; index < entityCount; index += 1) {
    const baseIndex = index * OBSERVATION_STRIDE
    const isAircraft = index % 9 === 0
    // テスト用: 全エンティティが lon 180 → -180 に西進する
    const latBase = -90 + hash01(index * 0.17 + 2.1) * 180
    const prevLon = 180
    const lon = -180
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
