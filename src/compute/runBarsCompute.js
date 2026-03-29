/*
  このファイルの処理の流れ

  1. createBarsComputeRunner(inputValues)
     Scene.jsx から受け取った粒子の初期座標配列をもとに、
     WebGPU compute 用の更新システムを組み立てる。

  2. StorageBufferAttribute を 2 つ作る
     - basePositionAttribute:
       初期位置を保持する「読み取り専用の元データ」
     - animatedPositionAttribute:
       毎フレーム compute で更新し、描画にも使う出力先

  3. TSL ノードを作る
     storage(...) で GPU バッファを参照し、
     uniform(...) で CPU から渡す時間データを受け取れるようにする。

  4. Fn(() => { ... }).compute(...)
     GPU 上で各粒子をどう動かすかを compute shader として定義する。
     各スレッドは instanceIndex を使って自分の担当粒子を 1 つ処理する。

  5. init / update
     renderer.compute(...) を呼ぶことで compute shader を実行する。
     update では time を更新してから再実行し、アニメーションを進める。

  6. destroy
     compute 用リソースを破棄して、不要な GPU リソースを残さないようにする。

  つまりこのファイルは、
  「初期座標を GPU バッファへ渡す」
  「各粒子の新しい座標を GPU で計算する」
  「その結果を Scene 側へ返して描画に使う」
  という compute 更新レイヤーを担当している。
*/
import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  cos,
  float,
  instanceIndex,
  length,
  sin,
  storage,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'

// 1 つの workgroup に何個の要素をまとめて処理させるか。
// WebGPU の compute shader は大量データを並列に回すため、
// 「何件ずつ GPU に担当させるか」という単位を決める必要がある。
// ここでは 64 要素ずつ処理する設定にしている。
const WORKGROUP_SIZE = 64

export function createBarsComputeRunner(inputValues) {
  // WebGPU compute は対応ブラウザでしか動かない。
  // 先にここで弾いておくことで、後続の初期化失敗を分かりやすくしている。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  // inputValues は [x, y, z, x, y, z, ...] の配列なので、
  // 総要素数を 3 で割ると粒子数になる。
  const particleCount = inputValues.length / 3

  // StorageBufferAttribute は GPU から読み書きできる座標バッファ。
  // basePositionAttribute は「初期位置の固定データ」、
  // animatedPositionAttribute は「毎フレーム更新される描画用データ」として分けている。
  const basePositionAttribute = new StorageBufferAttribute(inputValues, 3)
  const animatedPositionAttribute = new StorageBufferAttribute(
    inputValues.slice(),
    3
  )

  // storage(...) は TSL から GPU バッファを参照するためのノードを作る。
  // base 側は toReadOnly() にして、compute 中で書き換えない前提を明確にしている。
  const basePositionNode = storage(basePositionAttribute, 'vec3', particleCount)
    .toReadOnly()

  // こちらは書き込み対象。
  // compute shader の各スレッドが、自分の担当粒子の新しい座標を書き込む。
  const animatedPositionNode = storage(
    animatedPositionAttribute,
    'vec3',
    particleCount
  )

  // uniform は CPU 側から毎フレーム更新する単一値。
  // 今回は時間を渡して、波打つようなアニメーションを作る。
  const timeNode = uniform(0)

  // Fn(() => { ... }) は TSL で compute / shader 本体を組み立てる書き方。
  // JavaScript の見た目だが、中でやっているのは GPU 上で実行される式の構築。
  const computeNode = Fn(() => {
    // instanceIndex は「今このスレッドが担当している粒子番号」。
    // 例えば 10000 粒子なら、各スレッドが 0, 1, 2... のどれかを担当する。
    const basePosition = basePositionNode.element(instanceIndex)
    const animatedPosition = animatedPositionNode.element(instanceIndex)

    // 粒子ごとに少しずつ位相をずらすための値。
    // これがないと全粒子が同じ動きをして、平面的な印象になりやすい。
    const idPhase = float(instanceIndex).mul(0.11).toVar()

    // 原点からの距離を使って、中心と外側で波の進み方を変える。
    // vec2 にしているのは x-z 平面上の距離だけが必要だから。
    const radius = length(vec2(basePosition.x, basePosition.z)).toVar()

    // angle は横方向の円運動に使う角度。
    // time, 半径, 粒子番号を混ぜることで、同心円っぽい流れを作っている。
    const angle = timeNode.mul(0.45).add(radius.mul(1.35)).add(idPhase).toVar()

    // lift は y 方向の上下運動。
    // x と z の位置も加えているので、格子全体が波打つように見える。
    const lift = sin(
      timeNode
        .mul(1.7)
        .add(basePosition.x.mul(1.9))
        .add(basePosition.z.mul(1.3))
        .add(idPhase)
    )
      .mul(0.22)
      .toVar()

    // assign(...) で「この粒子の新しい座標」を GPU バッファに書き込む。
    // x/z は円を描くように少し揺らし、y は上下させている。
    // basePosition を元にしているので、時間が進んでも元の配置は保たれる。
    animatedPosition.assign(
      vec3(
        basePosition.x.add(cos(angle).mul(0.18)),
        basePosition.y.add(lift),
        basePosition.z.add(sin(angle).mul(0.18))
      )
    )

    // ここで return は不要。
    // compute shader は「値を返す」より「バッファを書き換える」用途が中心。
  })().compute(particleCount, [WORKGROUP_SIZE])
  // .compute(...) で、この関数を compute 用ノードとして確定させる。
  // 第 1 引数は総処理件数、第 2 引数は workgroup サイズ。
  // つまり「particleCount 個ぶんの粒子を、64 件単位で GPU に処理させる」という意味。

  return {
    particleCount,

    // Scene.jsx 側ではこの attribute を geometry の position として使う。
    // これにより compute 結果がそのまま描画位置に反映される。
    positionAttribute: animatedPositionAttribute,

    // NodeMaterial から参照するためのノード表現も外へ渡す。
    positionNode: animatedPositionNode,

    init(renderer) {
      // 初回実行。
      // renderer.compute(...) が呼ばれると、GPU 側で compute shader が走る。
      renderer.compute(computeNode)
    },

    update(renderer, time) {
      // 毎フレーム、CPU 側で timeNode の値を更新してから compute を再実行する。
      // これで「時間に応じて座標が変化する」アニメーションになる。
      timeNode.value = time
      renderer.compute(computeNode)
    },

    destroy() {
      // compute 用ノードも GPU リソースを持つので、不要になったら破棄する。
      computeNode.dispose()
    },
  }
}
