/* eslint-disable react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, useState } from 'react'

import BaseMapLayer from './layers/BaseMapLayer'

const JAPAN_VIEW = {
  centerLon: 138.46212811651623,
  centerLat: 34.86709218163738,
  worldScale: 28,
}

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
        <span>japan map debug</span>
      </div>
    </Html>
  )
}

function Scene({ entityCount }) {
  return (
    <>
      <color attach='background' args={['#04070d']} />

      <ambientLight intensity={0.55} />
      <directionalLight position={[8, 12, 10]} intensity={1.1} color='#b5d8ff' />

      <OrbitControls
        enableDamping
        maxPolarAngle={Math.PI * 0.495}
        minDistance={4}
        maxDistance={80}
        target={[0, 0, 0]}
      />

      <PerformanceHud entityCount={entityCount} />
      <BaseMapLayer url='/data/japan.geojson' view={JAPAN_VIEW} />
    </>
  )
}

export default Scene
