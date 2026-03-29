const DEG2RAD = Math.PI / 180
const TAU = Math.PI * 2

import { resolveProjectionOptions } from './projectionOptions'

export function wrapLongitudeRadians(lambda) {
  if (lambda > Math.PI) {
    return lambda - TAU
  }

  if (lambda < -Math.PI) {
    return lambda + TAU
  }

  return lambda
}

export function projectLonLatToWorld([lon, lat], view) {
  const options = resolveProjectionOptions(view)
  const lambda = wrapLongitudeRadians((lon - options.centerLon) * DEG2RAD)
  const phi = (lat - options.centerLat) * DEG2RAD
  const worldX = lambda * Math.cos(options.centerLat * DEG2RAD) * options.worldScale
  const worldY = phi * options.worldScale

  return [worldX, worldY, 0]
}
