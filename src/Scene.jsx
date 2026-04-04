/* eslint-disable react/prop-types */
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRef, useState } from 'react'
import { MOUSE } from 'three'

import LightingRig from './LightingRig'
import ExtrudedGridLayer from './layers/ExtrudedGridLayer'
import StageLayer from './layers/StageLayer'

/*
  このファイルの処理の流れ

  1. Scene が 3D シーン全体の見た目を組み立てる
     背景色、ライト、カメラ操作、HUD、地図レイヤー、移動体レイヤーを
     1 つの React コンポーネントとして並べている。

  2. PerformanceHud が毎フレーム FPS を計測する
     useFrame で delta を積算し、一定間隔ごとに FPS を再計算して
     HTML オーバーレイとして画面左上へ表示する。

  3. OrbitControls がカメラ操作を担当する
     左ドラッグで平行移動、右ドラッグで回転、ホイールでズームできるようにして、
     地図を観察しやすい操作感を用意している。

  4. BaseMapLayer が背景地図を描画する
     GeoJSON をもとに海岸線を表示し、移動体の位置関係を確認できる土台を作る。

  5. MovingEntitiesLayer が GPU 計算済みの移動体を描画する
     entityCount に応じたデータを使い、補間・投影済みの位置へ billboard を並べる。

  つまり Scene.jsx は、
  「シーンの見た目と操作を定義する」
  「デバッグ HUD を重ねる」
  「背景地図と移動体レイヤーを同時に表示する」
  という画面構成の入口になっている。
*/

// 画面左上に重ねる簡易 HUD。
// Three.js の描画ループに合わせてフレーム数を数え、一定間隔ごとに FPS を更新する。
function PerformanceHud({ entityCount }) {
  const [fps, setFps] = useState(0)
  const sampleRef = useRef({
    frames: 0,
    elapsed: 0,
  })

  // 毎フレーム呼ばれる hook。
  // delta は「前のフレームから何秒経ったか」を表すので、
  // それを積算して 0.25 秒ごとに FPS を再計算している。
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
      <color attach='background' args={['#d8dde3']} />
      <fog attach='fog' args={['#d8dde3', 18, 46]} />

      <LightingRig />

      {/* カメラ操作。
          このシーンでは左ドラッグを PAN にして、
          地図を「掴んで動かす」感覚を優先している。 */}
      <OrbitControls
        enableDamping
        maxPolarAngle={Math.PI * 0.48}
        minPolarAngle={Math.PI * 0.12}
        minDistance={7}
        maxDistance={42}
        target={[0, -1.8, 0]}
        mouseButtons={{
          LEFT: MOUSE.PAN,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.ROTATE,
        }}
      />

      {/* HTML で重ねるデバッグ表示。entity 数と FPS を確認する。 */}
      <PerformanceHud entityCount={entityCount} />

      <group position={[0, -0.6, 0.7]} rotation={[-Math.PI * 0.38, 0, 0]}>
        <StageLayer />
        <ExtrudedGridLayer />

        {/* 移動体レイヤーは後で再利用できるよう実装を残しつつ、いったん舞台確認のため非表示にしている。 */}
      </group>
    </>
  )
}

export default Scene
