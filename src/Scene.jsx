/* eslint-disable react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'

import { createBarsComputeRunner } from './compute/runBarsCompute'

function createParticleSeed(gridSize, spacing) {
  const particleCount = gridSize * gridSize
  const positions = new Float32Array(particleCount * 3)
  const half = (gridSize - 1) / 2

  for (let z = 0; z < gridSize; z += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const index = z * gridSize + x
      const baseIndex = index * 3

      positions[baseIndex] = (x - half) * spacing
      positions[baseIndex + 1] = 0
      positions[baseIndex + 2] = (z - half) * spacing
    }
  }

  return positions
}

function PerformanceHud({ particleCount }) {
  const [fps, setFps] = useState(0)
  const sampleRef = useRef({
    frames: 0,
    elapsed: 0,
  })

  useFrame((_, delta) => {
    sampleRef.current.frames += 1
    sampleRef.current.elapsed += delta

    if (sampleRef.current.elapsed >= 0.25) {
      setFps(Math.round(sampleRef.current.frames / sampleRef.current.elapsed))
      sampleRef.current.frames = 0
      sampleRef.current.elapsed = 0
    }
  })

  return (
    <Html prepend>
      <div className='stats-panel'>
        <span>{particleCount.toLocaleString()} particles</span>
        <span>{fps} FPS</span>
      </div>
    </Html>
  )
}

function ParticlesFromCompute({ gridSize }) {
  const [error, setError] = useState(null)
  const geometryRef = useRef(null)
  const positionAttributeRef = useRef(null)
  const runnerRef = useRef(null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(false)

  const { particleSeed, particleSize } = useMemo(() => {
    const spacing = Math.max(0.045, 5 / gridSize)

    return {
      particleSeed: createParticleSeed(gridSize, spacing),
      particleSize: Math.max(0.018, spacing * 0.38),
    }
  }, [gridSize])

  useEffect(() => {
    let cancelled = false
    mountedRef.current = true

    const positionAttribute = positionAttributeRef.current
    positionAttribute.array = particleSeed.slice()
    positionAttribute.count = particleSeed.length / 3
    positionAttribute.needsUpdate = true
    geometryRef.current.computeBoundingSphere()

    async function setupRunner() {
      let runner

      try {
        runner = await createBarsComputeRunner(particleSeed)

        if (cancelled) {
          runner.destroy()
          return
        }

        const initialPositions = await runner.run(0)

        if (!cancelled) {
          runnerRef.current = runner
          positionAttribute.array = initialPositions
          positionAttribute.count = initialPositions.length / 3
          positionAttribute.needsUpdate = true
          geometryRef.current.computeBoundingSphere()
        }
      } catch (computeError) {
        runner?.destroy()

        if (!cancelled) {
          setError(
            computeError instanceof Error
              ? computeError.message
              : 'compute 実行中に不明なエラーが発生しました'
          )
        }
      }
    }

    runnerRef.current?.destroy()
    runnerRef.current = null
    inFlightRef.current = false
    setupRunner()

    return () => {
      cancelled = true
      mountedRef.current = false
      runnerRef.current?.destroy()
      runnerRef.current = null
      inFlightRef.current = false
    }
  }, [gridSize, particleSeed])

  useFrame((state) => {
    const runner = runnerRef.current

    if (!runner || inFlightRef.current) {
      return
    }

    inFlightRef.current = true

    runner
      .run(state.clock.elapsedTime)
      .then((nextPositions) => {
        if (mountedRef.current) {
          const positionAttribute = positionAttributeRef.current
          positionAttribute.array = nextPositions
          positionAttribute.count = nextPositions.length / 3
          positionAttribute.needsUpdate = true
          geometryRef.current.computeBoundingSphere()
        }
      })
      .catch((computeError) => {
        if (mountedRef.current) {
          setError(
            computeError instanceof Error
              ? computeError.message
              : 'compute 実行中に不明なエラーが発生しました'
          )
        }
      })
      .finally(() => {
        inFlightRef.current = false
      })
  })

  if (error) {
    console.error(error)
    return null
  }

  return (
    <points>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute
          ref={positionAttributeRef}
          attach='attributes-position'
          args={[particleSeed, 3]}
        />
      </bufferGeometry>
      <pointsMaterial color='#8fe3ff' size={particleSize} />
    </points>
  )
}

function Scene({ gridSize }) {
  const particleCount = gridSize * gridSize

  return (
    <>
      <color attach='background' args={['#04070d']} />
      <fog attach='fog' args={['#04070d', 3.5, 8]} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 4]} intensity={1.5} color='#b5d8ff' />
      <gridHelper args={[8, 16, '#1b3a52', '#11202f']} position={[0, -0.35, 0]} />
      <OrbitControls enableDamping />
      <PerformanceHud particleCount={particleCount} />
      <ParticlesFromCompute key={gridSize} gridSize={gridSize} />
    </>
  )
}

export default Scene
