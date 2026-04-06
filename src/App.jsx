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
  const { rainEnabled } = useControls('Rain', { rainEnabled: true })

  return (
    <div className='app-shell'>
      <FpsStats />
      <Canvas
        shadows

        camera={{ position: [0, 8, -25], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        <Scene rainEnabled={rainEnabled} />
      </Canvas>
    </div>
  )
}

export default App
