import { OrbitControls } from '@react-three/drei'

import LightingRig from './LightingRig'
import ExtrudedGridLayer from './layers/ExtrudedGridLayer'
import StageLayer from './layers/StageLayer'

/*
  このファイルの処理の流れ

  1. Scene が 3D シーン全体の見た目を組み立てる
     背景色、ライト、カメラ操作、舞台レイヤーを
     1 つの React コンポーネントとして並べている。

  2. OrbitControls がカメラ操作を担当する
     左ドラッグで平行移動、右ドラッグで回転、ホイールでズームできるようにして、
     地図を観察しやすい操作感を用意している。

  3. StageLayer と ExtrudedGridLayer がジオラマ舞台を描画する
     工作マット風 floor と box 群を描き、今後の可視化を載せる土台を作る。

  つまり Scene.jsx は、
  「シーンの見た目と操作を定義する」
  「ジオラマ舞台を表示する」
  という画面構成の入口になっている。
*/
function Scene() {
  return (
    <>
      <color attach='background' args={['#595959']} />
      <fog attach='fog' args={['#595959', 20, 52]} />

      <LightingRig />

      {/* カメラ操作。
          このシーンでは左ドラッグを PAN にして、
          地図を「掴んで動かす」感覚を優先している。 */}
      <OrbitControls
        enableDamping
        minDistance={6}
        maxDistance={42}
        target={[0, 0, 0]}
      />

      <group position={[0, 0, 0]} rotation={[0, 0, 0]}>
        <StageLayer />
        <ExtrudedGridLayer />

        {/* 移動体レイヤーは後で再利用できるよう実装を残しつつ、いったん舞台確認のため非表示にしている。 */}
      </group>
    </>
  )
}

export default Scene
