/*
  このファイルの処理の流れ

  1. createBarsComputeRunner(inputValues)
     Scene.jsx から受け取った粒子の初期座標配列をもとに、
     WebGPU compute 用の更新システムを組み立てる。

  2. StorageBufferAttribute を 4 つ作る
     - animatedPositionAttribute:
       毎フレーム compute で更新し、描画にも使う出力先
     - velocityAttribute:
       粒子ごとの速度を保持する出力先
     - lifeAttribute / maxLifeAttribute:
       残り寿命と最大寿命を保持する出力先

  3. TSL ノードを作る
     storage(...) で GPU バッファを参照し、
     uniform(...) で CPU から渡す時間データを受け取れるようにする。

  4. Fn(() => { ... }).compute(...)
     GPU 上で各粒子をどう動かすかを compute shader として定義する。
     各スレッドは instanceIndex を使って自分の担当粒子を 1 つ処理する。
     今回は「速度にランダムな揺らぎを加えながら移動し、
     範囲外に出そうなら反射し、寿命が切れたらリスポーンする」
     独立粒子系の挙動にしている。

  5. init / update
     renderer.compute(...) を呼ぶことで compute shader を実行する。
     update では time と delta を更新してから再実行し、
     位置・速度・寿命のアニメーションを進める。

  6. destroy
     compute 用リソースを破棄して、不要な GPU リソースを残さないようにする。

  つまりこのファイルは、
  「初期座標から現在位置・速度・寿命を GPU バッファへ作る」
  「各粒子の新しい座標・速度・寿命を GPU で計算する」
  「その結果を Scene 側へ返して描画に使う」
  という compute 更新レイヤーを担当している。
*/
import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  add,
  clamp,
  cos,
  float,
  instanceIndex,
  length,
  normalize,
  select,
  sin,
  storage,
  uniform,
  vec3,
} from 'three/tsl'

// 1 つの workgroup に何個の要素をまとめて処理させるか。
// WebGPU の compute shader は大量データを並列に回すため、
// 「何件ずつ GPU に担当させるか」という単位を決める必要がある。
// ここでは 64 要素ずつ処理する設定にしている。
const WORKGROUP_SIZE = 64
const BOUNDS_PADDING = 1.25

// CPU 側で使う簡単な疑似乱数。
// シード値が同じなら毎回同じ値になるので、初期速度や寿命を再現可能に作れる。
function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// 粒子ごとの初期速度ベクトルを作る。
// 入力座標そのものは変えず、別バッファに「最初の進行方向」だけを用意する。
function createVelocitySeed(inputValues) {
  const particleCount = inputValues.length / 3
  const velocities = new Float32Array(inputValues.length)

  for (let index = 0; index < particleCount; index += 1) {
    const baseIndex = index * 3
    const seed = index + 1
    const theta = hash01(seed * 0.731) * Math.PI * 2
    const phi = hash01(seed * 1.913) * Math.PI * 2
    const speed = 0.0025 + hash01(seed * 2.417) * 0.008
    const x = Math.cos(theta) * Math.cos(phi)
    const y = Math.sin(phi) * 0.75
    const z = Math.sin(theta) * Math.cos(phi)
    const length = Math.hypot(x, y, z) || 1

    velocities[baseIndex] = (x / length) * speed
    velocities[baseIndex + 1] = (y / length) * speed
    velocities[baseIndex + 2] = (z / length) * speed
  }

  return velocities
}

// 粒子ごとの寿命と最大寿命を初期化する。
// 全粒子が同じタイミングで消えないよう、初期残量も少しばらけさせている。
function createLifeSeed(inputValues) {
  const particleCount = inputValues.length / 3
  const maxLives = new Float32Array(particleCount)
  const lives = new Float32Array(particleCount)

  for (let index = 0; index < particleCount; index += 1) {
    const seed = index + 1
    const maxLife = 2.4 + hash01(seed * 3.171) * 3.2
    const initialLife = maxLife * (0.25 + hash01(seed * 5.731) * 0.75)

    maxLives[index] = maxLife
    lives[index] = initialLife
  }

  return { lives, maxLives }
}

export function createBarsComputeRunner(inputValues) {
  // WebGPU compute は対応ブラウザでしか動かない。
  // 先にここで弾いておくことで、後続の初期化失敗を分かりやすくしている。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  // inputValues は [x, y, z, x, y, z, ...] の配列なので、
  // 総要素数を 3 で割ると粒子数になる。
  const particleCount = inputValues.length / 3
  const velocitySeed = createVelocitySeed(inputValues)
  const { lives, maxLives } = createLifeSeed(inputValues)
  const maxBaseRadius = inputValues.reduce((maxRadius, value) => {
    return Math.max(maxRadius, Math.abs(value))
  }, 0)
  const bounds = maxBaseRadius + BOUNDS_PADDING

  // StorageBufferAttribute は GPU から読み書きできるバッファ。
  // animatedPositionAttribute は「毎フレーム更新される位置データ」。
  const animatedPositionAttribute = new StorageBufferAttribute(
    inputValues.slice(),
    3
  )
  const velocityAttribute = new StorageBufferAttribute(velocitySeed, 3)
  const lifeAttribute = new StorageBufferAttribute(lives, 1)
  const maxLifeAttribute = new StorageBufferAttribute(maxLives, 1)

  // storage(...) は TSL から GPU バッファを参照するためのノードを作る。
  // compute shader の各スレッドが、自分の担当粒子の現在位置・速度・寿命を書き換える。
  const animatedPositionNode = storage(
    animatedPositionAttribute,
    'vec3',
    particleCount
  )
  const velocityNode = storage(velocityAttribute, 'vec3', particleCount)
  const lifeNode = storage(lifeAttribute, 'float', particleCount)
  const maxLifeNode = storage(maxLifeAttribute, 'float', particleCount).toReadOnly()

  // uniform は CPU 側から毎フレーム更新する単一値。
  // 今回は経過時間と delta time を渡して、
  // 速度更新・位置更新・寿命更新を進める。
  const timeNode = uniform(0)
  const deltaNode = uniform(1 / 60)
  const boundsNode = uniform(bounds)

  // Fn(() => { ... }) は TSL で compute / shader 本体を組み立てる書き方。
  // JavaScript の見た目だが、中でやっているのは GPU 上で実行される式の構築。
  const computeNode = Fn(() => {
    // instanceIndex は「今このスレッドが担当している粒子番号」。
    // 例えば 10000 粒子なら、各スレッドが 0, 1, 2... のどれかを担当する。
    const animatedPosition = animatedPositionNode.element(instanceIndex)
    const velocity = velocityNode.element(instanceIndex)
    const life = lifeNode.element(instanceIndex)
    const currentPosition = animatedPosition.toVar()
    const currentVelocity = velocity.toVar()
    const currentLife = life.toVar()
    const maxLife = maxLifeNode.element(instanceIndex)

    // 粒子ごとの疑似乱数シード。
    // これにより、各粒子が別々の揺らぎ方をする。
    const idPhase = float(instanceIndex).mul(0.11).toVar()

    // delta を 60fps 基準に寄せた係数。
    // これで低 fps / 高 fps でも歩幅が極端に変わりにくくなる。
    const frameScale = deltaNode.mul(60).toVar()

    // 速度へ加えるランダムな揺らぎ。
    // 真の乱数ではなく、時間・粒子番号・現在位置を混ぜた連続的なノイズなので、
    // 粒子ごとに独立しつつ、フレーム間で急に破綻しにくい。
    const jitter = vec3(
      sin(
        add(
          add(timeNode.mul(1.93), idPhase.mul(17.231)),
          add(currentPosition.z.mul(6.37), currentPosition.y.mul(3.11))
        )
      ),
      sin(
        add(
          add(timeNode.mul(2.17), idPhase.mul(53.817)),
          add(currentPosition.x.mul(5.71), currentPosition.z.mul(4.13))
        )
      ),
      cos(
        add(
          add(timeNode.mul(1.76), idPhase.mul(91.417)),
          add(currentPosition.x.mul(7.11), currentPosition.y.mul(3.41))
        )
      )
    )
      .mul(0.0009)
      .mul(frameScale)
      .toVar()

    // 速度を少しずつ揺らし、完全な直進にならないようにする。
    const nextVelocity = currentVelocity.add(jitter).toVar()

    // 速度の大きさをある範囲に丸めて、速すぎる粒子・遅すぎる粒子を抑える。
    const speed = length(nextVelocity).toVar()
    const normalizedVelocity = normalize(nextVelocity).toVar()
    const clampedSpeed = clamp(speed, 0.003, 0.015).toVar()
    const stabilizedVelocity = normalizedVelocity.mul(clampedSpeed).toVar()

    // 速度を使って次の位置を進める。
    const nextPosition = currentPosition
      .add(stabilizedVelocity.mul(frameScale))
      .toVar()

    // 範囲外へ出そうな軸だけ速度を反転して、箱の中で跳ね返す。
    // こうすると粒子が散りすぎず、しかも全粒子が別々に動いて見えやすい。
    const hitX = nextPosition.x.abs().greaterThan(boundsNode)
    const hitY = nextPosition.y.abs().greaterThan(boundsNode.mul(0.7))
    const hitZ = nextPosition.z.abs().greaterThan(boundsNode)

    const bouncedVelocity = vec3(
      select(hitX, stabilizedVelocity.x.negate(), stabilizedVelocity.x),
      select(hitY, stabilizedVelocity.y.negate(), stabilizedVelocity.y),
      select(hitZ, stabilizedVelocity.z.negate(), stabilizedVelocity.z)
    ).toVar()

    const boundedPosition = vec3(
      clamp(nextPosition.x, boundsNode.negate(), boundsNode),
      clamp(nextPosition.y, boundsNode.mul(-0.7), boundsNode.mul(0.7)),
      clamp(nextPosition.z, boundsNode.negate(), boundsNode)
    ).toVar()

    // 寿命は毎フレーム減っていき、0 以下ならランダムな位置と速度で再生成する。
    const nextLife = currentLife.sub(deltaNode).toVar()
    const expired = nextLife.lessThanEqual(0)
    const respawnSeed = timeNode.mul(0.31).add(idPhase.mul(41.17)).toVar()
    const respawnPosition = vec3(
      sin(respawnSeed.mul(1.3).add(idPhase.mul(3.7))).mul(boundsNode),
      sin(respawnSeed.mul(1.9).add(idPhase.mul(7.1))).mul(boundsNode.mul(0.7)),
      cos(respawnSeed.mul(1.6).add(idPhase.mul(5.3))).mul(boundsNode)
    ).toVar()
    const respawnDirection = normalize(
      vec3(
        sin(respawnSeed.mul(2.1).add(idPhase.mul(9.2))),
        sin(respawnSeed.mul(2.7).add(idPhase.mul(13.4))),
        cos(respawnSeed.mul(2.4).add(idPhase.mul(11.7)))
      )
    ).toVar()
    const respawnSpeed = maxLife
      .mul(0.0016)
      .add(0.0024)
      .mul(sin(respawnSeed.mul(3.2)).mul(0.5).add(1.0))
      .toVar()
    const respawnVelocity = respawnDirection.mul(respawnSpeed).toVar()
    const finalVelocity = vec3(
      select(expired, respawnVelocity.x, bouncedVelocity.x),
      select(expired, respawnVelocity.y, bouncedVelocity.y),
      select(expired, respawnVelocity.z, bouncedVelocity.z)
    ).toVar()
    const finalPosition = vec3(
      select(expired, respawnPosition.x, boundedPosition.x),
      select(expired, respawnPosition.y, boundedPosition.y),
      select(expired, respawnPosition.z, boundedPosition.z)
    ).toVar()
    const finalLife = select(expired, maxLife, nextLife).toVar()

    // assign(...) で「この粒子の次の座標」を GPU バッファに書き込む。
    // 位置だけでなく速度と寿命も保持するので、粒子ごとに独立した軌跡になる。
    velocity.assign(finalVelocity)
    animatedPosition.assign(finalPosition)
    life.assign(finalLife)

    // ここで return は不要。
    // compute shader は「値を返す」より「バッファを書き換える」用途が中心。
  })().compute(particleCount, [WORKGROUP_SIZE])
  // .compute(...) で、この関数を compute 用ノードとして確定させる。
  // 第 1 引数は総処理件数、第 2 引数は workgroup サイズ。
  // つまり「particleCount 個ぶんの粒子を、64 件単位で GPU に処理させる」という意味。

  return {
    particleCount,

    // compute が更新した位置データそのもの。
    // 描画側はこの位置バッファを直接参照して、各粒子を billboard 表示する。
    positionAttribute: animatedPositionAttribute,

    // Scene.jsx 側ではこちらを material.vertexNode から参照し、
    // 各インスタンスの描画位置として使っている。
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
