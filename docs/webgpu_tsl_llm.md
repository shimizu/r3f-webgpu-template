# WebGPU + TSL 実践知見集（LLM リファレンス）

このドキュメントは、R3F + WebGPU プロジェクト（本リポジトリ）の開発を通じて得た
**Three.js WebGPURenderer / TSL (Three.js Shader Language) の再利用可能な知見**を、
他プロジェクトへ持ち出せる形にまとめたもの。

- 対象バージョン: three r183 系 / @react-three/fiber v9 / React 19
- GIS・災害シミュレーション固有の話は除き、汎用パターンとして記述する
- 「実例:」の参照は本リポジトリ内のファイル。他プロジェクトではコード断片だけ持ち出せばよい

---

## 目次

1. [レンダラー基盤（R3F × WebGPU）](#1-レンダラー基盤r3f--webgpu)
2. [import パスの使い分けとバンドル分割](#2-import-パスの使い分けとバンドル分割)
3. [TSL 基礎イディオム](#3-tsl-基礎イディオム)
4. [NodeMaterial の組み立てパターン](#4-nodematerial-の組み立てパターン)
5. [手続きノイズ](#5-手続きノイズ)
6. [Compute Shader の定型](#6-compute-shader-の定型)
7. [uniform 駆動設計（再コンパイル回避）](#7-uniform-駆動設計再コンパイル回避)
8. [GPU インスタンシングとビルボード](#8-gpu-インスタンシングとビルボード)
9. [TSL Raymarching](#9-tsl-raymarching)
10. [フォグ（scene.fogNode）](#10-フォグscenefognode)
11. [ポストプロセス（RenderPipeline）](#11-ポストプロセスrenderpipeline)
12. [GPU リソース管理（dispose / 共有）](#12-gpu-リソース管理dispose--共有)
13. [落とし穴カタログ](#13-落とし穴カタログ)
14. [設計原則まとめ](#14-設計原則まとめ)

---

## 1. レンダラー基盤（R3F × WebGPU）

### 1-1. Canvas への非同期レンダラー注入

`WebGPURenderer` は `three/webgpu` から import し、**`await renderer.init()` を必ず呼ぶ**。
init しないと GPU デバイスが確保されず compute が動かない。
R3F は `gl` prop に async ファクトリを渡せる。

```jsx
import { WebGPURenderer } from 'three/webgpu'

async function createRenderer(props) {
  const renderer = new WebGPURenderer({ canvas: props.canvas, antialias: true, alpha: true })
  await renderer.init()
  return renderer
}

<Canvas shadows camera={{ position: [0, 15, -20], fov: 36 }} gl={createRenderer}>
```

返したレンダラーは `useThree((s) => s.gl)` で取得できる。実例: `src/App.jsx`

### 1-2. 機能検出とフォールバック方針

compute shader / TSL を多用するアプリは WebGL フォールバックが事実上不可能なので、
**自動フォールバックせず明示的にメッセージを出す**方が誠実。

```jsx
function App() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return <WebGPUNotSupported />
  return <Canvas gl={createRenderer}>...</Canvas>
}
```

加えて、compute パスのファクトリ先頭でも `if (!navigator.gpu) throw` の多重防御を入れる。

### 1-3. ErrorBoundary は必須

非同期 init の失敗やレイヤー内例外は「白画面」になる。最小の ErrorBoundary で
`<App />` を包み、エラーを可視化する。実例: `src/main.jsx`, `src/ErrorBoundary.jsx`

### 1-4. FPS 計測は R3F ツリーの外で

stats-gl を `document.body` に直接 append し、独自 `requestAnimationFrame` で更新する。
R3F のレンダーループ（useFrame）に依存させない。実例: `src/FpsStats.jsx`

---

## 2. import パスの使い分けとバンドル分割

| import 元 | 用途 |
|---|---|
| `three` | 純粋な数学・コア型（`Vector3`, `Matrix4`, `BufferGeometry`, `Color` など） |
| `three/webgpu` | `WebGPURenderer`, `RenderPipeline`, `StorageBufferAttribute`, `Mesh*NodeMaterial`（Basic/Standard/Physical）, `LineBasicNodeMaterial`, `PointsNodeMaterial`, `DataTexture` などレンダラー依存物 |
| `three/tsl` | ノード関数すべて（`Fn`, `uniform`, `storage`, `instanceIndex`, `select`, `mix`, `smoothstep`, `time`, `screenUV`, `pass`, `convertToTexture` …） |
| `three/addons/tsl/display/*.js` | ポストエフェクトノード（BloomNode, GaussianBlurNode, DepthOfFieldNode, GodraysNode …） |

- ポストプロセスは **`three/examples/jsm/postprocessing/`（WebGL 用）を使わない**。
  `@react-three/postprocessing` も WebGPU では避け、TSL ノードを直接組む。
- Vite でのチャンク分割: three 本体 / webgpu / tsl は巨大なので分ける。
  Vite 8（Rolldown）では `manualChunks(id)` 関数ではなく
  `codeSplitting.groups`（`{name, test: 正規表現, priority}` の配列）を使う。実例: `vite.config.js`

---

## 3. TSL 基礎イディオム

### 3-1. Fn はノードグラフの「構築」であって「実行」ではない

`Fn(() => {...})` 内の JS はシェーダーコンパイル時に一度だけ走り、WGSL のノードグラフを
生成する。毎フレーム CPU で実行されるわけではない。この理解がすべての土台。

- コンパイル時定数（オクターブ数・ループ回数など）は **JS の `for`/`if` で展開**してよい
- 実行時に変えたい値だけ `uniform()` にする

### 3-2. 変数・代入

```js
const p = pos.toVar()            // ローカル変数（可変値は必ず toVar）
p.assign(vec3(0))                // 再代入
p.addAssign(v) / subAssign / mulAssign
p.x.assign(p.x.mul(0.5))         // swizzle 単位の代入も可
storageNode.element(i).assign(v) // storage 要素への書き戻し
```

Fn の引数は配列分割 `Fn(([a, b]) => ...)`、または名前付きでオブジェクト分割
`Fn(({ orig, dir }) => ...)`。呼び出しは通常の引数列 `windAt(pos, time)`。

### 3-3. 分岐は原則 `select()`、高コスト領域だけ `If`

```js
// 三項演算子相当。全分岐を無条件に計算して選ぶ → 分岐発散なし
const next = select(hit, landPos, fallPos)

// 優先順位付き分岐は select のネスト（respawn > 静止 > 着地 > 落下）
const y = select(needsRespawn, respawnY, select(resting, curY, select(hit, landY, nextY)))
```

使い分けの基準:
- **両辺が安い** → `select()`（SIMD を止めない）
- **片側が高価で、多くのスレッドが同じ側に落ちる**（例: raymarch の空空間スキップ）→ `If`
- ループ回数がコンパイル時定数 → JS の `for` で展開。動的・早期終了あり → `Loop` + `Break()`

```js
Loop(steps, () => {
  If(density.greaterThan(eps), () => { /* 高価なサンプリング */ })
  If(transmittance.lessThan(0.01), () => { Break() })
})
```

### 3-4. 論理・比較はメソッドチェーン

```js
const hit = resting.not().and(parked.not()).and(pos.y.lessThanEqual(groundY))
const respawn = expired.or(outside).or(parked)
```

`.greaterThan() / .lessThan() / .lessThanEqual() / .equal()` 等。
`1 - x` は `x.oneMinus()`、clamp は `.clamp(0, 1)` のメソッド形も使える。

### 3-5. 数値ガード（NaN / Inf / 0 除算を潰す）

GPU では NaN が伝播して「粒子が全部消える」型の壊れ方をする。防御は書いた場所で:

```js
length(rel).max(1e-4)                 // 距離ゼロ割
max(high.sub(low), 1e-4)              // 区間ゼロ割
normalize(v.add(0.0001))              // ゼロベクトル正規化
timestampSpan.max(1e-6)               // 時間差ゼロ割
```

### 3-6. 落とし穴になりやすい仕様

- **`smoothstep(edge0 > edge1)` は仕様未定義**。減少方向は必ず
  `smoothstep(a, b, x).oneMinus()` の形で書く
- **TSL の `mod` は floor ベースで常に非負**。±180 の折り返しは
  `x.add(180).mod(360).sub(180)` で書く
- **`int(x)` は truncate**。floor と一致するのは非負のときだけ。
  格子インデックス化の前に `clamp(0, 1)` 等で非負を保証する
- 時間シードに生の `time` を使うと経過とともに float 精度が落ちる（グレインが固まる等）。
  `time.fract()` を使う

---

## 4. NodeMaterial の組み立てパターン

### 4-1. 「マテリアル生成関数 + uniform 注入」の骨格

マテリアル構築は React 非依存のプレーン関数 `createXxxMaterial(...)` に切り出し、
実行時に変わるパラメータは **uniform オブジェクトを引数で受け取る**。
React 側は `useMemo` で 1 回だけ生成し、以降は `.value` 更新のみ。

```js
function createWaterMaterial(opacityUniform, murkUniform) {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true, transmission: 0.6, roughness: 0.1, ior: 1.33,
  })
  material.colorNode = ...
  return material
}
```

```jsx
const murk = useMemo(() => uniform(0), [])
const material = useMemo(() => createWaterMaterial(opacity, murk), [opacity, murk])
useEffect(() => { murk.value = clamp01(murkiness) }, [murk, murkiness])
useEffect(() => () => material.dispose(), [material])
// JSX には <primitive object={material} attach='material' /> で差し込む
```

実例: `src/layers/WaterOceanLayer.jsx`

### 4-2. colorNode は「段階的に上書き」してよい

ノードグラフなので再代入は無コスト。効果を順に塗り重ねる書き方が読みやすい。

```js
material.colorNode = mix(sideColor, surfaceColor, topMask)          // ベース
material.colorNode = mix(material.colorNode, reflColor, fresnel)    // 反射
material.colorNode = mix(material.colorNode, murkColor, murk)       // 濁り
```

効果が増えてきたら、各効果をクロージャにして合成順を固定する形が保守しやすい:

```js
const applyWet  = (c) => c.mul(mix(float(1), wetDarken, wetMask))
const applySnow = (c) => mix(c, snowColor, snowMask)
material.colorNode = applySnow(applyWet(baseColor))

let roughNode = float(baseRoughness)         // roughness も同様に積み上げ
roughNode = mix(roughNode, wetRough, wetMask)
material.roughnessNode = roughNode
```

実例: `src/layers/TerrainLayer.jsx`

### 4-3. マスク → mix の定番

面の判別（上面/側面）は `normalLocal.y` の smoothstep で作り、
色・法線・不透明度すべてを同じマスクで切り替える。

```js
const topMask = smoothstep(float(0.5), float(0.9), normalLocal.y)
material.normalNode  = mix(normalLocal, waveNormal, topMask)
material.opacityNode = mix(sideOpacity, topOpacity, topMask)
```

### 4-4. フレネル

```js
const viewDir = cameraPosition.sub(positionWorld).normalize()
const fresnel = normalWorld.dot(viewDir).abs().oneMinus().pow(3)
// 反射色の mix と opacity の両方に同じ fresnel を使い回す
```

### 4-5. emissiveNode（発光・トランスルーセンシー）

```js
// ちらつく残り火: ノイズを時間軸込みで評価して emissive 強度に流す
const flicker = fbm3(vec3(positionWorld.xz.mul(2.5), time.mul(1.4))).mul(0.5).add(0.55)
material.emissiveNode = glowColor.mul(mask).mul(strength).mul(flicker)

// 逆光の透け（葉・布など）: 視線と光源の逆方向内積
const back = pow(clamp(dot(viewDir.negate(), sunDir), 0, 1), 2)
material.emissiveNode = tipColor.mul(back).mul(translucency)
```

### 4-6. positionNode と vertexNode の使い分け

- **`positionNode`** — ローカル位置を返す。通常の頂点変形・インスタンス配置はこちら
  （地形の起伏、草木の配置、風揺れ、投影変換など）
- **`vertexNode`** — `cameraProjectionMatrix.mul(viewPos)` まで自分で組む。
  **ビュー空間で操作したい場合**（ビルボード、速度ストリーク）のみ使う

```js
// vertexNode の最小形（ビュー空間ビルボード。§8-2 参照）
material.vertexNode = Fn(() => {
  const worldPos = modelWorldMatrix.mul(vec4(posFromStorage, 1))
  const viewPos = cameraViewMatrix.mul(worldPos)
  return cameraProjectionMatrix.mul(viewPos.add(vec4(positionLocal.xy.mul(size), 0, 0)))
})()
```

### 4-7. 頂点変位と法線

sin 合成 + ノイズの変位を `positionLocal` に足し、**同じ変位値から法線も摂動**させると
ライティングの整合が取れる。

```js
material.positionNode = positionLocal.add(vec3(0, displacement, 0))
material.normalNode = normalLocal.add(vec3(
  displacement.mul(nStrengthX), float(1), displacement.mul(nStrengthZ),
)).normalize()
```

高さ場からの解析法線は有限差分で（差分幅はセル 1 個分、ゼロ割ガード付き）:

```js
const h0 = heightAt(xz); const hx = heightAt(xz.add(vec2(e, 0))); const hz = heightAt(xz.add(vec2(0, e)))
const normal = vec3(h0.sub(hx).div(e), 1, h0.sub(hz).div(e)).normalize()
```

### 4-8. 距離場ベースのアニメーションマスク（compute 不要）

「中心 + 半径」の uniform だけで広がる前線（延焼・汚染・浸水…）は、compute を持たない
解析距離場で十分表現できる。**radius を CPU で進めるだけ**で複数の消費者が同期する。

```js
const edge = length(worldXZ.sub(center)).add(wobble).sub(radius) // wobble = 時間不変ノイズで凸凹に
const inside = smoothstep(0, 1, edge.div(band)).oneMinus()       // 内側で 1
const front  = exp(edge.div(band).pow(2).negate())               // 前線のガウシアンリング
const armed  = smoothstep(0.0, 0.05, radius)                     // radius≈0（未発動）の抑止
return vec2(inside.mul(armed), front.mul(armed))
```

`worldXZ → vec2(...)` のインターフェースを固定しておけば、後で compute ベースの
シミュレーションに差し替えても消費側は変わらない。実例: `src/tsl/burnField.js`

---

## 5. 手続きノイズ

### 5-1. ビルトイン（MaterialX 系）

`three/tsl` の `mx_noise_float` / `mx_fractal_noise_float` / `mx_worley_noise_float` 等。

- **`mx_fractal_noise` はオクターブ合成で ±1 を超えうる**。
  `.mul(0.5).add(0.5)` の後に必ず `clamp(0, 1)`
- **`mx_worley` は距離ベース（特徴点中心で 0）**。もこもこした billow 表現には
  `oneMinus()` して使う
- コースティクスの定番: スケール・流速の異なる 2 ノイズを `.sin().abs()` してから乗算

```js
const a = mx_noise_float(p1.add(flow1)).sin().abs()
const b = mx_noise_float(p2.sub(flow2)).sin().abs()
const caustic = a.mul(b).smoothstep(float(0.1), float(0.7))
```

### 5-2. 自作 value noise（コスト重視）

hash ベースの value noise は `mx_fractal_noise`（Perlin）の数分の一の ALU。
**raymarch のようにサンプル単価が効く場所は自作、見た目優先の 1 回サンプルは mx_\***。

```js
export const hash13 = /*@__PURE__*/ Fn(([p3]) => {
  const p = fract(p3.mul(0.3183099).add(0.1)).mul(17).toVar()
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)))
})

// fBM: octaves は JS 定数なのでループは JS 側で展開。
// オクターブ間の回転行列で軸整列アーティファクトを散らす
const ROT = /*@__PURE__*/ mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64)
export function valueFbm3(p, octaves = 4) {
  let v = float(0); let amp = 0.5; let q = p
  for (let i = 0; i < octaves; i += 1) {
    v = v.add(valueNoise3(q).mul(amp)); q = ROT.mul(q).mul(2.02); amp *= 0.5
  }
  return v
}
```

トップレベルの `Fn` には `/*@__PURE__*/` を付けて tree-shaking を効かせる。
実例: `src/tsl/valueNoise.js`

### 5-3. カバレッジマスク（「どこに◯◯があるか」の統一 API）

草・木・濡れ・雪・色ムラ…を全部同じ関数で駆動できる汎用部品。
**閾値リマップ式が肝**で、これがないと coverage 0/1 の端で smoothstep 幅が潰れて
スライダーの端が効かなくなる。

```js
export const coverageMask = /*@__PURE__*/ Fn(([worldXZ, scale, seed, coverage, edge]) => {
  const n = clamp(mx_fractal_noise_float(vec3(worldXZ.mul(scale).add(seed), 0), 5)
    .mul(0.5).add(0.5), 0, 1)
  const threshold = mix(float(1).add(edge), edge.negate(), coverage) // ← リマップが肝
  return smoothstep(threshold.sub(edge), threshold.add(edge), n)
})
```

実例: `src/tsl/coverageMask.js`

### 5-4. 場（field）の共有 Fn パターン

風場・距離場のような「位置 → ベクトル/スカラー」の関数は、
`createXxxField(params) → { xxxAt(pos, time) }` のファクトリにして複数系統で共有する。

- パラメータは「uniform ノードでも JS 数値でも受けられる」ように書く
  （`const asNode = (v) => (v && v.isNode ? v : float(v))`）。
  実行時に変えたいものだけ uniform、構造（オクターブ数など）は生成時に焼き込む
- オプション項（渦など）は **JS の `if` で分岐してノードグラフごと切り替える**
  （GPU 分岐ではなく生成時分岐）

実例: `src/tsl/windField.js`（fBM 風場 + Rankine 渦近似のオプション項）

---

## 6. Compute Shader の定型

### 6-1. 定義と実行

```js
import { Fn, instanceIndex } from 'three/tsl'

const WORKGROUP_SIZE = 64   // 本プロジェクト標準。迷ったら 64

const computeNode = Fn(() => {
  const pos = positionNode.element(instanceIndex)  // storage 要素参照（左辺値になる）
  const vel = velocityNode.element(instanceIndex)
  const p = pos.toVar()                            // ローカルへコピー
  // ... 物理 ...
  pos.assign(p)                                    // 書き戻し
})().compute(particleCount, [WORKGROUP_SIZE])      // 末尾 () でグラフ確定 → compute 化

renderer.compute(computeNode)                      // ディスパッチ
```

- `instanceIndex` = WGSL の `global_invocation_id` 相当
- 複数パスは順に `renderer.compute()` するだけ（パス間のバッファ依存はドライバのバリア任せ）

### 6-2. StorageBufferAttribute と storage()

```js
import { StorageBufferAttribute } from 'three/webgpu'
import { storage } from 'three/tsl'

const attr = new StorageBufferAttribute(new Float32Array(count * 3), 3) // itemSize=3
const node = storage(attr, 'vec3', count)          // itemSize と型文字列を一致させる
const ro   = storage(attr, 'vec3', count).toReadOnly() // 読み取り専用（バリア省略で高速）
```

- itemSize 1/2/3/4 ↔ `'float' | 'vec2' | 'vec3' | 'vec4'`
- flat 配列（stride ベース AoS）は itemSize 1 + `'float'` で作り、GPU 側で
  `baseIndex = int(instanceIndex).mul(int(STRIDE))` からオフセット加算で読む
- **attribute（データ本体）と node（アクセスの窓口）の役割分離**を意識する

### 6-3. パーティクルバッファ生成の定型化

「フィールド定義 → attribute + node 生成 → まとめて解放」を 1 関数にする。

```js
const TYPE_BY_ITEM_SIZE = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' }

export function createParticleBuffers(count, fields) {
  const attributes = {}; const nodes = {}
  for (const [name, spec] of Object.entries(fields)) {
    const itemSize = typeof spec === 'number' ? spec : spec.itemSize
    const type = TYPE_BY_ITEM_SIZE[itemSize]
    if (!type) throw new Error(`未対応の itemSize ${itemSize} (${name})`)
    const data = typeof spec === 'number' ? new Float32Array(count * itemSize) : spec.data
    const attribute = new StorageBufferAttribute(data, itemSize)
    attributes[name] = attribute
    nodes[name] = storage(attribute, type, count)
  }
  return { attributes, nodes,
    dispose(renderer) { disposeStorageAttributes(renderer, Object.values(attributes)) } }
}

// 呼び出し側は宣言的
const buffers = createParticleBuffers(count, {
  pos: { itemSize: 3, data: initialPositions },  // CPU 初期化あり
  vel: { itemSize: 3, data: initialVelocities },
  life: 1,                                        // ゼロ初期化でよいものは数値だけ
})
```

実例: `src/compute/particleBuffers.js`

### 6-4. ランナーは React 非依存の `{init, update, destroy}` ファクトリ

```js
export function createSnowComputeRunner(options) {
  if (!navigator.gpu) throw new Error('WebGPU not supported')
  const buffers = createParticleBuffers(...)
  const computeNode = Fn(() => { ... })().compute(count, [64])
  return {
    particleCount: count,
    positionNode: buffers.nodes.pos,   // 描画側がそのまま使う
    init(renderer) { renderer.compute(computeNode) },   // 初回 1 回（§13-6 参照）
    update(renderer, time, delta) {
      timeNode.value = time            // ★ uniform 更新は compute の「直前」
      deltaNode.value = delta || 1 / 60
      renderer.compute(computeNode)
    },
    destroy(renderer) { computeNode.dispose(); buffers.dispose(renderer) },
  }
}
```

React 側は `useMemo` で生成、`useEffect` で `init`/`destroy`、`useFrame` で `update`。

```jsx
useFrame((state, delta) => {
  // ★ delta は useFrame の第2引数。state.clock.getDelta() は
  //    R3F 内部の elapsedTime 更新と競合してほぼ 0 を返す
  runner.update(renderer, state.clock.elapsedTime, delta || 1 / 60)
})
```

### 6-5. compute 出力 → 描画のゼロコピー

同じ storage ノードをマテリアルのノードグラフから `element(instanceIndex)` で読めば、
GPU 間コピーも CPU 読み戻しも発生しない。CPU 読み戻しは粒子数比例の転送コスト
（10 万粒 × vec3 ≈ 1.2 MB/フレーム）なので原則やらない。

```js
const posNode = runner.positionNode.element(instanceIndex)
material.vertexNode = Fn(() => {
  const worldPos = modelWorldMatrix.mul(vec4(posNode, 1))
  ...
})()
```

### 6-6. フレームレート非依存化

- shader 側: `frameScale = deltaNode.mul(60)` を作り、「60fps 1 フレーム単位」で
  調整したパラメータに乗じる
- CPU 側の追従値: 時定数緩和 `k = 1 - exp(-dt / tau)` を使う（dt 非依存）。
  タブ復帰後の巨大 delta は `Math.min(delta, 0.1)` でクランプ

```js
const dt = Math.min(delta || 1 / 60, 0.1)
const k = 1 - Math.exp(-dt / Math.max(tau, 1e-3))
uniformValue.value = cur + (target - cur) * k
```

- 力の積算より**目標速度への時定数緩和**（同じ `1 - exp(-dt/τ)` を GPU 側で）の方が
  軌道が安定する（渦・追従系で有効）

### 6-7. 物理の細部イディオム

- **リスポーン**は初期位置バッファを持たず `sin/cos` の決定論的疑似乱数で生成。
  **位置だけでなく速度も再生成**する（古い速度が残ると挙動が壊れる）
- **壁の反射**は速度反転だけだと壁に貼り付く。`clamp` で位置も押し戻す
- **粒数の実行時可変**はバッファ再確保ではなく「ゲート」で:
  `active = float(instanceIndex).lessThan(intensity.mul(count))`。
  非活性の粒は画面外（例 y = -1000）へ退避し、復帰判定は閾値を半分にして
  ヒステリシス的に行う
- **状態の優先順位**（respawn > 静止 > 着地 > 落下）は select のネストで表現し、
  全分岐を計算してから選ぶ

---

## 7. uniform 駆動設計（再コンパイル回避）

WebGPU + TSL で最も重要な設計原則。**シェーダー構造（ノードグラフ）を変えず、
`uniform().value` の書き換えだけで挙動を変える。**

### 7-1. 基本ルール

- uniform は `useMemo(() => uniform(x), [])` で**一度だけ**生成し、安定参照として配る
- GUI（leva 等）の値は「1 個の useEffect で全 uniform の `.value` に代入」する。
  GUI 値を `useMemo` の依存配列に直接入れると、値が変わるたびに
  マテリアル/パイプラインが再生成される
- vec2/vec3/Color の uniform は `.value.set(x, y)` で in-place 更新（オブジェクト差し替え禁止）
- `.value =` は CPU 側の書き換えに過ぎず、GPU への転送は次の `renderer.compute()` /
  render 時。**uniform 更新 → compute の順**を守る（逆だと古い値で 1 フレーム走る）

### 7-2. 条件マウントの禁止

エフェクトの ON/OFF をコンポーネントの条件マウントで行うと、
**全マテリアルの再コンパイルがトグルごとに走る**（特に `scene.fogNode` を触るものは致命的）。

→ **マウントしっぱなしで `density = 0` / `intensity = 0` にする**。
uniform が 0 なら見た目・負荷とも実質ゼロ。

### 7-3. 再コンパイルを伴うパラメータの扱い

シェーダー構造そのものが変わるパラメータ（raymarch の steps、ノイズ品質、
プリセット種別など）は uniform にできない。これらは:

- GUI の毎フレーム操作対象・アニメーションのキーフレームから**外す**（固定値にする）
- 切り替えを許容する場合は「一度きりのイベント」（テクスチャ到着・シーン切替）に限定する
- バッファサイズが変わるパラメータ（粒子数など）は WebGPU バッファが resize 不可なので、
  `key={count}` で**コンポーネントごと再マウント**する

### 7-4. uniform の共有で複数系統を同期させる

uniform セットを「オーナー」レイヤーが 1 つ作り、同じオブジェクトを
compute ランナーとマテリアル構築関数の両方に渡す。CPU で値を進めるだけで
パーティクルと表面表現が自動的に同期する。

```js
const fire = useMemo(() => ({
  ignition: uniform(new Vector2()), radius: uniform(0), band: uniform(0.35),
}), [])
// → createEmberComputeRunner({ fire }) と createTerrainMaterial({ fire }) の両方に渡す
```

---

## 8. GPU インスタンシングとビルボード

### 8-1. InstancedMesh + storage buffer（compute パーティクル系）

```js
const mesh = new InstancedMesh(quadGeometry, material, count)
const identity = new Matrix4()
for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity) // 行列は全部単位行列
mesh.frustumCulled = false  // ★ 位置は GPU にしかないのでカリングが誤爆する
```

位置は完全にシェーダー側（`element(instanceIndex)`）で決める。
`THREE.Points` を使わないのは WebGPU の point size 上限が実装依存で小さいため。
`three/tsl` には `billboarding()` / `shapeCircle()` のビルトインもある。

### 8-2. ビュー空間ビルボード（最小形）

`cameraViewMatrix` でビュー空間へ移してから `positionLocal.xy` をオフセットするだけ。
回転行列は不要。

```js
material.vertexNode = Fn(() => {
  const worldPos = modelWorldMatrix.mul(vec4(posNode, 1))
  const viewPos = cameraViewMatrix.mul(worldPos)
  const final = viewPos.add(vec4(positionLocal.x.mul(size), positionLocal.y.mul(size), 0, 0))
  return cameraProjectionMatrix.mul(final)
})()
```

### 8-3. 個体差は instanceIndex ハッシュで（バッファを増やさない）

```js
const idPhase = float(instanceIndex).mul(0.7639)
const sizeHash = sin(idPhase.mul(12.9898)).mul(0.5).add(0.5)      // サイズ差
const angle = time.mul(spinSpeed).add(idPhase.mul(7.3))            // 回転位相差
const ca = cos(angle); const sa = sin(angle)                       // 2D 回転
const rx = positionLocal.x.mul(ca).sub(positionLocal.y.mul(sa))
const ry = positionLocal.x.mul(sa).add(positionLocal.y.mul(ca))
```

### 8-4. 速度方向ストリーク（雨・火花）

ビュー空間の速度ベクトルに沿って伸ばし、`cross` で横幅方向を得る。

```js
const velView = cameraViewMatrix.mul(vec4(velNode, 0))
const velDir = normalize(velView.xyz.add(0.0001))
const len = length(velView.xyz).mul(stretch).clamp(minLen, maxLen)
const right = normalize(velDir.cross(vec3(0, 0, 1)))
const offset = velDir.mul(localY.mul(len)).add(right.mul(localX.mul(width)))
```

### 8-5. ワールド空間リボン（稲妻・軌跡など「線を太らせる」用途）

頂点属性に接線 `aDir` と左右フラグ `aSide` を持たせ、視線との `cross` で太らせる。

```js
const right = normalize(cross(dir, normalize(cameraPosition.sub(worldPos))))
const finalWorld = worldPos.add(right.mul(width).mul(side))
```

### 8-6. InstancedBufferGeometry + instancedBufferAttribute（静的インスタンス）

草・木のように「初期化時に CPU が per-instance 属性を詰めるだけ」の系。
per-frame の CPU 更新はゼロ、1 ドローコール。

```js
const iPosAttr = new THREE.InstancedBufferAttribute(iPosArr, 2)
geometry.setAttribute('iPos', iPosAttr)
const iPos = instancedBufferAttribute(iPosAttr)   // TSL 側の読み口
material.positionNode = vec3(iPos.x.add(bend.x), groundY.add(localY), iPos.y.add(bend.z))
material.normalNode = transformNormalToView(analyticNormal)
```

付随テクニック:
- **GPU カリング**: 表示したくないインスタンスはスケールを 0 に潰す
  （`h = height.mul(mask)`）。ただし対象領域が小さい（無駄死にが多い）場合は
  CPU 側の rejection sampling で座標を引き直す方が効率的
- **密度・本数の変更は `geometry.instanceCount` の書き換えのみ**（再生成なし）
- **boundingSphere を手動設定 + `frustumCulled = false`**
  （頂点位置がシェーダー内で決まるので自動計算が使えない）
- **WebGPU の頂点バッファは 8 本上限**。補助スカラーは vec4 の `w` にパックする
  （`aPosB.w = 高さウェイト` のように）
- 同一トポロジーの 2 形状を両方頂点属性に焼き込み、per-instance の
  `step()` + `mix()` で切り替えると 1 ドローコールでバリエーションが出せる
- 大量インスタンスの `castShadow` は重いので既定オフにする

実例: `src/layers/GrassLayer.jsx`, `src/layers/TreeLayer.jsx`

---

## 9. TSL Raymarching

### 9-1. 全体構造

単位ボックス（-0.5..0.5）のメッシュを `scale` で引き伸ばし、フラグメントシェーダーで
AABB 交差 → 固定ステップ march。ローカル空間で march する。

```js
const vOrigin = varying(vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1))))
const vDirection = varying(positionGeometry.sub(vOrigin))
const rayDir = vDirection.normalize().toVar()
const bounds = vec2(hitBox({ orig: vOrigin, dir: rayDir })).toVar()
bounds.x.greaterThan(bounds.y).discard()      // 交差なしは discard
bounds.assign(vec2(max(bounds.x, 0), bounds.y)) // カメラがボックス内にいる場合の対応
const stepLocal = bounds.y.sub(bounds.x).div(steps).toVar()

// 開始点ジッターでスライス状バンディングを散らす。
// ★ time を混ぜない（テンポラル再構成がないとシマーになる）
const jitter = hash(screenCoordinate.x.add(screenCoordinate.y.mul(913.719)))
const pos = vOrigin.add(rayDir.mul(bounds.x.add(stepLocal.mul(jitter)))).toVar()
```

- マテリアルは `side: BackSide`（カメラがボックス内に入っても描ける）
- `fog: false`（自前の大気表現がシーンフォグと二重にかからないように）

### 9-2. 非等方 scale でも減衰をワールド距離基準にする

ローカル空間で march しつつ、1 ステップの**実ワールド距離**を求めて光学距離に使う。
移植性の高い重要ポイント。

```js
const stepWorld = modelWorldMatrix.mul(vec4(stepVec, 0)).xyz.length().toVar()
const sunLocal = normalize(modelWorldMatrixInverse.mul(vec4(sunWorld, 0)).xyz).toVar()
const sunWorldPerLocal = modelWorldMatrix.mul(vec4(sunLocal, 0)).xyz.length()
const lightStepVec = sunLocal.mul(float(lightStepWorld).div(sunWorldPerLocal)).toVar()
```

### 9-3. front-to-back 積分 + 早期終了 + 前割り解除

```js
const accumC = vec3(0).toVar(); const accumT = float(1).toVar()
Loop(steps, () => {
  const d = sampleDensity(pos).toVar()
  If(d.greaterThan(densityEps), () => {
    const opticalDepth = float(0).toVar()
    for (let j = 1; j <= lightSteps; j += 1) {          // ライトマーチは JS ループで展開
      opticalDepth.addAssign(sampleBase(pos.add(lightStepVec.mul(j)))) // 安い近似密度で
    }
    const lightT = exp(opticalDepth.mul(-(extinction * lightStepWorld)))
    const powder = exp(d.mul(-2 * powderScale)).oneMinus() // 薄い縁の散乱立ち上がり
    const radiance = sunRadiance.mul(lightT).mul(powder).mul(phase).add(ambient)
    const stepT = exp(d.mul(-extinction).mul(stepWorld))
    accumC.addAssign(radiance.mul(accumT).mul(stepT.oneMinus()))
    accumT.mulAssign(stepT)
  })
  pos.addAssign(stepVec)
  If(accumT.lessThan(0.01), () => { Break() })          // 透過率で早期終了
})
const alpha = accumT.oneMinus()
return vec4(accumC.div(max(alpha, 1e-4)), alpha)        // 前割り解除 → 通常 α ブレンドへ
```

HG 位相関数は g が JS 数値なので係数を前計算する:

```js
export function hgPhase(cosTheta, g) {
  const g2 = g * g
  return float((1 - g2) / (4 * Math.PI)).div(cosTheta.mul(-2 * g).add(1 + g2).pow(1.5))
}
```

実例: `src/layers/CloudLayer.jsx`, `src/tsl/raymarchUtils.js`

### 9-4. TDR（GPU デバイスロスト）対策 — 最重要

steps 過大で **Windows の TDR タイムアウト（約 2 秒）に達すると GPU デバイスロスト**
（画面フリーズ → ドライバリセット）。実践的な対策:

1. **2 段密度関数**: 安い `sampleBase`（2D fBM + 垂直プロファイルのみ）と、
   `If(shaped > eps)` の中でだけ 3D ノイズを評価する `sampleDensity`。
   **空空間で 3D ノイズを評価しないことが TDR 対策の要**
2. **ライトマーチは `sampleBase` で近似**（コスト 1/4 以下、見た目の差は小さい）
3. **透過率での `Break()`**
4. steps はまず 24〜32 の範囲から調整。常時表示なら 12 前後まで絞る
5. **複数の raymarch レイヤーで steps 予算を折半する**（例: 雲 12 + 煙 8）。
   raymarch を使わずに済む表現（メッシュ + vertex ノイズ + スクロールノイズ opacity）で
   代替できるなら代替する
6. 品質切替（ノイズ関数の差し替え）はパイプライン構造を共通にしてプリセットだけ変える
7. ポストプロセスとの併用は TDR リスクを積み増すので、重い raymarch と同時に使う場合は
   どちらかを絞る

### 9-5. 透明ソートと深度

- 大きな透明ボックスは距離ソートが不安定 → **`renderOrder` を明示**する
- raymarch ボックスはシーン深度クランプを持たない素朴な実装だと、
  不透明物が食い込んだとき貫通して見える。配置で回避するか、
  scenePass の depth を読んで march を打ち切る

---

## 10. フォグ（scene.fogNode）

### 10-1. 距離 + 高さの指数フォグ

```js
// fogFactor = 1 - exp(-density · exp(-falloff·(y - baseY)) · dist)
export function createHeightFogFactor({ density, falloff = 0.35, baseY = 0 }) {
  const dist = positionView.length()
  const h = positionWorld.y.sub(baseY).max(0)
  const localDensity = density.mul(exp(h.mul(-falloff)))
  return localDensity.mul(dist).negate().exp().oneMinus().clamp(0, 1)
}
```

### 10-2. 非描画レイヤーとして scene.fogNode に差す

```jsx
const fogNode = useMemo(() => fog(uniforms.color,
  createHeightFogFactor({ density: uniforms.density, falloff, baseY })), [uniforms, falloff, baseY])
useEffect(() => {
  scene.fogNode = fogNode
  return () => { if (scene.fogNode === fogNode) scene.fogNode = null } // 同一性チェック付き cleanup
}, [scene, fogNode])
```

- **常時マウント + density uniform 駆動**（§7-2。条件マウントは全マテリアル再コンパイル）
- 自前の大気表現を持つマテリアル（空ドーム・体積雲・発光系）は
  `new MeshBasicNodeMaterial({ ..., fog: false })` で除外する

実例: `src/tsl/heightFog.js`, `src/layers/HeightFogLayer.jsx`

---

## 11. ポストプロセス（RenderPipeline）

### 11-1. 骨格

WebGPU では `three/webgpu` の `RenderPipeline` + `three/tsl` の `pass()` を使う。
（`EffectComposer` / `@react-three/postprocessing` は使わない）

```jsx
import { RenderPipeline } from 'three/webgpu'
import { pass } from 'three/tsl'

const pipeline = useMemo(() => {
  const rp = new RenderPipeline(renderer)
  const scenePass = pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode()
  let outputNode = scenePassColor.add(createBloomPass(scenePassColor)) // Bloom は加算
  outputNode = createTiltShiftPass(outputNode)                         // 数珠つなぎ
  rp.outputNode = outputNode
  return { rp, scenePass }
}, [renderer, scene, camera])

useFrame(() => { pipeline.rp.render() }, 1)   // ★ priority 1
useEffect(() => () => pipeline.rp.dispose(), [pipeline])
```

**load-bearing なポイント**:
- `useFrame(..., 1)`（priority > 0）にすると **R3F の自動描画が止まり**手動描画に切り替わる。
  各レイヤーの `renderer.compute()` は priority 0 なので compute → render の順序が保たれる
- 深度系は `scenePass.getTextureNode('depth')`（godrays 用）、
  `scenePass.getViewZNode()`（DoF 用）で取り出す
- アンマウント時に `rp.dispose()` を必ず呼ぶ

### 11-2. create*Pass 分割パターン

各エフェクトは「`DEFAULTS` 定数 + `createXxxPass(inputNode, options)` を export する
純関数」に統一する。`outputNode` の数珠つなぎなので、順序変更・無効化がコメント 1 行で済む。

`three/addons/tsl/display/` に揃っている主なノード:
Bloom / GaussianBlur / DepthOfField / Godrays / GTAO / SSR / Outline、
AA は FXAA / SMAA / TRAA、レンズ系 Film / ChromaticAberration / Lut3D など。

```js
// TiltShift（ミニチュア風）の中核
const sourceTexture = convertToTexture(inputNode)  // ★ 再サンプルする前にテクスチャ化必須
const blurred = gaussianBlur(sourceTexture, null, blurStrength)
const dist = screenUV.y.sub(focusPosition).abs().sub(focusWidth * 0.5).max(0)
return mix(sourceTexture, blurred, smoothstep(0, falloff, dist))
```

- **`convertToTexture()` は「UV をずらして再サンプルする」パスの前に必須**
  （ブラー・色収差・歪み系すべて）
- godrays は castShadow 有効な Directional/Point ライトが必須
- 細い線状パーティクル（雨など）のエイリアシングには TRAA が最も効く
- カスタムパスのパラメータは `asNode = (v) => (v && v.isNode ? v : float(v))` で
  「数値でも uniform でも受ける」形にしておくと流用しやすい

### 11-3. ライブ調整は uniform 経由（§7 と同じ）

leva 値を直接 `create*Pass` に渡すと `useMemo` が再実行されパイプライン全体が再構築される。
uniform オブジェクトを `useMemo([], ...)` で安定参照にして依存配列に入れ、
毎レンダー `.value` を代入するだけにする。

実例: `src/effects/SceneEffects.jsx`, `src/effects/createTiltShift.js`

---

## 12. GPU リソース管理（dispose / 共有）

### 12-1. standalone StorageBufferAttribute は自動解放されない

three r183 の WebGPURenderer が自動解放するのは **geometry 経由の attribute のみ**。
compute パス専用の standalone な `StorageBufferAttribute` には解放経路がなく、
GPUBuffer がリークする。renderer 内部の attribute 管理に削除を依頼すると
`backend.destroyAttribute()` → `GPUBuffer.destroy()` まで届く。

```js
export function disposeStorageAttributes(renderer, attributes) {
  const attributeManager = renderer?._attributes  // private API なので存在チェック必須
  if (!attributeManager || typeof attributeManager.delete !== 'function') return
  for (const attribute of attributes) if (attribute) attributeManager.delete(attribute)
}
```

実例: `src/compute/disposeStorageAttributes.js`

### 12-2. 破棄責務の分離

- compute ランナーの `destroy()` は **自分の compute ノードと storage attribute のみ**:
  `computeNode.dispose()` + `buffers.dispose(renderer)` の 2 点セット
- geometry / material は描画レイヤー側の `useEffect` cleanup が破棄する
  （二重破棄・破棄漏れの防止）
- JSX 由来のリソース（`<sphereGeometry>` 等）は R3F が自動 dispose。
  手動 `new` したものだけ自前で解放する
- **共有バッファは所有者だけが解放する**。借りる側（node/sampler を受け取る側）は
  解放しない

### 12-3. 共有 GPU リソースは Context に 1 個だけ

同じ大きなデータ（ハイトフィールド等）を複数レイヤーが使う場合、
Provider が `StorageBufferAttribute` を 1 個だけ作り、TSL サンプラごと配布する。

```jsx
const gpu = useMemo(() => {
  const attribute = new StorageBufferAttribute(data, 1)
  const node = storage(attribute, 'float', size).toReadOnly()
  return { attribute, node, sampler: createSampler({ node, ...info }) }
}, [data])
useEffect(() => { if (gpu) return () => disposeStorageAttributes(renderer, [gpu.attribute]) },
  [gpu, renderer])
```

- 消費者ごとの GPU コピー増殖と prop drilling を同時に防ぐ
- Provider 外でも壊れないよう `EMPTY` フォールバックを返す
- サンプラは `{ heightAt, normalAt }` のような**インターフェースを固定**し、
  データ源（実測データ / 手続き生成）を差し替え可能にする。
  CPU 側にも同じ式の `cpuHeightAt()` を併置し、CPU で決める座標と GPU の結果が
  ずれないようにする

実例: `src/gis/HeightFieldContext.jsx`, `src/tsl/sampleHeightField.js`

### 12-4. TSL バイリニアサンプリング（1D storage を 2D 格子として読む）

```js
const heightAt = Fn(([worldXZ]) => {
  const fx = clamp(worldXZ.x.add(halfW).div(width), 0, 1).mul(cols - 1)
  const fz = clamp(worldXZ.y.add(halfD).div(depth), 0, 1).mul(rows - 1)
  const x0 = int(fx)                        // clamp 済みなので trunc = floor
  const z0 = int(fz)
  const x1 = min(x0.add(1), int(cols - 1))  // 端のはみ出しを clamp
  const z1 = min(z0.add(1), int(rows - 1))
  const tx = fx.sub(float(x0)); const tz = fz.sub(float(z0))
  const h00 = node.element(z0.mul(int(cols)).add(x0))   // 1D index = z*cols + x
  const h10 = node.element(z0.mul(int(cols)).add(x1))
  const h01 = node.element(z1.mul(int(cols)).add(x0))
  const h11 = node.element(z1.mul(int(cols)).add(x1))
  return mix(mix(h00, h10, tx), mix(h01, h11, tx), tz)
})
```

注意: **カテゴリカルなデータ（クラス ID 等）は補間厳禁**。テクスチャなら
NearestFilter + `mul(255).round()` で厳密復元し、クラス → 値の LUT は
「窓関数の総和」で分岐なしに書ける。

---

## 13. 落とし穴カタログ

### GPU / WebGPU 制約

| # | 落とし穴 | 対策 |
|---|---|---|
| 1 | raymarch の steps 過大で TDR（約 2 秒）→ GPU デバイスロスト | §9-4 の 7 手。空空間で高価なサンプルをしない |
| 2 | WebGPU バッファは resize 不可 | 粒子数などは `key={count}` でコンポーネント再マウント |
| 3 | 頂点バッファは 8 本上限 | 補助スカラーは vec4 の w にパック |
| 4 | `THREE.Points` の point size 上限が実装依存で小さい | quad + InstancedMesh を使う |
| 5 | standalone StorageBufferAttribute が自動解放されない | `disposeStorageAttributes()`（§12-1）を必ず組み込む |
| 6 | 初期値が GPU に反映されないまま描画される場合がある | `init()` で compute を 1 回ディスパッチ |
| 7 | uniform 更新と compute の順序 | `.value =` → `renderer.compute()` の順（逆だと 1 フレーム古い値） |

### TSL の仕様

| # | 落とし穴 | 対策 |
|---|---|---|
| 8 | 減少方向の `smoothstep(edge0 > edge1)` は未定義 | `smoothstep(a,b,x).oneMinus()` 形で書く |
| 9 | `mod` は floor ベースで常に非負 | ±半区間の折り返しは `add(半).mod(全).sub(半)` |
| 10 | `int(x)` は truncate（負値で floor と不一致） | 先に clamp して非負を保証 |
| 11 | `mx_fractal_noise` が ±1 を超える | `*0.5+0.5` 後に clamp 必須 |
| 12 | `mx_worley` は距離ベース（中心で 0） | billow 用途は `oneMinus()` |
| 13 | 生の `time` シードは経過とともに float 精度が劣化 | `time.fract()` を使う |
| 14 | ゼロ割 / NaN の伝播 | `.max(1e-4)` / `normalize(v.add(1e-4))` を書いた場所で |

### React / R3F 統合

| # | 落とし穴 | 対策 |
|---|---|---|
| 15 | 条件マウントで全マテリアル再コンパイル | 常時マウント + uniform 0 で無効化（§7-2） |
| 16 | inline 配列/オブジェクトのデフォルト prop → useMemo 再実行 → GPU リソース全再生成 | モジュール定数化 + 成分分解して依存させる |
| 17 | prop で渡す Fn / uniform が毎レンダー再生成 → シェーダー再構築 | `useMemo` で安定参照に |
| 18 | `state.clock.getDelta()` がほぼ 0 を返す（R3F 内部と競合） | `useFrame` の第 2 引数 + `delta \|\| 1/60` |
| 19 | タブ復帰後の巨大 delta で物理が爆発 | `Math.min(delta, 0.1)` でクランプ |
| 20 | データ待ちで early return すると hooks 順序が壊れる | 全 hooks 実行後に `return null` |

### 描画品質・パフォーマンス

| # | 落とし穴 | 対策 |
|---|---|---|
| 21 | シェーダー内で位置を決めるメッシュのカリング誤爆 | `frustumCulled = false` + boundingSphere 手動設定 |
| 22 | 大きな透明ボックスの距離ソートが不安定 | `renderOrder` を明示 |
| 23 | raymarch ボックスに不透明物が食い込むと貫通して見える | 配置で回避 or シーン深度で打ち切り |
| 24 | raymarch ジッターに time を混ぜるとシマー | スクリーン座標ハッシュのみ（テンポラル再構成がない限り） |
| 25 | 大量インスタンスの castShadow が重い | 既定オフ |
| 26 | カテゴリカルテクスチャの補間でクラス値が壊れる | NearestFilter + round、CPU 側も nearest |
| 27 | CPU 読み戻しの転送コスト（粒子数比例） | GPU 内で完結（storage → 描画のゼロコピー、§6-5） |
| 28 | GPU に防御分岐を足すと並列効率が落ちる | NaN・範囲外・単位不一致は **CPU のパック段階で除去** |

---

## 14. 設計原則まとめ

1. **CPU/GPU 責務境界を最初に決める。**
   CPU: データ取得・パース・検証（NaN 除去・単位統一）・TypedArray へのパック・UI。
   GPU: 毎フレーム × N 件の全計算（変換・補間・物理・描画）。
   境界が曖昧だと「JS ループ 16ms 超」「per-object の set() 呼び出し比例コスト」
   「GC スパイク」が同時に来る。
2. **すべて uniform 駆動。** シェーダー構造を変えるのは「一度きりのイベント」だけ。
   ON/OFF も 0/1 の uniform で表す。GUI → uniform の一括反映 useEffect を 1 個置く。
3. **compute ランナーは React 非依存の `{init, update, destroy}` ファクトリ。**
   React 側は useMemo / useEffect / useFrame の 3 点で接続するだけ。
4. **共有するのは「定型」と「場の Fn」だけ。物理本体はコピー派生。**
   バッファ生成・破棄・ノイズ場・サンプラのような定型は共有部品化する。
   一方、パーティクルの update 本体は系ごとに本質的に異なるので、
   注入型のジェネリックランナーにしない（TSL ビルダー文脈の受け渡しが複雑になる割に
   合わない）。テンプレートをコピーして派生させる方が読みやすい。
5. **共有 GPU リソースは Context で 1 個。** 消費者は node/sampler を借りるだけ。
   解放は所有者のみ。サンプラはインターフェース（`heightAt(xz) → float` 等)を固定し、
   データ源を差し替え可能にする。CPU 版の同式関数を併置する。
6. **GPU 予算は総量で管理する。** raymarch の合計 steps、パーティクル総数に上限目安を
   決め（本リポジトリでは steps ≈ 12〜16、粒子 ≈ 3〜4 万）、
   「重いものを同時に 2 つ焚かない」制御を演出側に持たせる。
7. **決定論を優先する。** GPU 乱数は `sin/cos` ハッシュ、リスポーンは手続き式、
   CPU と GPU で同じ数式を共有。デバッグ可能性が段違いになる。
8. **フレームレート非依存に書く。** shader は `delta * 60` の frameScale、
   CPU 追従は `1 - exp(-dt/τ)` の時定数緩和。

---

## 関連ドキュメント（本リポジトリ内）

- `docs/r3f-computeshader_llm.md` — R3F + ComputeShader 実装リファレンス（§18〜20 共有部品）
- `docs/webgpu-particles-tutorial.md` — WebGPU パーティクル入門チュートリアル
- `docs/gpu-gis-particle-architecture.md` — CPU/GPU 責務境界の詳細
- `docs/webgpu-quality-enhancement.md` — ポストエフェクトノードのカタログと品質指針
- `docs/rain-terrain-collision.md` — ハイトフィールド衝突の設計判断
