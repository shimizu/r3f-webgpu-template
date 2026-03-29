# WebGPU パーティクル入門

このドキュメントは、このリポジトリに入っている WebGPU パーティクル実装を題材に、

- パーティクルの位置・速度・寿命をどう計算しているか
- 計算結果をどう描画へ渡しているか
- なぜこの構成が大量粒子向けなのか

を、入門者向けに説明するためのチュートリアルです。

対象コードは主に次の 2 ファイルです。

- `src/Scene.jsx`
- `src/compute/runBarsCompute.js`

## 1. 全体像

今の実装は、大きく分けると次の 3 段階です。

1. CPU で粒子の初期位置を作る
2. GPU の compute shader で各粒子の位置・速度・寿命を更新する
3. GPU 上の位置データを、そのまま billboard パーティクルとして描画する

重要なのは、毎フレーム JavaScript が全粒子の座標を for ループで計算していないことです。
CPU がやるのは主に次の 3 つです。

- 最初の初期位置配列を作る
- 毎フレーム `time` と `delta` を GPU に渡す
- 描画を進める

重い「粒子ごとの更新」は GPU 側に任せています。

## 2. どのファイルが何をしているか

### `src/Scene.jsx`

このファイルはシーンの組み立て担当です。

- 粒子の初期座標を作る
- compute 用システムを生成する
- billboard パーティクルの描画オブジェクトを作る
- 毎フレーム `system.update(...)` を呼ぶ

### `src/compute/runBarsCompute.js`

このファイルは GPU 側の粒子更新ロジック担当です。

- GPU に置く位置・速度・寿命バッファを作る
- TSL で compute shader を組み立てる
- `renderer.compute(...)` で毎フレーム実行する

つまり役割分担は次の通りです。

- `Scene.jsx`: シーン管理と描画
- `runBarsCompute.js`: 粒子状態の GPU 更新

## 3. 初期位置はどう作っているか

粒子の初期位置は `src/Scene.jsx` の `createParticleSeed(...)` で作っています。

ここでは粒子を x-z 平面に格子状に並べています。

```js
positions[baseIndex] = (x - half) * spacing
positions[baseIndex + 1] = 0
positions[baseIndex + 2] = (z - half) * spacing
```

この配列は `Float32Array` で、並びは次のようになっています。

```text
[x, y, z, x, y, z, x, y, z, ...]
```

three.js と GPU バッファの両方で扱いやすい、標準的な形式です。

## 4. GPU に渡しているデータ

`src/compute/runBarsCompute.js` では、今は 4 種類のバッファを使っています。

### `animatedPositionAttribute`

各粒子の現在位置です。毎フレーム compute で更新され、描画にも使われます。

### `velocityAttribute`

各粒子の現在速度です。粒子ごとに異なる方向と速さを持ちます。

### `lifeAttribute`

各粒子の残り寿命です。毎フレーム減少し、0 以下になると粒子はリスポーンします。

### `maxLifeAttribute`

各粒子の最大寿命です。リスポーン時に `life` をどこまで戻すかに使います。

## 5. `storage(...)` は何をしているか

TSL の `storage(...)` は、「この GPU バッファを shader から読んだり書いたりする」と宣言するものです。

```js
const animatedPositionNode = storage(animatedPositionAttribute, 'vec3', particleCount)
const velocityNode = storage(velocityAttribute, 'vec3', particleCount)
const lifeNode = storage(lifeAttribute, 'float', particleCount)
const maxLifeNode = storage(maxLifeAttribute, 'float', particleCount).toReadOnly()
```

ここで、

- 位置は `vec3`
- 速度も `vec3`
- 寿命は `float`

です。

`maxLifeNode` に `toReadOnly()` を付けているのは、これは毎フレーム書き換えない固定データだからです。

## 6. compute shader はどう作っているか

この実装では WGSL を文字列で直接書かず、TSL の `Fn(() => { ... })` で compute shader を組み立てています。

```js
const computeNode = Fn(() => {
  const animatedPosition = animatedPositionNode.element(instanceIndex)
  const velocity = velocityNode.element(instanceIndex)
  const life = lifeNode.element(instanceIndex)

  ...

  velocity.assign(finalVelocity)
  animatedPosition.assign(finalPosition)
  life.assign(finalLife)
})().compute(particleCount, [WORKGROUP_SIZE])
```

見た目は JavaScript に近いですが、実際には GPU 上で動く計算グラフを作っています。

## 7. `instanceIndex` は何か

`instanceIndex` は「今このスレッドが何番の粒子を担当しているか」を表します。

たとえば粒子が 100000 個ある場合、GPU は大量のスレッドで並列処理し、
各スレッドが 1 粒子ずつ担当します。

その担当番号が `instanceIndex` です。

## 8. 今回の粒子更新ロジック

今の粒子は「独立した速度を持つ粒子系」です。
各粒子は毎フレーム、

1. 速度に揺らぎを加える
2. その速度で位置を進める
3. 範囲外へ出そうなら反射する
4. 寿命を減らす
5. 寿命切れならリスポーンする

という順で更新されます。

### 8-1. `jitter`

`jitter` は速度へ加える微小な揺らぎです。

```js
const jitter = vec3(...).mul(0.0009).mul(frameScale)
```

完全な乱数ではなく、

- 時間
- 粒子番号
- 現在位置

を三角関数へ混ぜた連続ノイズです。

これにより、

- 粒子ごとに別々の動きになる
- でもフレームごとに急に破綻しにくい

という性質になります。

### 8-2. 速度の安定化

`jitter` を足しただけだと粒子によっては速すぎたり遅すぎたりします。
そこで速度ベクトルの長さを計算し、一定範囲にクランプしています。

```js
const speed = length(nextVelocity)
const normalizedVelocity = normalize(nextVelocity)
const clampedSpeed = clamp(speed, 0.003, 0.015)
const stabilizedVelocity = normalizedVelocity.mul(clampedSpeed)
```

これで速度のばらつきが暴れすぎないようにしています。

### 8-3. 位置更新

位置はシンプルに

```js
const nextPosition = currentPosition.add(stabilizedVelocity.mul(frameScale))
```

で進めています。

つまり「速度を持つ粒子」が時間経過で移動している形です。

### 8-4. 壁反射

粒子を無限に散らせないため、一定範囲の箱の中で反射させています。

```js
const hitX = nextPosition.x.abs().greaterThan(boundsNode)
...
const bouncedVelocity = vec3(
  select(hitX, stabilizedVelocity.x.negate(), stabilizedVelocity.x),
  ...
)
```

特定の軸で範囲外へ出そうなら、その軸の速度だけ反転します。

これにより粒子は空間内をバラバラに動き続けられます。

### 8-5. 寿命とリスポーン

各粒子は `life` を持っていて、毎フレーム `delta` ぶん減ります。

```js
const nextLife = currentLife.sub(deltaNode)
const expired = nextLife.lessThanEqual(0)
```

寿命が切れた粒子は、

- 新しい位置
- 新しい速度
- 最大寿命

で再スタートします。

```js
const finalLife = select(expired, maxLife, nextLife)
```

こうすることで、粒子が消えずに循環し続けます。

## 9. 初回データはどう作っているか

初期速度は `createVelocitySeed(...)` で作っています。
粒子ごとに疑似乱数から方向と速度を決めているので、最初からある程度バラけています。

初期寿命は `createLifeSeed(...)` で作っています。

- `maxLife`: 粒子ごとの最大寿命
- `life`: 現在の残り寿命

を別々に持たせています。

初期時点で寿命を少しバラしているので、全粒子が同じ瞬間に一斉リスポーンしにくくなっています。

## 10. compute の実行タイミング

compute は 2 回のタイミングで実行されます。

### 初回

`Scene.jsx` の `useEffect(...)` で `system.init(renderer)` を呼びます。

これで GPU 側の計算ノードが初回実行され、必要なバッファ状態が整います。

### 毎フレーム

`useFrame(...)` で次を呼んでいます。

```js
system.update(renderer, state.clock.elapsedTime, delta)
```

その中で

```js
timeNode.value = time
deltaNode.value = delta
renderer.compute(computeNode)
```

が実行されます。

つまり毎フレーム、

1. CPU が `time` と `delta` を更新
2. GPU が全粒子の位置・速度・寿命を並列更新

という流れです。

## 11. 計算結果をどう描画に渡しているか

ここが一番重要です。

この実装では、GPU が更新した位置データを CPU に読み戻していません。
JavaScript に全粒子位置を返してから描画しているわけではありません。

代わりに、描画マテリアルがそのバッファを直接参照します。

`Scene.jsx` では次のように書いています。

```js
material.vertexNode = billboarding({
  position: system.positionNode.element(instanceIndex),
  horizontal: true,
  vertical: true,
})
```

ここでやっていることは、

1. `system.positionNode` で GPU 上の位置バッファを参照
2. `element(instanceIndex)` で「このインスタンスの位置」を取得
3. その位置へ quad を置く

という流れです。

つまりデータ受け渡しは

1. compute shader が GPU バッファを書き換える
2. 描画側の vertex 処理が同じ GPU バッファを読む

という GPU 内完結の形です。

これが大量粒子で有利になる大きな理由です。

## 12. なぜ CPU に読み戻さないのか

もし毎フレーム、

- GPU で位置を計算
- CPU に全粒子位置を読み戻す
- その値をまた描画へ使う

という形にすると、CPU と GPU の間の転送コストが大きくなります。

粒子数が増えるほど、この往復がボトルネックになります。

今回の実装は

- 計算も GPU
- 描画用位置の参照も GPU

なので、大量粒子向けの構成にしやすいです。

## 13. なぜ `Points` ではなく quad を使っているのか

最初に考えたくなるのは `THREE.Points` です。
ただし WebGPU では point primitive のサイズ制御に制約があり、
`Points` では粒子サイズ変更が扱いづらいです。

今回やりたいことは

- パーティクルサイズを変える
- パーティクル色を変える
- compute shader で大量粒子を動かす

なので、`Points` ではなく

- 小さな `PlaneGeometry`
- `InstancedMesh`
- `billboarding(...)`

の組み合わせで描画しています。

これにより、各粒子は「カメラを向く小さな板」として描画されます。

## 14. billboard パーティクルはどう作っているか

描画用のベース geometry は 1 枚の四角形です。

```js
const geometry = new PlaneGeometry(particleSize, particleSize, 1, 1)
```

これを `InstancedMesh` で大量複製しています。

```js
const mesh = new InstancedMesh(geometry, material, system.particleCount)
```

ただし実際の座標は instance 行列で動かすのではなく、
`material.vertexNode` 側で GPU バッファの位置を読む形です。

そして `billboarding(...)` によって、quad が常にカメラを向きます。

## 15. 丸い粒子に見せる方法

quad はそのままだと四角く見えます。
そこで `shapeCircle()` を使って UV から円形の alpha を作っています。

```js
material.opacityNode = shapeCircle()
material.alphaTest = 0.5
```

これにより見た目は丸い粒子に近づきます。

## 16. 色はどう付けているか

色は `createParticleColor(...)` で粒子ごとに作り、
`mesh.setColorAt(...)` で各インスタンスへ設定しています。

```js
mesh.setColorAt(index, createParticleColor(index, system.particleCount))
```

この色は `InstancedMesh` の `instanceColor` としてマテリアルに渡されます。
現在はインデックスから作る疑似乱数ベースなので、

- ランダムっぽく見える
- フレームごとに色がチラつかない

という特性があります。

## 17. サイズはどこで変えるか

粒子サイズは `Scene.jsx` の定数で決めています。

```js
const PARTICLE_SIZE = 0.018
```

これは描画用 `PlaneGeometry` の大きさとして使われます。
つまり今の構成では「点のサイズ」ではなく、「billboard quad の実寸」を変えています。

## 18. `positionAttribute` と `positionNode` の違い

`runBarsCompute.js` の返り値には 2 つあります。

### `positionAttribute`

compute が更新した生の位置バッファです。
今の描画では直接 geometry には入れていませんが、GPU 上にある座標データ本体です。

### `positionNode`

NodeMaterial や TSL から参照しやすいノード表現です。
今の描画ではこちらを `vertexNode` から読んでいます。

雑に言うと、

- `positionAttribute`: データ本体
- `positionNode`: shader から読むための窓口

です。

## 19. なぜ `delta` を使うのか

`delta` は前フレームから経過した秒数です。

高 fps と低 fps で移動量が極端に変わらないように、compute 側では

```js
const frameScale = deltaNode.mul(60)
```

として 60fps 基準に寄せています。

これによりフレームレートによって歩幅が大きくズレにくくなります。

## 20. この実装の強み

この構成の強みは次の通りです。

- 粒子位置の更新を GPU に任せられる
- 粒子速度や寿命も GPU 内で管理できる
- CPU は大規模な for ループを回さなくてよい
- 計算結果を CPU に戻さず、そのまま描画へ使える
- 粒子サイズを変えられる
- 粒子色を変えられる

「CPU で全粒子を更新するより、大量粒子向けにしやすい構成」を見せるデモとして素直です。

## 21. 今後の発展ポイント

この実装は次の方向に拡張しやすいです。

### 1. 色も compute で更新する

現在は色は CPU 側で初期設定して固定です。
色バッファを storage として持てば、速度や寿命に応じて色も GPU で変えられます。

### 2. サイズも粒子ごとに変える

今は全粒子同じサイズですが、サイズ用バッファを作れば個別制御できます。

### 3. 寿命に応じたフェードを追加する

今は寿命切れでリスポーンするだけです。
残り寿命に応じて透明度を下げると、より粒子らしい見え方になります。

### 4. CPU mode を追加して比較する

この構成の価値を見せるなら、

- CPU で更新する版
- GPU compute で更新する版

を同じ見た目で切り替えられるようにすると、差がかなり伝わりやすくなります。

## 22. まとめ

このリポジトリのパーティクルは、次の考え方で動いています。

1. CPU で初期位置を作る
2. GPU の compute shader で位置・速度・寿命を更新する
3. その GPU バッファを描画マテリアルが直接参照する
4. billboard quad として描画することで、サイズ変更可能な粒子にする

重要なのは「計算結果を CPU に戻さず、そのまま描画に使っている」点です。
ここが、GPU compute パーティクルを大量粒子向けにしやすい理由です。
