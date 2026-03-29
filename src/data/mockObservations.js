import {
  ENTITY_STATUS,
  ENTITY_TYPE,
  OBSERVATION_OFFSET,
  OBSERVATION_STRIDE,
} from '../compute/observationLayout'

const TOKYO_BAY_VIEW = {
  centerLon: 139.82,
  centerLat: 35.54,
  worldScale: 900,
  altitudeScale: 0.00002,
  extentLon: 0.45,
  extentLat: 0.35,
  sampleLonStep: 0.02,
  sampleLatStep: 0.02,
}

export { TOKYO_BAY_VIEW }

const TOKYO_BAY_BOUNDS = {
  minLon: 139.68,
  maxLon: 140.02,
  minLat: 35.42,
  maxLat: 35.68,
}

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function createMockObservationBuffer(entityCount) {
  const rawObservationBuffer = new Float32Array(entityCount * OBSERVATION_STRIDE)

  for (let index = 0; index < entityCount; index += 1) {
    const baseIndex = index * OBSERVATION_STRIDE
    const isAircraft = index % 9 === 0
    const lane = hash01(index * 0.17 + 2.1)
    const progress = hash01(index * 0.37 + 7.9)
    const drift = (hash01(index * 0.61 + 1.4) - 0.5) * 0.015
    const lonSpan = TOKYO_BAY_BOUNDS.maxLon - TOKYO_BAY_BOUNDS.minLon
    const latSpan = TOKYO_BAY_BOUNDS.maxLat - TOKYO_BAY_BOUNDS.minLat
    const lonBase = TOKYO_BAY_BOUNDS.minLon + lonSpan * progress
    const latBase = TOKYO_BAY_BOUNDS.minLat + latSpan * lane
    const prevLon = lonBase - (isAircraft ? 0.014 : 0.005)
    const prevLat = latBase + drift
    const lon = lonBase + (isAircraft ? 0.006 : 0.002)
    const lat = latBase + drift * 1.2
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
    view: TOKYO_BAY_VIEW,
  }
}
