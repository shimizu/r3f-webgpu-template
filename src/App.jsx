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
    <Canvas
      camera={{ position: [1.6, 1.2, 2.2], fov: 50 }}
      gl={createRenderer}
    >
      <Scene />
    </Canvas>
  )
}

export default App
