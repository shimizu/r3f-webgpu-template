import { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

import Scene from './Scene'
import './App.css'

const ENTITY_PRESETS = [1000, 10000, 50000, 100000, 500000, 1000000]

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
  const [entityCount, setEntityCount] = useState(ENTITY_PRESETS[1])

  return (
    <div className='app-shell'>
      <div className='control-panel'>
        <p className='control-title'>GPU First GIS</p>
        <p className='control-copy'>
          まずはジオラマとして成立する舞台を作り、その上に地図と GPU レイヤーを重ねていく実験。
        </p>
        <div className='control-grid'>
          {ENTITY_PRESETS.map((count) => {
            return (
              <button
                key={count}
                className={count === entityCount ? 'control-button is-active' : 'control-button'}
                onClick={() => setEntityCount(count)}
                type='button'
              >
                {count.toLocaleString()}
              </button>
            )
          })}
        </div>
        <p className='control-caption'>phase 0: diorama stage + projection</p>
      </div>

      <Canvas
        shadows
        camera={{ position: [0, -10, 18], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        <Scene entityCount={entityCount} />
      </Canvas>
    </div>
  )
}

export default App
