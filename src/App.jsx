import { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

import Scene from './Scene'
import './App.css'

const GRID_PRESETS = [26, 40, 64, 96, 128]

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
  const [gridSize, setGridSize] = useState(64)

  return (
    <div className='app-shell'>
      <div className='control-panel'>
        <p className='control-title'>Particle Stress Test</p>
        <p className='control-copy'>
          粒子数を切り替えて、FPS がどこで落ち始めるか確認します。
        </p>
        <div className='control-grid'>
          {GRID_PRESETS.map((size) => {
            const particleCount = size * size

            return (
              <button
                key={size}
                className={size === gridSize ? 'control-button is-active' : 'control-button'}
                onClick={() => setGridSize(size)}
                type='button'
              >
                {particleCount.toLocaleString()}
              </button>
            )
          })}
        </div>
      </div>

      <Canvas
        camera={{ position: [1.6, 1.2, 2.2], fov: 50 }}
        gl={createRenderer}
      >
        <Scene gridSize={gridSize} />
      </Canvas>
    </div>
  )
}

export default App
