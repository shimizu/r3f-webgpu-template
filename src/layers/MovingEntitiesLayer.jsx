/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { billboarding, float, instanceIndex, shapeCircle, vec3 } from 'three/tsl'

import { createInterpolationPass } from '../compute/createInterpolationPass'
import {
  ENTITY_TYPE,
  OBSERVATION_OFFSET,
  OBSERVATION_STRIDE,
} from '../compute/observationLayout'
import { createMockObservationBuffer } from '../data/mockObservations'

const ENTITY_SIZE = 0.017
const LOOP_DURATION = 6

function getEntityColor(rawObservationBuffer, index) {
  const type = rawObservationBuffer[index * OBSERVATION_STRIDE + OBSERVATION_OFFSET.type]

  return type === ENTITY_TYPE.aircraft
    ? new Color('#ffd166')
    : new Color('#66d9ff')
}

function MovingEntitiesLayer({ entityCount, view }) {
  const renderer = useThree((state) => state.gl)
  const systemRef = useRef(null)
  const dataset = useMemo(() => createMockObservationBuffer(entityCount), [entityCount])

  const { resourceError, resources } = useMemo(() => {
    try {
      const system = createInterpolationPass(dataset.rawObservationBuffer, {
        ...view,
        loopDuration: LOOP_DURATION,
      })
      const geometry = new PlaneGeometry(ENTITY_SIZE, ENTITY_SIZE, 1, 1)
      const material = new MeshBasicNodeMaterial({
        color: '#ffffff',
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      })
      const mesh = new InstancedMesh(geometry, material, system.entityCount)
      const identityMatrix = new Matrix4()

      for (let index = 0; index < system.entityCount; index += 1) {
        mesh.setMatrixAt(index, identityMatrix)
        mesh.setColorAt(index, getEntityColor(dataset.rawObservationBuffer, index))
      }

      // compute shader は XY 平面 vec3(x, y, 0) で出力するが、
      // シーンは Y-up なので XZ 平面に変換する（billboarding は親 group の回転を無視するため）
      const rawPos = system.positionNode.element(instanceIndex)
      const xzPos = vec3(rawPos.x, float(0), rawPos.y.negate())
      material.vertexNode = billboarding({
        position: xzPos,
        horizontal: true,
        vertical: true,
      })
      material.opacityNode = shapeCircle()
      material.alphaTest = 0.5
      mesh.frustumCulled = false

      return {
        resourceError: null,
        resources: { geometry, material, mesh, system },
      }
    } catch (projectionError) {
      return {
        resourceError:
          projectionError instanceof Error
            ? projectionError.message
            : 'projection pass の初期化に失敗しました',
        resources: null,
      }
    }
  }, [dataset, view])

  useEffect(() => {
    if (!resources) {
      return undefined
    }

    try {
      resources.system.init(renderer)
      systemRef.current = resources.system
    } catch (projectionError) {
      console.error(
        projectionError instanceof Error
          ? projectionError.message
          : 'projection pass の実行に失敗しました'
      )
    }

    return () => {
      resources.geometry.dispose()
      resources.material.dispose()
      resources.system.destroy()
      systemRef.current = null
    }
  }, [renderer, resources])

  useFrame((state) => {
    const system = systemRef.current

    if (!system) {
      return
    }

    const playbackTime = state.clock.elapsedTime % LOOP_DURATION
    system.update(renderer, playbackTime, {
      ...view,
      loopDuration: LOOP_DURATION,
    })
  })

  if (resourceError) {
    console.error(resourceError)
    return null
  }

  return <primitive object={resources.mesh} />
}

export default MovingEntitiesLayer
