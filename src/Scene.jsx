/* eslint-disable react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, useState } from 'react'
import { MOUSE } from 'three'

import BaseMapLayer from './layers/BaseMapLayer'
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'

const WORLD_VIEW = {
  centerLon: 0,
  centerLat: 0,
  worldScale: 4.6,
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
        <span>world map debug</span>
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
        minDistance={0.5}
        maxDistance={120}
        target={[0, 0, 0]}
        mouseButtons={{
          LEFT: MOUSE.PAN,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.ROTATE,
        }}
      />

      <PerformanceHud entityCount={entityCount} />
      <BaseMapLayer url='/data/world.geojson' view={WORLD_VIEW} />
      <MovingEntitiesLayer key={entityCount} entityCount={entityCount} view={WORLD_VIEW} />
    </>
  )
}

export default Scene
