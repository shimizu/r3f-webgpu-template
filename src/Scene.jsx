/* eslint-disable react/no-unknown-property, react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, useState } from 'react'

import { TOKYO_BAY_VIEW } from './data/mockObservations'
import { projectLonLatToWorld } from './gis/projection'
import BaseMapLayer from './layers/BaseMapLayer'

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
  const projectedDebugPoint = useMemo(() => {
    return projectLonLatToWorld([139.8725839, 35.57727], TOKYO_BAY_VIEW)
  }, [])

  return (
    <>
      <color attach='background' args={['#04070d']} />

      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 5, 4]} intensity={1.25} color='#b5d8ff' />

      <gridHelper args={[8, 16, '#1b3a52', '#11202f']} position={[0, -0.01, 0]} />
      <mesh position={[0, 0.16, 0]}>
        <boxGeometry args={[0.32, 0.32, 0.32]} />
        <meshStandardMaterial color='#ff8a5b' roughness={0.35} metalness={0.05} />
      </mesh>
      <mesh position={[projectedDebugPoint[0], 0.1, projectedDebugPoint[2]]}>
        <boxGeometry args={[0.18, 0.18, 0.18]} />
        <meshStandardMaterial color='#00ffa6' roughness={0.3} metalness={0.02} />
      </mesh>
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach='attributes-position'
            args={[new Float32Array([-1.2, 0.02, 0, 1.2, 0.02, 0]), 3]}
            count={2}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color='#9fe7ff' linewidth={2} />
      </line>
      <OrbitControls
        enableDamping
        maxPolarAngle={Math.PI * 0.495}
        minDistance={0.6}
        maxDistance={220}
        target={[0, 0, 0]}
      />

      <PerformanceHud entityCount={entityCount} />
      <BaseMapLayer url='/data/japan.geojson' view={TOKYO_BAY_VIEW} />
    </>
  )
}

export default Scene
