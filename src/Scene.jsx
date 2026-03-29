import { OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'

import { createBarsComputeRunner } from './compute/runBarsCompute'

const INPUT_VALUES = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])

function BarsFromCompute() {
  const [values, setValues] = useState(() => Array.from(INPUT_VALUES))
  const [error, setError] = useState(null)
  const runnerRef = useRef(null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    mountedRef.current = true

    async function setupRunner() {
      let runner

      try {
        runner = await createBarsComputeRunner(INPUT_VALUES)

        if (cancelled) {
          runner.destroy()
          return
        }

        const initialValues = await runner.run(0)

        if (!cancelled) {
          runnerRef.current = runner
          setValues(initialValues)
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

    setupRunner()

    return () => {
      cancelled = true
      mountedRef.current = false
      runnerRef.current?.destroy()
      runnerRef.current = null
    }
  }, [])

  useFrame((state) => {
    const runner = runnerRef.current

    if (!runner || inFlightRef.current) {
      return
    }

    inFlightRef.current = true

    runner
      .run(state.clock.elapsedTime)
      .then((nextValues) => {
        if (mountedRef.current) {
          setValues(nextValues)
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
    <group>
      {values.map((value, index) => (
        <mesh
          key={index}
          position={[index - (values.length - 1) / 2, value / 4, 0]}
        >
          <boxGeometry args={[0.6, value / 2, 0.6]} />
          <meshNormalMaterial />
        </mesh>
      ))}
    </group>
  )
}

function Scene() {
  return (
    <>
      <color attach='background' args={['black']} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[3, 5, 4]} intensity={2} />
      <OrbitControls />
      <BarsFromCompute />
    </>
  )
}

export default Scene
