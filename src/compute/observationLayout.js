export const OBSERVATION_STRIDE = 12

export const OBSERVATION_OFFSET = {
  lon: 0,
  lat: 1,
  alt: 2,
  timestamp: 3,
  prevLon: 4,
  prevLat: 5,
  prevAlt: 6,
  prevTimestamp: 7,
  speed: 8,
  heading: 9,
  type: 10,
  status: 11,
}

export const ENTITY_TYPE = {
  vessel: 1,
  aircraft: 2,
}

export const ENTITY_STATUS = {
  cruising: 1,
  approach: 2,
}
