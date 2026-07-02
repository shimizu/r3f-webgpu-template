import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

import FpsStats from './FpsStats'
import Scene from './Scene'
import './App.css'

/**
 * Three.js の WebGPURenderer を初期化する非同期関数。
 * React Three Fiber (R3F) の Canvas コンポーネントに渡して使用します。
 * 
 * @param {Object} props - Canvas から渡されるプロパティ（canvas 要素など）
 * @returns {Promise<WebGPURenderer>} 初期化済みのレンダラー
 */
async function createRenderer(props) {
  const renderer = new WebGPURenderer({
    canvas: props.canvas,
    antialias: true,
    alpha: true,
  })

  await renderer.init()
  return renderer
}

/**
 * WebGPU 非対応環境向けのフォールバック表示。
 * このテンプレートは WebGPU 必須（compute shader / TSL を多用）のため、
 * WebGL への自動フォールバックは行わず、明示的にメッセージを出す。
 */
function WebGPUNotSupported() {
  return (
    <div className='app-fallback'>
      <div>
        <h1>WebGPU に対応していない環境です</h1>
        <p>
          このアプリは WebGPU が必要です。
          最新の Chrome / Edge、または WebGPU を有効化したブラウザでアクセスしてください。
        </p>
      </div>
    </div>
  )
}

/**
 * アプリケーションのルートコンポーネント。
 * R3F の Canvas を配置し、WebGPU レンダラーの設定とカメラの初期位置を定義します。
 */
function App() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return <WebGPUNotSupported />
  }

  return (
    <div className='app-shell'>
      {/* フレームレート統計表示 */}
      <FpsStats />
      
      {/* 3D シーンの土台となる Canvas */}
      <Canvas
        shadows
        camera={{ position: [0, 15, -20], fov: 36, near: 0.01, far: 500 }}
        gl={createRenderer}
      >
        {/* シーンの構成要素（ライト、環境、各レイヤー） */}
        <Scene />
      </Canvas>
    </div>
  )
}

export default App
