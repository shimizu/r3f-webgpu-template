import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  clamp,
  float,
  instanceIndex,
  int,
  mix,
  select,
  storage,
  uniform,
  vec3,
} from 'three/tsl'

import { resolveProjectionOptions } from '../gis/projectionOptions'
import { OBSERVATION_OFFSET, OBSERVATION_STRIDE } from './observationLayout'

const WORKGROUP_SIZE = 64
const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

function createProjectedNode(lonNode, latNode, worldScaleNode, centerLonNode, centerLatNode, cosCenterLatNode) {
  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()
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

  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}

export function createInterpolationPass(rawObservationBuffer, options = {}) {
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const projectionOptions = resolveProjectionOptions(options)
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

  const centerLonNode = uniform(projectionOptions.centerLon)
  const centerLatNode = uniform(projectionOptions.centerLat)
  const worldScaleNode = uniform(projectionOptions.worldScale)
  const playbackTimeNode = uniform(0)
  const loopDurationNode = uniform(options.loopDuration ?? 12)
  const cosCenterLatNode = uniform(
    Math.cos(projectionOptions.centerLat * DEG2RAD)
  )

  const computeNode = Fn(() => {
    const projectedPosition = projectedPositionNode.element(instanceIndex)
    const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()

    const prevLon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevLon)))
      .toVar()
    const prevLat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevLat)))
      .toVar()
    const lon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lon)))
      .toVar()
    const lat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lat)))
      .toVar()
    const prevTimestamp = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevTimestamp)))
      .toVar()
    const timestamp = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.timestamp)))
      .toVar()

    const normalizedPlayback = playbackTimeNode.div(loopDurationNode).toVar()
    const playbackTimestamp = mix(prevTimestamp, timestamp, normalizedPlayback).toVar()
    const timestampSpan = timestamp.sub(prevTimestamp).toVar()
    const blend = clamp(
      playbackTimestamp.sub(prevTimestamp).div(timestampSpan),
      float(0),
      float(1)
    ).toVar()

    const currentLon = mix(prevLon, lon, blend).toVar()
    const currentLat = mix(prevLat, lat, blend).toVar()
    const projected = createProjectedNode(
      currentLon,
      currentLat,
      worldScaleNode,
      centerLonNode,
      centerLatNode,
      cosCenterLatNode
    ).toVar()

    projectedPosition.assign(projected)
  })().compute(entityCount, [WORKGROUP_SIZE])

  return {
    entityCount,
    positionAttribute: projectedPositionAttribute,
    positionNode: projectedPositionNode,

    init(renderer) {
      renderer.compute(computeNode)
    },

    update(renderer, playbackTime, nextOptions = {}) {
      playbackTimeNode.value = playbackTime

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

      if (typeof nextOptions.loopDuration === 'number') {
        loopDurationNode.value = nextOptions.loopDuration
      }

      renderer.compute(computeNode)
    },

    destroy() {
      computeNode.dispose()
    },
  }
}
