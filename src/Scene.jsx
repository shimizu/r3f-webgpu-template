/* eslint-disable react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, useState } from 'react'

import MovingEntitiesLayer from './layers/MovingEntitiesLayer'

function PerformanceHud({ entityCount }) {
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
        <span>{entityCount.toLocaleString()} entities</span>
        <span>{fps} FPS</span>
        <span>projection gpu</span>
      </div>
    </Html>
  )
}

function Scene({ entityCount }) {
  return (
    <>
      <color attach='background' args={['#04070d']} />
      <fog attach='fog' args={['#04070d', 3.5, 9]} />

      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 5, 4]} intensity={1.25} color='#b5d8ff' />

      <gridHelper args={[8, 16, '#1b3a52', '#11202f']} position={[0, -0.01, 0]} />
      <OrbitControls
        enableDamping
        maxPolarAngle={Math.PI * 0.49}
        minDistance={0.6}
        maxDistance={8}
        target={[0, 0, 0]}
      />

      <PerformanceHud entityCount={entityCount} />
      <MovingEntitiesLayer key={entityCount} entityCount={entityCount} />
    </>
  )
}

export default Scene
