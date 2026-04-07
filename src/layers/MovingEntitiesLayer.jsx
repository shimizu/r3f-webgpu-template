/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, Matrix4 } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { cos, float, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl'

import { createInterpolationPass } from '../compute/createInterpolationPass'
import {
  ENTITY_TYPE,
  OBSERVATION_OFFSET,
  OBSERVATION_STRIDE,
} from '../compute/observationLayout'
import { createMockObservationBuffer } from '../data/mockObservations'

const ENTITY_SIZE = 0.017
const LOOP_DURATION = 6
const ENTITY_COLORS = { aircraft: '#ffd166', default: '#66d9ff' }
const ENTITY_MATERIAL = { color: '#ffffff' }

function getEntityColor(rawObservationBuffer, index) {
  const type = rawObservationBuffer[index * OBSERVATION_STRIDE + OBSERVATION_OFFSET.type]

  return type === ENTITY_TYPE.aircraft
    ? new Color(ENTITY_COLORS.aircraft)
    : new Color(ENTITY_COLORS.default)
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
      // 進行方向を示す三角形（XY 平面、+Y が前方。親 group で XZ に回転される）
      const s = ENTITY_SIZE
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute([
        0, s, 0,               // 先端
        -s * 0.5, -s * 0.5, 0, // 左後方
        s * 0.5, -s * 0.5, 0,  // 右後方
      ], 3))
      const material = new MeshBasicNodeMaterial({
        color: ENTITY_MATERIAL.color,
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

      // compute shader は XY 平面 vec3(x, y, 0) で出力する。
      // XY→XZ 変換は親 group の rotation に任せ、ここでは XY 平面のまま配置する。
      const rawPos = system.positionNode.element(instanceIndex)
      const heading = system.headingNode.element(instanceIndex)
      const cosH = cos(heading)
      const sinH = sin(heading)

      // ローカル頂点を heading で回転（XY 平面上）
      const lx = positionLocal.x
      const ly = positionLocal.y
      const rotatedX = lx.mul(cosH).sub(ly.mul(sinH))
      const rotatedY = lx.mul(sinH).add(ly.mul(cosH))

      material.positionNode = vec3(
        rotatedX.add(rawPos.x),
        rotatedY.add(rawPos.y),
        float(0)
      )
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
