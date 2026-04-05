/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { billboarding, instanceIndex } from 'three/tsl'

import { createRainComputeRunner } from '../compute/runRainCompute'

function RainLayer({
  position = [0, 0, 0],
  width = 15,
  depth = 13,
  topY = 8,
  particleCount = 30000,
  rainSpeed = 0.08,
  wind = [0.01, 0, 0.005],
  heightInfo = null,
}) {
  const renderer = useThree((state) => state.gl)
  const systemRef = useRef(null)

  const resources = useMemo(() => {
    const system = createRainComputeRunner({
      particleCount,
      areaWidth: width,
      areaDepth: depth,
      topY,
      rainSpeed,
      wind,
      heightData: heightInfo?.heights ?? null,
      heightCols: heightInfo?.cols ?? 0,
      heightRows: heightInfo?.rows ?? 0,
      terrainWidth: heightInfo?.terrainWidth ?? 0,
      terrainDepth: heightInfo?.terrainDepth ?? 0,
    })

    const geometry = new PlaneGeometry(0.005, 0.08)
    const material = new MeshBasicNodeMaterial({
      color: '#aaccff',
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      side: DoubleSide,
    })

    const mesh = new InstancedMesh(geometry, material, system.particleCount)
    const identityMatrix = new Matrix4()
    for (let i = 0; i < system.particleCount; i++) {
      mesh.setMatrixAt(i, identityMatrix)
    }

    material.vertexNode = billboarding({
      position: system.positionNode.element(instanceIndex),
      horizontal: true,
      vertical: true,
    })

    mesh.frustumCulled = false

    return { geometry, material, mesh, system }
  }, [particleCount, width, depth, topY, rainSpeed, wind, heightInfo])

  useEffect(() => {
    resources.system.init(renderer)
    systemRef.current = resources.system

    return () => {
      resources.system.destroy()
      resources.geometry.dispose()
      resources.material.dispose()
      systemRef.current = null
    }
  }, [renderer, resources])

  useFrame((state) => {
    if (!systemRef.current) return
    systemRef.current.update(
      renderer,
      state.clock.elapsedTime,
      state.clock.getDelta() || 1 / 60
    )
  })

  return <primitive object={resources.mesh} position={position} />
}

export default RainLayer
