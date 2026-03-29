import { StorageBufferAttribute } from 'three/webgpu'
import { Fn, float, instanceIndex, int, select, storage, uniform, vec3 } from 'three/tsl'

import { OBSERVATION_OFFSET, OBSERVATION_STRIDE } from './observationLayout'

const WORKGROUP_SIZE = 64
const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

export function createProjectionPass(rawObservationBuffer, options = {}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const entityCount = rawObservationBuffer.length / OBSERVATION_STRIDE
  const rawObservationAttribute = new StorageBufferAttribute(rawObservationBuffer, 1)
  const projectedPositionAttribute = new StorageBufferAttribute(
    new Float32Array(entityCount * 3),
    3
  )

  const rawObservationNode = storage(
    rawObservationAttribute,
    'float',
    rawObservationBuffer.length
  ).toReadOnly()
  const projectedPositionNode = storage(
    projectedPositionAttribute,
    'vec3',
    entityCount
  )

  const centerLonNode = uniform(options.centerLon ?? 139.82)
  const centerLatNode = uniform(options.centerLat ?? 35.54)
  const worldScaleNode = uniform(options.worldScale ?? 18)
  const altitudeScaleNode = uniform(options.altitudeScale ?? 0.00035)
  const cosCenterLatNode = uniform(
    Math.cos((options.centerLat ?? 35.54) * DEG2RAD)
  )

  const computeNode = Fn(() => {
    const projectedPosition = projectedPositionNode.element(instanceIndex)
    const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()
    const lon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lon)))
      .toVar()
    const lat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lat)))
      .toVar()
    const alt = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.alt)))
      .toVar()

    const lambda = lon.sub(centerLonNode).mul(DEG2RAD).toVar()
    const phi = lat.sub(centerLatNode).mul(DEG2RAD).toVar()
    const wrappedPositive = select(
      lambda.greaterThan(float(PI)),
      lambda.sub(float(TAU)),
      lambda
    ).toVar()
    const wrappedLambda = select(
      wrappedPositive.lessThan(float(-PI)),
      wrappedPositive.add(float(TAU)),
      wrappedPositive
    ).toVar()

    // 初期段階は局所 equirectangular で十分。
    const worldX = wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode)
    const worldY = alt.mul(altitudeScaleNode)
    const worldZ = phi.mul(worldScaleNode)

    projectedPosition.assign(vec3(worldX, worldY, worldZ))
  })().compute(entityCount, [WORKGROUP_SIZE])

  return {
    entityCount,
    positionAttribute: projectedPositionAttribute,
    positionNode: projectedPositionNode,

    init(renderer) {
      renderer.compute(computeNode)
    },

    updateProjection(renderer, nextOptions = {}) {
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

      if (typeof nextOptions.altitudeScale === 'number') {
        altitudeScaleNode.value = nextOptions.altitudeScale
      }

      renderer.compute(computeNode)
    },

    destroy() {
      computeNode.dispose()
    },
  }
}
