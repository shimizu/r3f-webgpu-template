import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

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
      <Canvas
        shadows
        camera={{ position: [0, -22, 1.45], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        <Scene />
      </Canvas>
    </div>
  )
}

export default App
