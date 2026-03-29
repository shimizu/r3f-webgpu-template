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
    const lonBase = -180 + hash01(index * 0.37 + 7.9) * 360
    const latBase = -90 + hash01(index * 0.17 + 2.1) * 180
    const lonDelta = (hash01(index * 0.61 + 1.4) - 0.5) * (isAircraft ? 1.8 : 0.6)
    const latDelta = (hash01(index * 0.49 + 9.2) - 0.5) * (isAircraft ? 0.9 : 0.3)
    const prevLon = Math.max(-180, Math.min(180, lonBase - lonDelta))
    const prevLat = Math.max(-90, Math.min(90, latBase - latDelta))
    const lon = Math.max(-180, Math.min(180, lonBase + lonDelta))
    const lat = Math.max(-90, Math.min(90, latBase + latDelta))
    const alt = isAircraft ? 2800 + hash01(index * 0.43 + 4.2) * 9000 : 0
    const prevAlt = isAircraft ? alt - 180 : 0
    const speed = isAircraft ? 210 + hash01(index * 0.83 + 4.7) * 90 : 9 + hash01(index * 0.71 + 5.4) * 14
    const heading = isAircraft ? 55 + hash01(index * 0.93 + 8.2) * 40 : 25 + hash01(index * 1.13 + 6.8) * 30

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
