# WebGPU パーティクル入門

WebGPU の compute shader を使って大量のパーティクルを動かす方法を、ステップバイステップで解説するチュートリアル。
three.js の TSL（Three Shading Language）を利用して、WGSL を直接書かずに compute shader を組み立てる。

---

## 1. 全体像 — データフローを理解する

パーティクルシステムは 3 つのフェーズで構成される。

```
┌──────────────────────────────────────────────────────┐
│ Phase 1: CPU 初期化                                  │
│  Float32Array で位置・速度・寿命の初期値を用意        │
│  → StorageBufferAttribute で GPU バッファ化           │
└──────────────┬───────────────────────────────────────┘
               │ アップロード（初回のみ）
               ▼
┌──────────────────────────────────────────────────────┐
│ Phase 2: GPU Compute 更新（毎フレーム）               │
│  compute shader が全粒子の位置・速度・寿命を並列更新  │
│  CPU からは time / delta だけを uniform で渡す         │
└──────────────┬───────────────────────────────────────┘
               │ GPU 内バッファ参照（転送なし）
               ▼
┌──────────────────────────────────────────────────────┐
│ Phase 3: GPU 描画                                    │
│  vertex shader が同じバッファを読み、billboard 描画    │
└──────────────────────────────────────────────────────┘
```

重要なのは、Phase 2 と Phase 3 の間で CPU への読み戻しが発生しないこと。
GPU 内でデータが完結するため、大量粒子でもボトルネックになりにくい。

---

## 2. なぜ GPU compute でパーティクルを動かすのか

CPU で全粒子を for ループで更新する場合、次の問題が起きる。

| 比較項目 | CPU ループ | GPU compute |
|---|---|---|
| 1 万粒子 | まだ余裕がある | 差は小さい |
| 10 万粒子 | JavaScript の処理時間が目立ち始める | ほぼ変わらない |
| 100 万粒子 | フレーム落ちしやすい | GPU の並列性で吸収できる |
| データ転送 | 毎フレーム CPU → GPU に全座標を送る必要がある | GPU 内完結。CPU からは uniform 数個のみ |

GPU compute を選ぶ最大の理由は **転送コストの排除** にある。
CPU で計算した座標を毎フレーム GPU に送り直す往復が、粒子数に比例して重くなる。
GPU 内で計算し、そのまま描画に使えば、この往復がゼロになる。

---

## 3. StorageBufferAttribute の基本

`StorageBufferAttribute` は、`Float32Array` を GPU の storage buffer として使えるようにするラッパー。
compute shader から読み書きできるバッファを作るために使う。

```js
import { StorageBufferAttribute } from 'three/webgpu'

const count = 100000

// 位置: vec3 (x, y, z) × 粒子数
const positionAttribute = new StorageBufferAttribute(new Float32Array(count * 3), 3)

// 速度: vec3 (vx, vy, vz) × 粒子数。初期値を入れた配列を渡す
const velocityAttribute = new StorageBufferAttribute(velocitySeed, 3)

// 残り寿命: float × 粒子数
const lifeAttribute = new StorageBufferAttribute(lives, 1)

// 最大寿命: float × 粒子数（リスポーン時の戻り先）
const maxLifeAttribute = new StorageBufferAttribute(maxLives, 1)
```

第 2 引数はストライド（1 要素あたりの float 数）。`vec3` なら `3`、`float` なら `1`。

なぜ `StorageBufferAttribute` を使うのか:
通常の `BufferAttribute` は頂点属性用で、compute shader からの書き込みに対応していない。
`StorageBufferAttribute` を使うことで、GPU 側から自由に読み書きできるバッファになる。

---

## 4. storage() ノード — GPU バッファを TSL から参照する

`storage()` は、`StorageBufferAttribute` を TSL の計算グラフに接続するノード。
compute shader 内で `.element(index)` を使って各粒子のデータにアクセスできるようになる。

```js
import { storage } from 'three/tsl'

const positionNode = storage(positionAttribute, 'vec3', count)
const velocityNode = storage(velocityAttribute, 'vec3', count)
const lifeNode = storage(lifeAttribute, 'float', count)
const maxLifeNode = storage(maxLifeAttribute, 'float', count).toReadOnly()
```

- 第 1 引数: 対象の `StorageBufferAttribute`
- 第 2 引数: GLSL/WGSL 型名（`'vec3'`, `'float'` など）
- 第 3 引数: 要素数（粒子数）

`maxLifeNode` に `.toReadOnly()` を付けているのは、最大寿命は compute shader 内で書き換えない固定データだから。
読み取り専用にすると、GPU ドライバが最適化しやすくなる。

---

## 5. uniform() — CPU から毎フレーム値を渡す

`uniform()` は、CPU から GPU へ毎フレーム少量の値を送る仕組み。
パーティクルシステムでは主に時刻とデルタタイムに使う。

```js
import { uniform } from 'three/tsl'

const timeNode = uniform(0)    // 経過時刻（秒）
const deltaNode = uniform(1 / 60) // 前フレームからの経過秒数
```

なぜ uniform を使うのか:
時刻やデルタタイムは全粒子で共通の値であり、粒子ごとに異なるデータではない。
storage buffer に入れるほどのデータ量ではなく、毎フレーム CPU 側で更新する必要がある。
`uniform` はこのような「少量・頻繁更新・全スレッド共通」の値に最適な受け渡し方法。

---

## 6. Fn(() => {}).compute() パターン — compute shader の組み立て方

TSL では `Fn(() => { ... })` で compute shader のロジックを定義し、`.compute()` で実行可能なノードにする。
WGSL を文字列で書く必要がなく、JavaScript の構文で GPU 上の計算を記述できる。

```js
import { Fn, instanceIndex } from 'three/tsl'

const WORKGROUP_SIZE = 64

const computeNode = Fn(() => {
  // instanceIndex 番目の粒子のデータを取得
  const pos = positionNode.element(instanceIndex)
  const vel = velocityNode.element(instanceIndex)
  const life = lifeNode.element(instanceIndex)

  // ... GPU 上の計算ロジック（後述） ...

  // 結果をバッファに書き戻す
  pos.assign(newPosition)
  vel.assign(newVelocity)
  life.assign(newLife)
})().compute(particleCount, [WORKGROUP_SIZE])
```

- `Fn(() => { ... })`: shader ロジックの定義
- `()`: 即時呼び出しでノードを生成
- `.compute(particleCount, [WORKGROUP_SIZE])`: 実行する総スレッド数とワークグループサイズを指定

`WORKGROUP_SIZE` は 1 つのワークグループあたりのスレッド数。
64 は多くの GPU で効率が良い値。粒子数が 64 の倍数でなくても、超過分のスレッドは自動的に何もしない。

見た目は JavaScript だが、実際にはここで GPU 上で動く計算グラフを構築している。
`=` による代入ではなく `.assign()` を使うのは、GPU バッファへの書き込み命令をグラフに追加するため。

---

## 7. instanceIndex — 各スレッドが担当する粒子番号

`instanceIndex` は、GPU の各スレッドに割り当てられる 0 始まりの通し番号。

たとえば粒子が 100,000 個ある場合、GPU は最大 100,000 スレッドを並列起動し、
各スレッドが 1 粒子ずつ担当する。その担当番号が `instanceIndex`。

```
スレッド 0     → instanceIndex = 0 → 粒子 0 を更新
スレッド 1     → instanceIndex = 1 → 粒子 1 を更新
  ...
スレッド 99999 → instanceIndex = 99999 → 粒子 99999 を更新
```

`positionNode.element(instanceIndex)` と書くと、「自分が担当する粒子の位置」にアクセスできる。

なぜ各スレッドが 1 粒子を担当するのか:
GPU は数千〜数万のスレッドを同時に動かせるハードウェア。
各スレッドに 1 粒子を割り当てれば、全粒子が事実上同時に更新される。
CPU の for ループのように 1 粒子ずつ順番に処理する必要がない。

---

## 8. 粒子更新ロジックの実装例

compute shader 内で各粒子に対して行う処理を、順を追って解説する。
以下のコード例はすべて TSL で記述する。

### 8-1. jitter — 連続ノイズによる速度の揺らぎ

粒子の動きに変化を与えるため、速度に微小な揺らぎ（jitter）を加える。
完全な乱数ではなく、時刻・粒子番号・現在位置を三角関数に通した連続ノイズを使う。

```js
import { float, sin, cos, add, vec3 } from 'three/tsl'

const idPhase = float(instanceIndex).mul(0.11).toVar()
const frameScale = deltaNode.mul(60).toVar()

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
).mul(0.0009).mul(frameScale).toVar()
```

なぜ乱数ではなく三角関数ベースのノイズを使うのか:
- GPU の compute shader には `Math.random()` がない
- 三角関数 + 粒子番号 + 現在位置の組み合わせで、粒子ごとに異なる滑らかな揺らぎが得られる
- フレームごとの変化が連続的なので、動きが急に破綻しにくい

`idPhase.mul(17.231)` のような無関係な係数を掛けることで、粒子間の相関を断ち切っている。
さらに各軸の位相に `currentPosition` の別軸成分（z/y, x/z, x/y）を混ぜることで、
同じ粒子でも位置が変わるたびに揺らぎ方が変化し、空間的にも変化に富んだ動きになる。

### 8-2. 速度の安定化 — length → normalize → clamp → mul

jitter を加えた速度はそのままだと粒子によって速すぎたり遅すぎたりする。
方向はそのまま保ちつつ、速さだけを一定範囲に収める。

```js
import { length, normalize, clamp } from 'three/tsl'

const nextVelocity = currentVelocity.add(jitter).toVar()
const speed = length(nextVelocity).toVar()
const normalizedVelocity = normalize(nextVelocity).toVar()
const clampedSpeed = clamp(speed, 0.003, 0.015).toVar()
const stabilizedVelocity = normalizedVelocity.mul(clampedSpeed).toVar()
```

なぜこの手順が必要か:
1. `length()` で現在の速さ（スカラー）を取得
2. `normalize()` で方向だけの単位ベクトルにする
3. `clamp()` で速さを最小値〜最大値の範囲に制限
4. 単位ベクトル × クランプ済み速さ で、方向を保ったまま速度を安定化

これにより、どの粒子も極端に速くなったり止まったりしない。

### 8-3. 位置更新

位置は「現在位置 + 速度 × 時間スケール」で更新する。

```js
const nextPosition = currentPosition.add(stabilizedVelocity.mul(frameScale)).toVar()
```

`frameScale`（= `delta * 60`）を掛けることで、フレームレートに依存しない移動量になる（詳細は後述）。

### 8-4. 壁反射 — select で軸ごとに速度反転 + clamp で位置を押し戻す

粒子が一定範囲の外に出そうになったら、その軸の速度を反転させて跳ね返す。
このとき、X/Z 軸は共通の `bounds` を使うが、Y 軸だけは床と天井を近づけたいので
`Y_BOUNDS_RATIO`（= 0.7）を掛けた `yBounds` を使い、上下方向の箱を一回り浅くしている。

```js
import { select, clamp, vec3 } from 'three/tsl'

const Y_BOUNDS_RATIO = 0.7
// boundsNode は uniform で渡す空間の半径。Y 軸だけ比率を掛けて浅くする
const yBoundsNode = boundsNode.mul(Y_BOUNDS_RATIO).toVar()

const hitX = nextPosition.x.abs().greaterThan(boundsNode)
const hitY = nextPosition.y.abs().greaterThan(yBoundsNode)
const hitZ = nextPosition.z.abs().greaterThan(boundsNode)

// 範囲外に出そうな軸だけ速度を反転
const bouncedVelocity = vec3(
  select(hitX, stabilizedVelocity.x.negate(), stabilizedVelocity.x),
  select(hitY, stabilizedVelocity.y.negate(), stabilizedVelocity.y),
  select(hitZ, stabilizedVelocity.z.negate(), stabilizedVelocity.z)
).toVar()

// 速度反転だけだと、行き過ぎた位置がそのまま残ってしまう。
// clamp で位置自体も箱の内側へ押し戻す
const boundedPosition = vec3(
  clamp(nextPosition.x, boundsNode.negate(), boundsNode),
  clamp(nextPosition.y, yBoundsNode.negate(), yBoundsNode),
  clamp(nextPosition.z, boundsNode.negate(), boundsNode)
).toVar()
```

なぜ `if` ではなく `select` を使うのか:
GPU の compute shader では、条件分岐（if/else）よりも `select`（条件付き値選択）の方が効率が良い。
`select(条件, 真の値, 偽の値)` は分岐なしで値を選べるため、GPU のパイプラインを止めずに済む。

なぜ速度反転だけでなく `clamp` も行うのか:
速度を反転しても、その時点で既に壁を越えた `nextPosition` はそのまま使われてしまう。
次フレームで戻り切らずに壁の外へさらに進む「貼り付き」が起きることがあるため、
`clamp` で位置自体を箱の内側に丸めておくと、粒子が必ず空間内に留まる。

### 8-5. 寿命とリスポーン

各粒子は残り寿命を持ち、毎フレーム `delta` ぶん減少する。
寿命が 0 以下になったら再スタートするが、ここで重要なのは
**初期位置バッファを保持していない** こと。代わりに `sin`/`cos` ベースの手続き的な式で
リスポーン先の位置と速度をその場で生成する。位置だけでなく **速度も再生成** する点に注意。

```js
const nextLife = currentLife.sub(deltaNode).toVar()
const expired = nextLife.lessThanEqual(0)

// リスポーン用のシード。時刻と粒子番号から連続的に変化する
const respawnSeed = timeNode.mul(0.31).add(idPhase.mul(41.17)).toVar()

// 手続き的に箱の中の位置を生成（初期位置バッファは持たない）
const respawnPosition = vec3(
  sin(respawnSeed.mul(1.3).add(idPhase.mul(3.7))).mul(boundsNode),
  sin(respawnSeed.mul(1.9).add(idPhase.mul(7.1))).mul(yBoundsNode),
  cos(respawnSeed.mul(1.6).add(idPhase.mul(5.3))).mul(boundsNode)
).toVar()

// 速度も新しい方向・速さで再生成する
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

// 寿命切れなら手続き生成した位置・速度・最大寿命に切り替える
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
```

なぜ初期位置バッファではなく手続き生成なのか:
- 初期位置を別バッファに保持するとメモリと管理コストがかかる
- `respawnSeed`（時刻 + 粒子番号）から `sin`/`cos` で位置を作れば、リスポーンのたびに
  異なる場所へ散り、特定の点に粒子が固まらない
- `boundsNode` / `yBoundsNode` を掛けているので、リスポーン位置は必ず箱の内側に収まる

なぜ速度も再生成するのか:
- 位置だけ戻して速度を引き継ぐと、リスポーン直後にすぐ壁へ向かうなど偏りが出る
- 方向（`respawnDirection`）と速さ（`respawnSpeed`）を作り直すことで、
  生まれ変わった粒子が新鮮な軌跡を描く
- `respawnSpeed` は `maxLife` を混ぜているため、寿命の長い粒子ほど少し速く動く

なぜ寿命を持たせるのか:
- 粒子が永遠に動き続けると、空間の片隅に偏ったり単調な動きになる
- 寿命でリスポーンさせると、粒子が循環し続けて見た目の密度が安定する
- 初期寿命をバラすことで、全粒子が同時にリスポーンする不自然さを防げる

---

## 9. renderer.compute() の実行タイミング

compute shader はアプリケーション側から明示的に実行する必要がある。
`renderer.compute()` を呼ぶタイミングは 2 つ。

### init — 初回 1 回だけ

初期化時に 1 回実行して、GPU バッファに初期状態を書き込む。

### update — 毎フレーム

uniform を更新してから compute を実行する。

```js
return {
  init(renderer) {
    renderer.compute(computeNode)
  },

  update(renderer, time, delta) {
    // CPU → GPU: 共通パラメータを更新
    timeNode.value = time
    deltaNode.value = delta

    // GPU: 全粒子を並列更新
    renderer.compute(computeNode)
  },

  destroy() {
    computeNode.dispose()
  },
}
```

なぜ init で 1 回実行するのか:
`StorageBufferAttribute` に渡した `Float32Array` の初期値は、compute を 1 回実行するまで GPU バッファに反映されない場合がある。
init で明示的に実行することで、描画前に確実にバッファの状態が整う。

なぜ uniform の更新を compute の直前に行うのか:
`timeNode.value = time` は CPU 側の値を書き換えるだけ。
`renderer.compute()` が呼ばれた時点で、その値が GPU に転送される。
順序を逆にすると、古い値で計算が走ってしまう。

---

## 10. compute 出力を描画に直接接続する方法

compute shader が更新した位置バッファを、描画マテリアルから直接参照する。
CPU への読み戻しは一切行わない。

`three/tsl` には `billboarding()` や `shapeCircle()` といったビルボード・形状用の
ビルトインノードが用意されており、丸い点を手早く描くだけならこれらが便利。
ただし、このリポジトリでの実例（`src/layers/RainLayer.jsx`）は、速度方向に
引き伸ばした「ストリーク（雨筋）」を描くために、`billboarding`/`shapeCircle`/`alphaTest` を
使わず、行列を直接扱う手書きの vertex shader を組んでいる。以下はその実装に沿った例。

```js
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  instanceIndex,
  length,
  modelWorldMatrix,
  normalize,
  positionLocal,
  smoothstep,
  vec4,
} from 'three/tsl'
import {
  AdditiveBlending,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
} from 'three'

const STREAK_LENGTH = 0.35   // 速度方向の引き伸ばし量
const STREAK_WIDTH = 0.003   // 粒子の横幅
const STREAK_MIN_LENGTH = 0.02
const STREAK_MAX_LENGTH = 0.5

const geometry = new PlaneGeometry(1, 1)
const material = new MeshBasicNodeMaterial({
  color: '#aaccff',
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
  blending: AdditiveBlending, // 重なるほど明るく光る
})

// compute が更新する位置・速度バッファを vertex shader から直接読む
const posNode = positionNode.element(instanceIndex)
const velNode = velocityNode.element(instanceIndex)

// 速度方向ストリーク: ビュー空間で速度方向に quad を引き伸ばす
material.vertexNode = Fn(() => {
  const worldPos = modelWorldMatrix.mul(vec4(posNode, 1.0))
  const viewPos = cameraViewMatrix.mul(worldPos)

  // 速度もビュー空間へ。これでカメラに対する見かけの向きで引き伸ばせる
  const velView = cameraViewMatrix.mul(vec4(velNode, 0.0))
  const speed = length(velView.xyz).toVar()
  const velDir = normalize(velView.xyz.add(0.0001)).toVar()

  // ストリーク長は速度に比例させ、min/max でクランプ
  const streakLen = speed.mul(STREAK_LENGTH)
    .max(float(STREAK_MIN_LENGTH))
    .min(float(STREAK_MAX_LENGTH))
    .toVar()

  // quad のローカル座標を、速度方向（縦）と直交方向（横）に割り当てる
  const right = normalize(velDir.cross(vec4(0, 0, 1, 0).xyz)).toVar()
  const offset = velDir.mul(positionLocal.y).mul(streakLen)
    .add(right.mul(positionLocal.x).mul(STREAK_WIDTH))

  const finalViewPos = viewPos.add(vec4(offset, 0.0))
  return cameraProjectionMatrix.mul(finalViewPos)
})()

// 不透明度は速度に連動させる（速い粒子ほど濃く見せる）
material.opacityNode = Fn(() => {
  const speed = length(velocityNode.element(instanceIndex))
  const speedFactor = smoothstep(float(0), float(0.1), speed)
  return float(0.35).add(speedFactor.mul(0.25))
})()

// InstancedMesh で粒子数ぶんの quad を描画
const mesh = new InstancedMesh(geometry, material, particleCount)

// instance 行列は単位行列で初期化（実際の位置は vertexNode 側で決まる）
const identity = new Matrix4()
for (let i = 0; i < particleCount; i++) {
  mesh.setMatrixAt(i, identity)
}

// compute が空間全体に粒子を散らすため、視錐台カリングを無効化
mesh.frustumCulled = false
```

ポイント:
- `positionNode.element(instanceIndex)` / `velocityNode.element(instanceIndex)` で、
  各インスタンスが自分の粒子の位置と速度を読む
- ビルボードや形状を `billboarding()` / `shapeCircle()` に任せず、
  `modelWorldMatrix` → `cameraViewMatrix` → `cameraProjectionMatrix` の行列変換を
  手書きすることで、速度方向へ自由に引き伸ばした形状を作れる
- `opacityNode` を速度に連動させ、`AdditiveBlending` と組み合わせて発光感を出す
- instance 行列は単位行列のまま使わず、位置は完全に GPU バッファから取得している
- 丸い点で十分なケースなら、この手書き vertex shader の代わりに
  `material.vertexNode = billboarding({ position: posNode })` +
  `material.opacityNode = shapeCircle()` + `material.alphaTest = 0.5` という
  ビルトインノードの組み合わせでも書ける

---

## 11. なぜ CPU に読み戻さないのか — GPU 内完結のメリット

もし毎フレーム次のような流れにすると:

1. GPU で位置を計算
2. CPU に全粒子の位置を読み戻す（`readBufferAsync` など）
3. CPU で `BufferAttribute` を更新
4. GPU にアップロードして描画

粒子数に比例した転送コストが毎フレーム発生する。
10 万粒子 × vec3（12 bytes）= 約 1.2 MB の往復転送が毎フレーム走ることになる。

GPU 内完結であれば:

1. GPU compute が位置バッファを更新
2. GPU 描画が同じバッファを読む

CPU - GPU 間の転送は uniform 数個（数十 bytes）だけで済む。
粒子数が増えても転送コストは変わらない。これが大量粒子で GPU compute が有利な根本的理由。

---

## 12. なぜ Points ではなく quad を使うのか

`THREE.Points` は手軽だが、WebGPU では point primitive のサイズに制約がある。
多くの GPU 実装で `gl_PointSize`（WebGPU では `point_size`）の上限が小さく、
大きな粒子を描画できない場合がある。

quad（`PlaneGeometry` + `InstancedMesh`）を使うメリット:

- 粒子サイズに制約がない（geometry のスケールで自由に変えられる）
- `billboarding()` でカメラに向けられる
- `shapeCircle()` や UV マッピングで粒子の見た目を自由にカスタマイズできる
- 粒子ごとにサイズを変えるバッファを追加しやすい

quad ベースの方が、拡張性と互換性の両面で安定した選択になる。

---

## 13. positionAttribute と positionNode の違い

この 2 つは混同しやすいが、役割が明確に異なる。

| | positionAttribute | positionNode |
|---|---|---|
| 型 | `StorageBufferAttribute` | TSL ノード |
| 役割 | GPU バッファ上の実データ本体 | shader からデータにアクセスするための窓口 |
| 作り方 | `new StorageBufferAttribute(array, 3)` | `storage(positionAttribute, 'vec3', count)` |
| 使う場面 | バッファの生成・破棄 | compute shader や vertex shader からの読み書き |

雑に言うと:
- `positionAttribute` = 倉庫にある荷物そのもの
- `positionNode` = 倉庫から荷物を出し入れする窓口

compute shader 内で `positionNode.element(instanceIndex)` と書くと、
`positionAttribute` の中の該当粒子のデータにアクセスできる。

---

## 14. delta によるフレームレート非依存の移動

フレームレートが変動しても粒子の見た目の速さを一定に保つため、
`delta`（前フレームからの経過秒数）を使って移動量を調整する。

```js
const frameScale = deltaNode.mul(60).toVar()
```

なぜ `60` を掛けるのか:
- `delta` は秒単位（60fps なら約 0.0167）
- `delta * 60` にすると、60fps のときにちょうど `1.0` になる
- 速度パラメータ（`0.003` 〜 `0.015` など）を「60fps での 1 フレームあたりの移動量」として直感的に調整できる
- 30fps になれば `frameScale ≈ 2.0` になり、1 フレームで 2 倍動く → 見た目の速さは同じ

```js
// frameScale を掛けることで、fps に依存しない移動量になる
const nextPosition = currentPosition.add(velocity.mul(frameScale))
```

この手法により、60fps でも 30fps でも粒子の挙動がほぼ同じに見える。

---

## 15. GPU リソースの破棄

GPU リソースは JavaScript のガベージコレクションでは解放されない。
明示的に `.dispose()` を呼ぶ必要がある。ここで重要なのは **破棄の責務を分けている** こと。

- compute runner（`runBarsCompute.js` 相当）の `destroy()` は、自分が作った
  `computeNode.dispose()` **のみ** を担当する。geometry / material は compute 側では
  生成していないので、ここでは破棄しない。
- geometry / material は描画レイヤー（`RainLayer.jsx` 相当）が生成しているため、
  その破棄も描画側の責任。React なら `useEffect` の cleanup でまとめて破棄する。

```js
// compute runner 側: 自分が持つ compute ノードだけを破棄
return {
  // ...
  destroy() {
    computeNode.dispose()
  },
}
```

```js
// 描画レイヤー側（React の useEffect cleanup 例）:
useEffect(() => {
  resources.system.init(renderer)
  return () => {
    resources.system.destroy()      // compute ノードの破棄
    resources.geometry.dispose()    // 描画側が作った geometry
    resources.material.dispose()    // 描画側が作った material
  }
}, [renderer, resources])
```

なぜ責務を分けるのか:
- compute runner は「位置・速度・寿命を計算する」役割で、描画用の geometry / material を知らない
- 描画レイヤーは「どう見せるか」を担当し、geometry / material を生成・所有している
- 各自が「自分で作ったものを自分で捨てる」ようにすると、二重破棄や破棄漏れが起きにくい

なぜ破棄が必要か:
- GPU メモリは有限で、解放しないとリークする
- 特にパーティクルシステムは大きなバッファを持つため、影響が大きい
- シーンの切り替えやコンポーネントのアンマウント時に必ず呼ぶべき

破棄のタイミングは、パーティクルシステムが不要になった時点。
たとえばシーン遷移時やコンポーネントのクリーンアップ処理内で行う。

---

## 16. まとめ — この手法の強みと発展ポイント

### 強み

1. **GPU 内完結**: 計算結果を CPU に戻さず、そのまま描画に使える
2. **大量粒子に強い**: 粒子数が増えても CPU - GPU 間の転送コストが増えない
3. **TSL による記述**: WGSL を直接書かずに、JavaScript 風の構文で compute shader を組める
4. **拡張しやすい構成**: storage buffer を追加するだけで、新しい粒子属性を扱える

### 発展ポイント

| 拡張内容 | 方法 |
|---|---|
| 色を compute で動的に変える | 色用の `StorageBufferAttribute` を追加し、速度や寿命に応じて compute 内で更新する |
| 粒子ごとにサイズを変える | サイズ用のバッファを作り、`vertexNode` 内で quad のスケールに反映する |
| 寿命に応じたフェード | `opacityNode` で残り寿命 / 最大寿命の比率を使い、消える直前に透明にする |
| CPU 比較モード | 同じ見た目を CPU ループで再現し、切り替え可能にすると GPU compute の優位性が体感できる |

パーティクルシステムは、GPU compute の入門として最も手を動かしやすいテーマの一つ。
ここで学んだ storage buffer / uniform / compute / 描画接続のパターンは、
パーティクル以外の GPU 並列処理（物理シミュレーション、ボイドなど）にもそのまま応用できる。
