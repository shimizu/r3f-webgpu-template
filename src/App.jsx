import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'
import { useControls } from 'leva'

import FpsStats from './FpsStats'
import Scene from './Scene'
import './App.css'


async function createRenderer(props) {
  const renderer = new WebGPURenderer({
    canvas: props.canvas,
    antialias: true,
    alpha: true,
  })

  await renderer.init()
  return renderer
}

function App() {
  const { entityCount } = useControls('GIS', {
    entityCount: { value: 2000, min: 100, max: 50000, step: 100 },
  })

  return (
    <div className='app-shell'>
      <FpsStats />
      <Canvas
        shadows
        camera={{ position: [0, 14, -18], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        <Scene entityCount={entityCount} />
      </Canvas>
    </div>
  )
}

export default App
