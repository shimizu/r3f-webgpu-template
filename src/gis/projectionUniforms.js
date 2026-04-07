import { uniform } from 'three/tsl'
import { resolveProjectionOptions } from './projectionOptions'

const DEG2RAD = Math.PI / 180

/**
 * 投影パラメータから TSL uniform セットを生成する。
 * 各レイヤー/pass が独立にインスタンスを生成・保持する。
 */
export function createProjectionUniforms(options = {}) {
  const resolved = resolveProjectionOptions(options)

  const centerLonNode = uniform(resolved.centerLon)
  const centerLatNode = uniform(resolved.centerLat)
  const worldScaleNode = uniform(resolved.worldScale)
  const cosCenterLatNode = uniform(Math.cos(resolved.centerLat * DEG2RAD))

  return {
    centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode,
    projectionType: resolved.projectionType,

    update(nextOptions) {
      if (typeof nextOptions.centerLon === 'number') {
        centerLonNode.value = nextOptions.centerLon
      }
      if (typeof nextOptions.centerLat === 'number') {
        centerLatNode.value = nextOptions.centerLat
        cosCenterLatNode.value = Math.cos(nextOptions.centerLat * DEG2RAD)
      }
      if (typeof nextOptions.worldScale === 'number') {
        worldScaleNode.value = nextOptions.worldScale
      }
    },
  }
}
