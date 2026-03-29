/*
  このファイルの処理の流れを先に要約すると、次の順序になる。

  1. `Scene` がライト、背景色、OrbitControls を含む R3F の scene を組み立てる
  2. `BarsFromCompute` が mount され、`useEffect()` で WebGPU compute runner を初期化する
  3. 初回だけ `runner.run(0)` を実行し、GPU で計算した棒の高さを最初の state に反映する
  4. 以後は `useFrame()` が render loop ごとに走り、経過時間を使って compute を毎フレーム実行する
  5. compute の返り値で `values` state を更新し、その値を box 群の高さと位置に変換して描画する

  つまり役割分担としては、
  `runBarsCompute.js` が「GPU で何を計算するか」を担当し、
  この `Scene.jsx` が「いつ計算し、計算結果をどう scene に見せるか」を担当している。
*/
import { OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'

import { createBarsComputeRunner } from './compute/runBarsCompute'

/*
  このファイルは「WebGPU compute の結果を、React Three Fiber の scene に載せる」
  ところを担当している。

  大きな流れは 3 段階ある。

  1. `useEffect()` で compute runner を初期化する
     - runner は `device` や `pipeline`、buffer 類を内部に持つ実行器
     - ここで毎フレーム作り直すと高コストなので、最初に 1 回だけ作る

  2. `useFrame()` で毎フレーム `runner.run(time)` を呼ぶ
     - R3F の render loop に合わせて compute を回す
     - shader へ `time` を渡し、棒の高さを時間変化させる

  3. 返ってきた数値配列を `values` state に入れ、JSX の mesh 群へ反映する
     - compute shader は「描画そのもの」ではなく「描画に使う元データ」を作っている
     - React 側はその結果を普通の state として受け取って表示する

  つまりこのサンプルでは、
  「GPU で計算 -> CPU に読み戻し -> React state 更新 -> R3F で描画」
  という最小構成を学べるようにしている。
*/
const INPUT_VALUES = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])

function BarsFromCompute() {
  // `values` は最終的に box の高さへ変換される配列。
  // 初期表示では入力値をそのまま使い、最初の compute 完了後に結果へ差し替える。
  const [values, setValues] = useState(() => Array.from(INPUT_VALUES))
  const [error, setError] = useState(null)

  // `runnerRef` は WebGPU compute 実行器への参照。
  // state に入れると再 render を招くので、再描画に影響しない ref で保持する。
  const runnerRef = useRef(null)

  // `mapAsync()` で読み戻し中の buffer に対して、次の compute を重ねると壊れる。
  // そのため「今 1 回走っている最中か」を ref で管理して多重実行を防ぐ。
  const inFlightRef = useRef(false)

  // 非同期処理の完了時に、component がまだ生きているかを判定する。
  // unmount 済みなのに `setState()` すると React 的に不正なので、その防止用。
  const mountedRef = useRef(false)

  useEffect(() => {
    // effect 内で閉じるフラグ。
    // 初期化途中に unmount された場合でも安全に後始末できるようにする。
    let cancelled = false
    mountedRef.current = true

    async function setupRunner() {
      let runner

      try {
        // ここで adapter/device/pipeline/buffer をまとめて確保する。
        // compute の土台づくりに相当する。
        runner = await createBarsComputeRunner(INPUT_VALUES)

        if (cancelled) {
          runner.destroy()
          return
        }

        // まず 1 回だけ time=0 で実行し、初期の見た目を GPU 計算結果で揃える。
        // この完了前に `useFrame()` から runner を触らせないため、
        // `runnerRef.current` への代入はこの await 後にしている。
        const initialValues = await runner.run(0)

        if (!cancelled) {
          runnerRef.current = runner
          setValues(initialValues)
        }
      } catch (computeError) {
        runner?.destroy()

        if (!cancelled) {
          setError(
            computeError instanceof Error
              ? computeError.message
              : 'compute 実行中に不明なエラーが発生しました'
          )
        }
      }
    }

    setupRunner()

    return () => {
      // component が消える時に、後続の非同期更新を止めて GPU resource を解放する。
      cancelled = true
      mountedRef.current = false
      runnerRef.current?.destroy()
      runnerRef.current = null
    }
  }, [])

  useFrame((state) => {
    // `state.clock.elapsedTime` は R3F が持つ経過時間。
    // 今回はこれを shader 側へ渡して、sin 波による高さ変化を作っている。
    const runner = runnerRef.current

    if (!runner || inFlightRef.current) {
      // まだ初期化前、または直前の compute の読み戻し中なら何もしない。
      return
    }

    inFlightRef.current = true

    runner
      .run(state.clock.elapsedTime)
      .then((nextValues) => {
        if (mountedRef.current) {
          setValues(nextValues)
        }
      })
      .catch((computeError) => {
        if (mountedRef.current) {
          setError(
            computeError instanceof Error
              ? computeError.message
              : 'compute 実行中に不明なエラーが発生しました'
          )
        }
      })
      .finally(() => {
        inFlightRef.current = false
      })
  })

  if (error) {
    // このサンプルでは専用 UI は作らず、開発者が console で原因を追える形に留める。
    console.error(error)
    return null
  }

  return (
    <group>
      {/* `values` の各要素を 1 本の box に対応させる。
          ここで重要なのは、compute 結果を特殊な描画 API ではなく、
          いつもの JSX / props に落とし込める点。 */}
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
      {/* scene 全体の土台は普通の R3F / Three.js と同じ。
          compute を使っていても、camera・light・controls の組み方は変わらない。 */}
      <color attach='background' args={['black']} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[3, 5, 4]} intensity={2} />
      <OrbitControls />
      {/* compute の結果を可視化する component を scene に載せる。 */}
      <BarsFromCompute />
    </>
  )
}

export default Scene
