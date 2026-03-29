import { OrbitControls } from '@react-three/drei'
import { useEffect, useState } from 'react'

import { runBarsCompute } from './compute/runBarsCompute'

/*
  このファイルは「WebGPU compute の結果を、R3F の scene に表示するまで」の流れをまとめている。

  処理の流れは次の順序。

  1. `Scene` が scene 全体を組み立てる
     - 背景色を設定する
     - ライトを置く
     - OrbitControls を有効にする
     - BarsFromCompute を scene graph に載せる

  2. `BarsFromCompute` がマウントされる
     - React の `useEffect()` が一度だけ実行される
     - 外部モジュール `runBarsCompute()` を呼び、WebGPU compute shader を走らせる

  3. compute shader が数値配列を返す
     - このサンプルでは入力 `[1,2,3,4,5,6,7,8]` を GPU で 2 倍して返している
     - 結果は React state の `values` に保存される

  4. state 更新で再 render される
     - `values.map(...)` で box を複数生成する
     - 各 box の高さと Y 位置は compute 結果から決まる

  5. 最終的に「GPU で計算した値を、R3F の通常の JSX 描画へ流し込む」形になる

  つまりこのファイルの役割は、compute shader 自体を書くことではなく、
  「compute の実行タイミング管理」と「結果の見せ方」を担当することにある。
*/
const INPUT_VALUES = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])

function BarsFromCompute() {
  const [values, setValues] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadValues() {
      try {
        // compute shader の実行自体は外部モジュールへ分離している。
        // Scene 側は「いつ compute を走らせるか」と「結果をどう描画するか」だけを担当する。
        const result = await runBarsCompute(INPUT_VALUES)

        if (!cancelled) {
          setValues(result)
        }
      } catch (computeError) {
        if (!cancelled) {
          setError(
            computeError instanceof Error
              ? computeError.message
              : 'compute 実行中に不明なエラーが発生しました'
          )
        }
      }
    }

    loadValues()

    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    // 学習用サンプルなので、UI を増やす代わりに console へ明示的に出す。
    console.error(error)
    return null
  }

  if (!values) {
    // 初回は compute 完了待ち。ここで loading 表示を出してもよい。
    return null
  }

  return (
    <group>
      {/* compute shader が返した数値配列を、そのまま box 群の高さと位置に変換する。
          ここで重要なのは「GPU 計算結果を React state に戻し、通常の JSX 描画へ流し込める」点。 */}
      {values.map((value, index) => (
        <mesh
          key={index}
          position={[index - (values.length - 1) / 2, value / 4, 0]}
        >
          <boxGeometry args={[0.6, value / 2, 0.6]} />
          <meshNormalMaterial />
        </mesh>
      ))}
    </group>
  )
}

function Scene() {
  return (
    <>
      {/* R3F では scene 全体の背景色も JSX で宣言できる。 */}
      <color attach='background' args={['black']} />
      {/* ここは通常の Three.js scene 構成で、compute 専用の記述ではない。
          compute は mesh をどう作るかではなく、mesh に渡す元データを事前計算している。 */}
      <ambientLight intensity={1.5} />
      <directionalLight position={[3, 5, 4]} intensity={2} />
      <OrbitControls />
      {/* BarsFromCompute は
          1. WebGPU compute を実行
          2. 結果を state に格納
          3. その値で box 群を描画
          という最小構成の橋渡し役。 */}
      <BarsFromCompute />
    </>
  )
}

export default Scene
