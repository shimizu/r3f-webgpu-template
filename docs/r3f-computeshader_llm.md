# R3F + WebGPU Compute Shader 技術リファレンス

本ドキュメントは、このプロジェクトで使われている WebGPU テクニックと React Three Fiber (R3F) 統合パターンを網羅的に抽出・解説したものである。LLM がこのコードベースを理解し、同等の実装を再現できることを目的とする。

---

## 1. WebGPURenderer の初期化と R3F への注入

### 技術: Canvas の `gl` prop に非同期ファクトリを渡す

R3F の `<Canvas>` は `gl` prop にレンダラーファクトリ関数を受け取れる。WebGPURenderer は初期化が非同期なため、`async` 関数を渡して `await renderer.init()` する。

```jsx
import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'

async function createRenderer(props) {
  const renderer = new WebGPURenderer({
    canvas: props.canvas,
    antialias: true,
    alpha: true,
  })
  await renderer.init()
  return renderer
}

<Canvas gl={createRenderer}>
  <Scene />
</Canvas>
```

**要点:**
- `WebGPURenderer` は `three/webgpu` からインポートする（通常の `WebGLRenderer` ではない）
- `await renderer.init()` を呼ばないと GPU デバイスが確保されず compute が動かない
- R3F の `<Canvas>` は返されたレンダラーを自動的に `state.gl` として管理する

---

## 2. TSL (Three.js Shader Language) による Compute Shader 構築

### 技術: `Fn(() => { ... })().compute(count, [workgroupSize])` パターン

Three.js の TSL は JavaScript の関数呼び出しの見た目で GPU シェーダーのノードグラフを構築する DSL である。

```js
import { Fn, float, instanceIndex, int, storage, uniform, vec3 } from 'three/tsl'

const computeNode = Fn(() => {
  const pos = positionNode.element(instanceIndex)
  // ... GPU上で実行される式を構築 ...
  pos.assign(vec3(x, y, z))
})().compute(entityCount, [WORKGROUP_SIZE])
```

**要点:**
- `Fn(() => { ... })` はシェーダー関数を定義する。中の JavaScript は **実行時にGPUノードグラフを構築** するだけで、CPU上で毎フレーム走るわけではない
- 末尾の `()` で即時呼び出しし、`.compute(totalCount, [workgroupSize])` で compute パイプラインとして確定させる
- `WORKGROUP_SIZE = 64` が本プロジェクトの標準値
- `instanceIndex` は各スレッドが担当する要素のインデックス（WGSL の `global_invocation_id` に相当）

### TSL の主要ノード関数一覧（本プロジェクトで使用）

| カテゴリ | 関数 | 用途 |
|---------|------|------|
| バッファ | `storage(attribute, type, count)` | GPU Storage Buffer の参照ノードを生成 |
| バッファ | `.element(index)` | バッファの特定要素にアクセス |
| バッファ | `.toReadOnly()` | 読み取り専用マーク（GPU最適化ヒント） |
| バッファ | `.toVar()` | 中間変数としてローカルに確保 |
| バッファ | `.assign(value)` | バッファ要素への書き込み |
| 定数 | `uniform(value)` | CPU から毎フレーム更新できるユニフォーム値 |
| 定数 | `float(n)`, `int(n)` | スカラーリテラル |
| ベクトル | `vec3(x, y, z)` | 3次元ベクトル構築 |
| 算術 | `.add()`, `.sub()`, `.mul()`, `.div()`, `.negate()` | 四則演算 |
| 算術 | `mix(a, b, t)` | 線形補間 (GLSL の mix) |
| 算術 | `clamp(v, min, max)` | 値の範囲制限 |
| 算術 | `normalize(v)`, `length(v)` | ベクトル正規化・長さ |
| 三角関数 | `sin(x)`, `cos(x)` | GPU上の三角関数 |
| 条件分岐 | `select(condition, trueVal, falseVal)` | 条件選択（WGSL の select） |
| 比較 | `.greaterThan()`, `.lessThan()`, `.lessThanEqual()`, `.abs()` | 比較演算 |
| インデックス | `instanceIndex` | 現在のスレッドが担当する要素番号 |
| マテリアル | `positionLocal` | ジオメトリのローカル頂点座標ノード（頂点変換に使用） |
| マテリアル | `vec3(...)` を `material.positionNode` へ接続 | 頂点位置を compute 出力＋heading 回転で構築 |

> 注: 旧版で記載していた `billboarding({...})` / `shapeCircle()` は本プロジェクトでは**使用していない**。エンティティは手書きの三角形ジオメトリを `material.positionNode` で配置・回転する（§6・§7 参照）。

---

## 3. StorageBufferAttribute によるGPUバッファ管理

### 技術: CPU → GPU データ転送と GPU 間バッファ共有

```js
import { StorageBufferAttribute } from 'three/webgpu'

// CPU で作った Float32Array を GPU Storage Buffer にラップ
const inputAttribute = new StorageBufferAttribute(rawFloat32Array, 1)  // stride=1: flat配列
const outputAttribute = new StorageBufferAttribute(new Float32Array(count * 3), 3)  // stride=3: vec3配列

// TSL ノードとして参照
const inputNode = storage(inputAttribute, 'float', totalElements).toReadOnly()
const outputNode = storage(outputAttribute, 'vec3', entityCount)
```

**要点:**
- 第2引数は1要素あたりの float 数（stride）。flat バッファは `1`、vec3 バッファは `3`
- `.toReadOnly()` を付けると GPU が書き込みバリアを省略でき高速化
- 同じ `StorageBufferAttribute` を compute の出力かつ描画の入力として使うことで、**GPU間でデータコピーなしに共有** できる

---

## 4. Uniform による CPU → GPU パラメータ更新

### 技術: `uniform()` の `.value` プロパティによる毎フレーム更新

```js
const timeNode = uniform(0)
const scaleNode = uniform(1.0)

// compute shader 定義時に参照
const computeNode = Fn(() => {
  // timeNode や scaleNode をノードグラフ内で使う
})().compute(count, [64])

// 毎フレーム CPU から値を差し替え
timeNode.value = elapsedTime
scaleNode.value = newScale

// 更新した値で compute を再実行
renderer.compute(computeNode)
```

**要点:**
- `uniform()` で作ったノードの `.value` を書き換えるだけで、次の `renderer.compute()` に反映される
- compute shader の再コンパイルは不要。パイプラインは初回に1度だけ構築される
- 本プロジェクトでは `playbackTime`, `loopDuration`, `centerLon`, `centerLat`, `worldScale` 等を uniform で管理

---

## 5. renderer.compute() による Compute Shader 実行

### 技術: R3F の `useFrame` 内から `renderer.compute()` を呼ぶ

```js
import { useFrame, useThree } from '@react-three/fiber'

function MovingEntitiesLayer() {
  const renderer = useThree((state) => state.gl)

  useFrame((state) => {
    const playbackTime = state.clock.elapsedTime % LOOP_DURATION
    // uniform を更新してから compute 実行
    playbackTimeNode.value = playbackTime
    renderer.compute(computeNode)
  })
}
```

**要点:**
- `useThree((s) => s.gl)` で WebGPURenderer インスタンスを取得
- `renderer.compute(computeNode)` は同期的に GPU コマンドをキューイングする
- R3F のレンダリングループ内で呼ぶことで、compute → 描画の順序が保証される
- 初回は `useEffect` 内で `renderer.compute()` を1回呼び、バッファを空のまま描画しないようにする

---

## 6. Compute 出力と描画の直接接続

### 技術: `positionNode` に compute 出力＋heading 回転を接続するゼロコピー描画

```js
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { cos, float, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl'

const material = new MeshBasicNodeMaterial({
  color: '#ffffff',
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
})

// compute の出力（補間・投影済み位置と進行方向）を取得
const rawPos = system.positionNode.element(instanceIndex)
const heading = system.headingNode.element(instanceIndex)
const cosH = cos(heading)
const sinH = sin(heading)

// 各インスタンスの三角形ローカル頂点を heading で回転し、投影位置へ平行移動する
const lx = positionLocal.x
const ly = positionLocal.y
const rotatedX = lx.mul(cosH).sub(ly.mul(sinH))
const rotatedY = lx.mul(sinH).add(ly.mul(cosH))

material.positionNode = vec3(
  rotatedX.add(rawPos.x),
  rotatedY.add(rawPos.y),
  float(0)
)
```

**要点:**
- `MeshBasicNodeMaterial` は `three/webgpu` のノードベースマテリアル。TSL ノードを各種プロパティに接続できる
- `positionNode` にノードを設定すると、頂点シェーダーの位置計算を完全にカスタマイズできる
- `billboarding` / `shapeCircle` / `opacityNode` / `alphaTest` は使わない。代わりに `positionLocal`（ローカル頂点）を `cos`/`sin` で回転して進行方向（heading）を表現する
- compute が書き込んだ `positionNode`・`headingNode` をそのまま参照するため、**CPU を経由せずに GPU 上でデータが流れる**

---

## 7. InstancedMesh による大量エンティティ描画

### 技術: InstancedMesh + 三角形ジオメトリ + compute 位置

```js
import { BufferGeometry, Float32BufferAttribute, InstancedMesh, Matrix4 } from 'three'

// 手書きの三角形ジオメトリ（3頂点）。先端が進行方向を指す
const s = ENTITY_SIZE
const geometry = new BufferGeometry()
geometry.setAttribute('position', new Float32BufferAttribute([
  0, s, 0,                // 先端
  -s * 0.5, -s * 0.5, 0,  // 左後方
  s * 0.5, -s * 0.5, 0,   // 右後方
], 3))

const mesh = new InstancedMesh(geometry, material, entityCount)

// 位置は compute shader が決めるので、行列はすべて単位行列
const identityMatrix = new Matrix4()
for (let i = 0; i < entityCount; i++) {
  mesh.setMatrixAt(i, identityMatrix)
  mesh.setColorAt(i, getEntityColor(buffer, i))
}

mesh.frustumCulled = false  // 全エンティティが視野内にある前提
```

**要点:**
- 各インスタンスは `PlaneGeometry` の四角ではなく、手書きの三角形 `BufferGeometry`（3頂点）。三角形の向きで進行方向を視覚化する
- 位置・回転は `material.positionNode` が compute 出力（`positionNode` / `headingNode`）から計算するため、`setMatrixAt` は単位行列で初期化するだけ
- `setColorAt` でエンティティ種別ごとの色を CPU 側で設定（航空機: `#ffd166`、船舶: `#66d9ff`）
- `frustumCulled = false` でフラスタムカリングを無効化（compute が位置を管理するため Three.js のバウンディングボックスが正確でない）

---

## 8. R3F の `<primitive>` による Three.js オブジェクトの直接マウント

### 技術: 手動構築した Three.js オブジェクトを R3F のシーングラフに挿入

```jsx
// useMemo で Three.js オブジェクトを構築
const { mesh } = useMemo(() => {
  const mesh = new InstancedMesh(geometry, material, count)
  // ... 設定 ...
  return { mesh }
}, [deps])

// R3F の JSX ツリーに挿入
return <primitive object={mesh} />
```

**要点:**
- R3F は通常 `<mesh>`, `<instancedMesh>` 等の宣言的 API を使うが、compute shader と連携する複雑なオブジェクトは手動構築して `<primitive>` で挿入するのが実用的
- `useMemo` で構築し、`useEffect` のクリーンアップで `dispose()` する

---

## 9. GPU リソースのライフサイクル管理

### 技術: init / update / destroy パターン

```js
export function createInterpolationPass(rawBuffer, options) {
  // ... バッファ・ノード・compute 構築 ...

  return {
    positionNode,        // 描画側が参照するノード
    positionAttribute,   // StorageBufferAttribute

    init(renderer) {
      renderer.compute(computeNode)  // 初回実行
    },

    update(renderer, playbackTime, nextOptions) {
      // uniform 更新 + compute 再実行
      playbackTimeNode.value = playbackTime
      renderer.compute(computeNode)
    },

    destroy() {
      computeNode.dispose()  // GPU リソース解放
    },
  }
}
```

**R3F 側の統合:**

```jsx
useEffect(() => {
  system.init(renderer)
  return () => {
    geometry.dispose()
    material.dispose()
    system.destroy()
  }
}, [renderer, resources])

useFrame((state) => {
  system.update(renderer, state.clock.elapsedTime % LOOP_DURATION, options)
})
```

**要点:**
- Compute パスはプレーンなファクトリ関数として定義し、R3F のコンポーネントツリーとは分離する
- `useEffect` で初期化・破棄、`useFrame` で毎フレーム更新という分担
- `computeNode.dispose()` を呼ばないと GPU パイプラインやバッファがリークする

---

## 10. Stride ベースの Flat バッファレイアウト

### 技術: 構造化データを単一の Float32Array に Pack する

```js
export const OBSERVATION_STRIDE = 12  // 1エンティティ = 12 floats

export const OBSERVATION_OFFSET = {
  lon: 0, lat: 1, alt: 2, timestamp: 3,
  prevLon: 4, prevLat: 5, prevAlt: 6, prevTimestamp: 7,
  speed: 8, heading: 9, type: 10, status: 11,
}

// CPU側: パック
buffer[baseIndex + OBSERVATION_OFFSET.lon] = lonValue

// GPU側（TSL）: 読み出し
const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()
const lon = rawObservationNode.element(baseIndex.add(int(OBSERVATION_OFFSET.lon))).toVar()
```

**要点:**
- WebGPU の Storage Buffer は flat な数値配列。構造体は stride + offset で表現する
- CPU と GPU が **同じ定数ファイル** (`observationLayout.js`) を共有することでレイアウトの不整合を防ぐ
- GPU 側では `int(instanceIndex).mul(int(STRIDE))` で各エンティティの先頭を計算し、`.add(int(OFFSET.field))` で各フィールドにアクセスする
- 型情報を持たない float の羅列なので、整数値（type, status）も float としてパックする

---

## 11. GPU 上での地理座標投影（複数図法対応）

### 技術: `projectLonLatGPU()` で lon/lat → world 座標変換

`src/gis/projectionGPU.js` の `projectLonLatGPU(lonNode, latNode, uniforms, projectionType)` が投影の中核。まず経度を `-PI..PI` にラッピングしてラジアンへ変換し、図法ごとの関数に振り分ける。

```js
export function projectLonLatGPU(lonNode, latNode, uniforms, projectionType = 'equirectangular') {
  const { wrappedLambda, phi } = wrapLambdaAndPhi(lonNode, latNode, uniforms)
  const projectionFn = PROJECTIONS[projectionType] ?? equirectangularProjection
  return projectionFn(wrappedLambda, phi, uniforms)
}
```

経度ラッピングと図法分岐:

```js
// 日付変更線ラッピング: -PI..PI に正規化
function wrapLambdaAndPhi(lonNode, latNode, uniforms) {
  const { centerLonNode, centerLatNode } = uniforms
  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()

  const wrappedPositive = select(
    lambda.greaterThan(float(PI)), lambda.sub(float(TAU)), lambda
  ).toVar()
  const wrappedLambda = select(
    wrappedPositive.lessThan(float(-PI)), wrappedPositive.add(float(TAU)), wrappedPositive
  ).toVar()
  return { wrappedLambda, phi }
}

const PROJECTIONS = {
  equirectangular: equirectangularProjection,        // x = λ·cos(φ_0)·scale, y = φ·scale
  mercator: mercatorProjection,                       // x = λ·scale, y = ln(tan(π/4 + φ/2))·scale
  'lambert-cylindrical': lambertCylindricalProjection,// x = λ·cos(φ_0)·scale, y = sin(φ)·scale
  'natural-earth': naturalEarthProjection,            // d3-geo-projection 準拠の多項式疑似円筒
}
```

**要点:**
- 対応図法は4種: `equirectangular`（等距円筒）/ `mercator`（メルカトル）/ `lambert-cylindrical`（ランベルト正積円筒）/ `natural-earth`（Natural Earth I）。`projectionType` で切り替える
- 日付変更線（±180度）をまたぐデータのために、lambda を `-PI..PI` にラッピングする
- `cos(centerLat)` は CPU 側で事前計算し uniform で渡す（GPU 上での不必要な再計算を避ける）
- `projectLonLatToWorld()` という別の CPU 関数は存在しない。CPU 側（GeojsonLayer のジオメトリ生成）と GPU 側（MovingEntitiesLayer の compute 実行）が**同一の `projectLonLatGPU` を共用**することで座標系を一致させる

---

## 12. GPU 上での時間ベース線形補間

### 技術: prev/current 観測値間を playbackTime で blend

```js
const normalizedPlayback = playbackTimeNode.div(loopDurationNode).toVar()
const playbackTimestamp = mix(prevTimestamp, timestamp, normalizedPlayback).toVar()
const timestampSpan = timestamp.sub(prevTimestamp).toVar()
const blend = clamp(
  playbackTimestamp.sub(prevTimestamp).div(timestampSpan),
  float(0), float(1)
).toVar()

const currentLon = mix(prevLon, lon, blend).toVar()
const currentLat = mix(prevLat, lat, blend).toVar()

// 補間結果を投影して位置バッファへ書き込む
projectedPosition.assign(projectLonLatGPU(currentLon, currentLat, projUniforms, projUniforms.projectionType))

// heading を観測バッファから読み、度→ラジアン変換して heading バッファへ出力
const headingOut = headingNode.element(instanceIndex)
const headingDeg = rawObservationNode
  .element(baseIndex.add(int(OBSERVATION_OFFSET.heading)))
  .toVar()
headingOut.assign(headingDeg.mul(DEG2RAD))
```

**要点:**
- `playbackTime` (0..loopDuration) を正規化し、前回/現在のタイムスタンプ区間に写す
- `mix(a, b, t)` で経度・緯度を線形補間
- `clamp(0, 1)` で範囲外を防止
- 補間後にそのまま投影関数に渡す（補間 → 投影をワンパスで実行）
- このパスは位置 (`positionNode`) に加えて **`headingNode`（進行方向, ラジアン）も出力**する。描画側 (§6) はこの heading を `cos`/`sin` で使い、三角形インスタンスの機首回転に利用する

---

## 13. パーティクル物理シミュレーション（災害パーティクルの基本形）

### 技術: 速度・寿命・反射を持つ独立粒子系の GPU 実装

初期のデモ `runBarsCompute.js`（退役整理で削除済み）で確立したこのパターンは、
現在は災害パーティクル群の共通の骨格として生きている。
`runRainCompute.js`（降雨）をテンプレートに、`runSnowCompute.js`（降雪）・
`runEmberCompute.js`（火の粉）・`runVortexCompute.js`（竜巻デブリ）が
コピーベースで派生している。storage バッファの確保・解放は
`particleBuffers.js`、風場は `src/tsl/windField.js`、地形衝突は
`src/tsl/sampleHeightField.js` の共有サンプラに切り出されている（後述 §18〜§20）。
以下は共通の骨格を最小構成で示したもの。

**4つの Storage Buffer:**
```js
const animatedPositionNode = storage(posAttr, 'vec3', count)    // 位置（読み書き）
const velocityNode = storage(velAttr, 'vec3', count)            // 速度（読み書き）
const lifeNode = storage(lifeAttr, 'float', count)              // 残り寿命（読み書き）
const maxLifeNode = storage(maxLifeAttr, 'float', count).toReadOnly()  // 最大寿命（読み取り専用）
```

**GPU上の処理フロー:**
1. 疑似ランダム jitter を速度に加算（`sin`/`cos` + `instanceIndex` + `time` でバラつきを生成）
2. 速度の大きさを `clamp` で制限
3. 位置を速度分だけ進める
4. 境界判定 → 反射（`select` で軸ごとに速度を反転）
5. 寿命を `delta` 分だけ減算
6. 寿命切れの粒子はランダムな位置・速度でリスポーン（`select(expired, respawn, current)`）

**要点:**
- `deltaNode.mul(60)` でフレームレート非依存の移動量を実現
- GPU上の疑似乱数は `sin(time * factor + instanceIndex * offset)` の組み合わせで生成（真の乱数ではないが、粒子ごとに十分異なる挙動を生む）
- 1つの compute パスで位置・速度・寿命を同時に更新

---

## 14. `key` prop によるコンポーネント再マウント戦略

### 技術: パラメータ変更時に GPU リソースを確実に再構築

```jsx
<MovingEntitiesLayer key={entityCount} entityCount={entityCount} view={WORLD_VIEW} />
```

**要点:**
- `entityCount` が変わると GPU バッファサイズが変わるため、既存バッファの resize ではなくコンポーネントごと再マウントする
- React の `key` が変わると旧コンポーネントがアンマウント → `useEffect` cleanup で `destroy()` → 新コンポーネントで `useMemo` + `useEffect` init のサイクルが回る
- WebGPU のバッファは一度作ると resize 不可なので、この戦略が最もシンプル

---

## 15. WebGPU 機能検出

### 技術: `navigator.gpu` チェックによる早期エラー

```js
if (!navigator.gpu) {
  throw new Error('このブラウザは WebGPU compute に未対応です')
}
```

**要点:**
- 全ての compute パスファクトリの先頭で `navigator.gpu` の存在を確認
- WebGL フォールバックは行わない（WebGPU 専用設計）

---

## 16. stats-gl による FPS 表示

### 技術: `stats-gl` の `Stats` パネルを `document.body` に直接追加する

FPS 表示は drei の `Html` ではなく、`src/FpsStats.jsx` が `stats-gl` ライブラリの `Stats` を使って実装している。Canvas のシーングラフ外で、DOM に直接パネルを差し込む。

```jsx
import { useEffect } from 'react'
import Stats from 'stats-gl'

function FpsStats() {
  useEffect(() => {
    const stats = new Stats({ trackGPU: false, trackCPU: false })
    stats.dom.style.position = 'fixed'
    stats.dom.style.top = '0px'
    stats.dom.style.left = '0px'
    stats.dom.style.zIndex = '9999'
    document.body.appendChild(stats.dom)

    let raf
    const loop = () => {
      stats.update()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      document.body.removeChild(stats.dom)
    }
  }, [])

  return null
}
```

**要点:**
- `stats-gl` の `Stats` インスタンスを生成し、`stats.dom` を `document.body` に append する（R3F の `<Canvas>` ツリーの外）
- `requestAnimationFrame` ループで `stats.update()` を毎フレーム呼んで計測する
- アンマウント時に `cancelAnimationFrame` と `removeChild` でクリーンアップする
- `useFrame` や drei の `Html`、エンティティ数表示は使っていない

---

## 17. Vite のチャンク分割戦略

### 技術: WebGPU 関連モジュールの優先度付きコード分割（Rolldown）

このプロジェクトの Vite (8 / Rolldown) では `build.rolldownOptions.output.codeSplitting.groups` でチャンク分割する。各グループは `{ name, test: /正規表現/, priority }` で定義し、`test` がモジュール ID にマッチするか、`priority` が高いものから割り当てられる。

```js
// vite.config.js
build: {
  chunkSizeWarningLimit: 1000,
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [
          { name: 'react',       test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
          { name: 'fiber',       test: /node_modules[\\/]@react-three[\\/]fiber[\\/]/,       priority: 25 },
          { name: 'drei',        test: /node_modules[\\/]@react-three[\\/]drei[\\/]/,        priority: 24 },
          { name: 'three-webgpu', test: /node_modules[\\/]three[\\/](src[\\/]renderers[\\/]webgpu|build[\\/]three\.webgpu)/, priority: 23 },
          { name: 'three-tsl',   test: /node_modules[\\/]three[\\/](src[\\/]nodes|build[\\/]three\.tsl)/, priority: 22 },
          { name: 'three-core',  test: /node_modules[\\/]three[\\/]/,                        priority: 20 },
          { name: 'vendor',      test: /node_modules[\\/]/,                                  priority: 10 },
        ],
      },
    },
  },
}
```

**要点:**
- Rollup の `manualChunks(id)` 関数ではなく、Rolldown の `codeSplitting.groups`（宣言的な `{ name, test, priority }` 配列）を使う
- `test` は文字列マッチではなく**正規表現**。`priority` が高いグループから順に判定される
- Three.js の WebGPU レンダラー (`three-webgpu`) と TSL ノードシステム (`three-tsl`) を独立チャンクに分離。priority により `three-core` (20) より先にマッチする

---

## 18. パーティクルバッファの定型化（particleBuffers.js）

### 技術: フィールド定義から storage バッファ群を一括生成・破棄

災害パーティクル（雨・雪・火の粉・竜巻デブリ）は「複数の storage バッファを確保 →
compute から参照 → destroy でまとめて解放」という同じ定型を持つ。この定型を
`createParticleBuffers(count, fields)` に切り出した。

```js
import { createParticleBuffers } from '../compute/particleBuffers'

const buffers = createParticleBuffers(particleCount, {
  pos: { itemSize: 3, data: initialPositions }, // 初期値付き
  vel: 3,                                        // ゼロ初期化（itemSize だけ）
  life: 1,
})
buffers.nodes.pos.element(instanceIndex) // compute / vertex から参照
buffers.dispose(renderer)                // destroy 時にまとめて解放
```

- `fields` の各値は `itemSize`（number）か `{ itemSize, data }`。`itemSize` 1/2/3/4 が
  それぞれ float/vec2/vec3/vec4 に対応する
- `dispose()` は内部で `disposeStorageAttributes()` を呼ぶ（standalone な
  StorageBufferAttribute はジオメトリ非経由なので明示解放が必要）
- **ランナー自体は抽象化しない**。update Fn の中身（物理）は災害ごとに本質的に
  異なるため、共有するのはバッファ定型・風場・高さサンプラの 3 部品に絞り、
  `runXxxCompute.js` は `runRainCompute.js` をテンプレートにコピーベースで派生させる

---

## 19. 風場の共有 Fn（windField.js）

### 技術: FBM 乱流 + 突風 + 渦を「位置・時刻 → 風力」の Fn にまとめる

3 オクターブの sin/cos FBM + 突風を `createWindField()` として切り出した。
戻り値 `windAt(pos, time)` が風力 vec3 を返す（フレームスケールは呼び出し側で乗算）。
strength / scale は uniform でも JS 数値でも渡せる。

```js
const { windAt } = createWindField({
  turbScale, turbStrength, gustFrequency, gustStrength, // uniform 可
  timeScale, yDamping, gustSpatialScale,
  vortex, // 省略可: { center(vec2 uniform), radius, tangential, inflow, updraft }
})
const windForce = windAt(currentPos, timeNode).mul(frameScale)
```

- `vortex` を渡すと Rankine 渦近似の渦項（接線 + 中心吸引 + コア内上昇気流）が
  合成される。竜巻（`runVortexCompute.js`）が使用し、`center` を CPU で毎フレーム
  動かすと竜巻本体が移動する
- 雨は弱い乱流、雪は横流れの強い乱流、というようにパラメータ差だけで質感を作り分ける

---

## 20. 地形ハイトフィールドの共有（HeightFieldContext + sampleHeightField.js）

### 技術: DEM の GPU バッファを 1 つだけ持ち、バイリニアサンプラを配布する

地形の高さは `TerrainLayer` が `onHeightData` で発行する `heightInfo`
（`{ heights, cols, rows, terrainWidth, terrainDepth, minY, rangeY }`）に集約される。
これを `HeightFieldContext`（Provider）が受け取り、DEM の `StorageBufferAttribute` を
**1 個だけ**生成して全消費者に配る。消費者ごとに DEM の GPU コピーが増えるのを防ぐ。

```jsx
// Provider（Scene をラップ）
<HeightFieldProvider>{/* TerrainLayer が setHeightInfo、各災害が useHeightField */}</HeightFieldProvider>

// 消費側
const { heightInfo, gpu } = useHeightField()
const sampler = gpu?.sampler // { heightAt, normalAt, elevationAt }
groundY = sampler.heightAt(vec2(pos.x, pos.z)) // compute 内でバイリニア補間
```

- サンプラは `src/tsl/sampleHeightField.js` の `createHeightFieldSampler()`。
  `groundField.js`（手続きマウンド版）と同じ `{ heightAt, normalAt, elevationAt }`
  インターフェースを持ち、高さ源が DEM か手続き地形かを消費者が意識しない
- **バイリニア補間**に統一（旧 RainLayer は最近傍だった）。草の接地・雨/雪/火の粉の
  地形衝突・竜巻デブリのスポーンがすべて同じ実装を共有し、精度が揃う
- CPU 側で座標を決める用途（落雷点・竜巻中心の接地）には同ファイルの
  `cpuHeightAt(heightInfo, x, z)` を使う（GPU と同式）
- `elevationAt`（正規化標高 0..1）は雪線・草の生育域・山火事の延焼判定で使う

---

## 技術マップ総括

```
┌─────────────────────────────────────────────────────┐
│  React Layer                                         │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ App.jsx │  │ Scene.jsx    │  │ FpsStats.jsx   │  │
│  │ Canvas  │  │ OrbitControls│  │ stats-gl Stats │  │
│  │ gl=async│  │ useFrame     │  │ → document.body│  │
│  └────┬────┘  └──────┬───────┘  └────────────────┘  │
│       │              │                               │
│  ┌────▼──────────────▼───────────────────────────┐   │
│  │  R3F Integration                              │   │
│  │  <primitive object={mesh}/>                   │   │
│  │  useThree(s => s.gl) → WebGPURenderer         │   │
│  │  useFrame → system.update() → renderer.compute│   │
│  │  key={count} → remount for buffer resize      │   │
│  └───────────────────┬───────────────────────────┘   │
└──────────────────────┼───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│  GPU Compute Layer (TSL)                              │
│  ┌───────────────┐  ┌────────────────────────────┐   │
│  │ Projection    │  │ Interpolation              │   │
│  │ Pass          │  │ Pass                       │   │
│  │               │  │                            │   │
│  │ lon/lat →     │  │ prev ──mix(blend)──→ curr  │   │
│  │ projectLonLat │  │ curr ──project──→ world    │   │
│  │ GPU(4図法)    │  │ heading ──→ headingNode    │   │
│  │ → world xyz   │  │                            │   │
│  └───────┬───────┘  └─────────────┬──────────────┘   │
│          │                        │                   │
│  ┌───────▼────────────────────────▼──────────────┐   │
│  │  StorageBufferAttribute (GPU Memory)          │   │
│  │  ┌──────────────┐  ┌───────────────────────┐  │   │
│  │  │ observation  │  │ projectedPosition     │  │   │
│  │  │ buffer       │  │ buffer                │  │   │
│  │  │ (input, RO)  │  │ (output, RW)          │  │   │
│  │  │ stride=12    │  │ stride=3 (vec3)       │  │   │
│  │  └──────────────┘  └───────────┬───────────┘  │   │
│  └────────────────────────────────┼──────────────┘   │
│                                   │                   │
│  ┌────────────────────────────────▼──────────────┐   │
│  │  Render (zero-copy from compute output)       │   │
│  │  MeshBasicNodeMaterial                        │   │
│  │    .positionNode = rotate(triangle, heading)  │   │
│  │                    + positionNode             │   │
│  │  InstancedMesh of 三角形 BufferGeometry        │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```
