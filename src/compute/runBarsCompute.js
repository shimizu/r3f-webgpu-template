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
     今回は「前フレームの位置に少しランダム移動を足しつつ、
     初期位置へ弱く引き戻す」制約付きランダムウォークにしている。

  5. init / update
     renderer.compute(...) を呼ぶことで compute shader を実行する。
     update では time と delta を更新してから再実行し、アニメーションを進める。

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
  add,
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
  // 今回は経過時間と delta time を渡して、ランダムウォークを進める。
  const timeNode = uniform(0)
  const deltaNode = uniform(1 / 60)

  // Fn(() => { ... }) は TSL で compute / shader 本体を組み立てる書き方。
  // JavaScript の見た目だが、中でやっているのは GPU 上で実行される式の構築。
  const computeNode = Fn(() => {
    // instanceIndex は「今このスレッドが担当している粒子番号」。
    // 例えば 10000 粒子なら、各スレッドが 0, 1, 2... のどれかを担当する。
    const basePosition = basePositionNode.element(instanceIndex)
    const animatedPosition = animatedPositionNode.element(instanceIndex)
    const currentPosition = animatedPosition.toVar()

    // 粒子ごとに少しずつ位相をずらすための値。
    // これがないと全粒子が同じ動きをして、平面的な印象になりやすい。
    const idPhase = float(instanceIndex).mul(0.11).toVar()

    // delta を 60fps 基準に寄せた係数。
    // これで低 fps / 高 fps でも歩幅が極端に変わりにくくなる。
    const frameScale = deltaNode.mul(60).toVar()

    // 疑似ランダムな歩行方向を作る。
    // 真の乱数ではなく、時間・粒子番号・現在位置を混ぜた三角関数で
    // 毎フレーム少しずつ向きが変わるようにしている。
    const drift = vec3(
      sin(
        add(
          add(timeNode.mul(0.83), idPhase.mul(12.9898)),
          add(currentPosition.z.mul(4.37), currentPosition.y.mul(1.91))
        )
      ),
      sin(
        add(
          add(timeNode.mul(1.17), idPhase.mul(78.233)),
          add(currentPosition.x.mul(3.71), currentPosition.z.mul(2.13))
        )
      ).mul(0.55),
      cos(
        add(
          add(timeNode.mul(0.96), idPhase.mul(45.164)),
          add(currentPosition.x.mul(4.91), currentPosition.y.mul(2.41))
        )
      )
    )
      .mul(0.0028)
      .mul(frameScale)
      .toVar()

    // 初期位置へ弱く戻す力。
    // ランダムウォークだけだと粒子が無限に拡散するので、
    // basePosition との差分を少しだけ戻し方向に使う。
    const settle = basePosition.sub(currentPosition).mul(0.021).mul(frameScale).toVar()

    // 初期位置からの距離が大きいほど、戻る力を少し強める。
    // これで全体の形が完全には崩れず、見た目が安定する。
    const radius = length(
      vec2(
        currentPosition.x.sub(basePosition.x),
        currentPosition.z.sub(basePosition.z)
      )
    ).toVar()
    const verticalOffset = currentPosition.y.sub(basePosition.y).toVar()
    const leash = vec3(
      currentPosition.x.sub(basePosition.x).mul(-0.016),
      verticalOffset.mul(-0.028),
      currentPosition.z.sub(basePosition.z).mul(-0.016)
    )
      .mul(radius.add(verticalOffset.mul(verticalOffset)).add(0.35))
      .mul(frameScale)
      .toVar()

    // assign(...) で「この粒子の次の座標」を GPU バッファに書き込む。
    // 前フレーム位置に drift / settle / leash を加算していくので、
    // 動きが積み重なるランダムウォークになる。
    animatedPosition.assign(
      currentPosition.add(drift).add(settle).add(leash)
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

    update(renderer, time, delta) {
      // 毎フレーム、CPU 側で uniform を更新してから compute を再実行する。
      // time は歩行方向の変化に、delta は歩幅の安定化に使う。
      timeNode.value = time
      deltaNode.value = delta
      renderer.compute(computeNode)
    },

    destroy() {
      // compute 用ノードも GPU リソースを持つので、不要になったら破棄する。
      computeNode.dispose()
    },
  }
}
