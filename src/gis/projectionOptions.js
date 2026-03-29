export function resolveProjectionOptions(options = {}) {
  return {
    centerLon: options.centerLon ?? 0,
    centerLat: options.centerLat ?? 0,
    worldScale: options.worldScale ?? 1,
    altitudeScale: options.altitudeScale ?? 0,
    projectionType: options.projectionType ?? 'equirectangular',
    sampleLonStep: options.sampleLonStep ?? 0.2,
    sampleLatStep: options.sampleLatStep ?? 0.2,
  }
}
