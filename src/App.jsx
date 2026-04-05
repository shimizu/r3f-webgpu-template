import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

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
  return (
    <div className='app-shell'>
      <FpsStats />
      <Canvas
        shadows

        camera={{ position: [0, 8, 25], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        <Scene />
      </Canvas>
    </div>
  )
}

export default App
