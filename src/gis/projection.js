const DEG2RAD = Math.PI / 180
const TAU = Math.PI * 2

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
  const lambda = wrapLongitudeRadians((lon - view.centerLon) * DEG2RAD)
  const phi = (lat - view.centerLat) * DEG2RAD
  const worldX = lambda * Math.cos(view.centerLat * DEG2RAD) * view.worldScale
  const worldZ = phi * view.worldScale

  return [worldX, 0, worldZ]
}
