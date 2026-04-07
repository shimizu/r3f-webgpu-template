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
| マテリアル | `billboarding({ position, horizontal, vertical })` | ビルボード変換 |
| マテリアル | `shapeCircle()` | 円形マスク生成 |

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

### 技術: `positionNode` を `material.vertexNode` に渡すゼロコピー描画

```js
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { billboarding, instanceIndex, shapeCircle } from 'three/tsl'

const material = new MeshBasicNodeMaterial({
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
})

// compute の出力ノードを直接描画の頂点位置として使用
material.vertexNode = billboarding({
  position: system.positionNode.element(instanceIndex),
  horizontal: true,
  vertical: true,
})
material.opacityNode = shapeCircle()
material.alphaTest = 0.5
```

**要点:**
- `MeshBasicNodeMaterial` は `three/webgpu` のノードベースマテリアル。TSL ノードを各種プロパティに接続できる
- `vertexNode` にノードを設定すると、頂点シェーダーの位置計算を完全にカスタマイズできる
- `opacityNode` に `shapeCircle()` を接続すると、四角ポリゴンが円形に見えるマスクを自動生成する
- compute が書き込んだ `positionNode` をそのまま参照するため、**CPU を経由せずに GPU 上でデータが流れる**

---

## 7. InstancedMesh による大量エンティティ描画

### 技術: InstancedMesh + ビルボード + compute 位置

```js
import { InstancedMesh, Matrix4, PlaneGeometry } from 'three'

const geometry = new PlaneGeometry(ENTITY_SIZE, ENTITY_SIZE, 1, 1)
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
- `PlaneGeometry` の小さな四角形を1インスタンスとし、最大100万個を1ドローコールで描画
- 位置は `vertexNode` で compute 出力から取るため、`setMatrixAt` は単位行列で初期化するだけ
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

## 11. GPU 上での地理座標投影（等距円筒図法）

### 技術: Compute Shader 内で lon/lat → world 座標変換

```js
function createProjectedNode(lonNode, latNode, worldScaleNode, centerLonNode, centerLatNode, cosCenterLatNode) {
  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()

  // 日付変更線ラッピング: -PI..PI に正規化
  const wrappedPositive = select(
    lambda.greaterThan(float(PI)),
    lambda.sub(float(TAU)),
    lambda
  ).toVar()
  const wrappedLambda = select(
    wrappedPositive.lessThan(float(-PI)),
    wrappedPositive.add(float(TAU)),
    wrappedPositive
  ).toVar()

  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}
```

**要点:**
- 等距円筒図法: `x = (lon - centerLon) * cos(centerLat) * scale`, `y = (lat - centerLat) * scale`
- 日付変更線（±180度）をまたぐデータのために、lambda を `-PI..PI` にラッピングする
- `cos(centerLat)` は CPU 側で事前計算し uniform で渡す（GPU 上での不必要な再計算を避ける）
- CPU側の `projectLonLatToWorld()` と GPU側のこの関数は同じ数式を使い、GeojsonLayer と MovingEntitiesLayer の座標系を一致させる

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
```

**要点:**
- `playbackTime` (0..loopDuration) を正規化し、前回/現在のタイムスタンプ区間に写す
- `mix(a, b, t)` で経度・緯度を線形補間
- `clamp(0, 1)` で範囲外を防止
- 補間後にそのまま投影関数に渡す（補間 → 投影をワンパスで実行）

---

## 13. パーティクル物理シミュレーション（レガシーパス）

### 技術: 速度・寿命・反射を持つ独立粒子系の GPU 実装

`runBarsCompute.js` に実装された汎用パーティクルシステム（現在は GIS パスに置き換え済みだが技術的に重要）。

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

## 16. drei の Html コンポーネントによる HUD オーバーレイ

### 技術: 3Dシーン上に HTML DOM を重ねる

```jsx
import { Html } from '@react-three/drei'

function PerformanceHud({ entityCount }) {
  const [fps, setFps] = useState(0)

  useFrame((_, delta) => {
    // 0.25秒ごとにFPSを再計算
    sampleRef.current.frames += 1
    sampleRef.current.elapsed += delta
    if (sampleRef.current.elapsed >= 0.25) {
      setFps(Math.round(sampleRef.current.frames / sampleRef.current.elapsed))
      sampleRef.current.frames = 0
      sampleRef.current.elapsed = 0
    }
  })

  return (
    <Html prepend>
      <div className='stats-panel'>
        <span>{entityCount.toLocaleString()} entities</span>
        <span>{fps} FPS</span>
      </div>
    </Html>
  )
}
```

**要点:**
- `<Html prepend>` は DOM 要素を Canvas の前面に配置する
- `useFrame` で delta を積算し、サンプリング間隔を設けることで setState の呼び出し頻度を抑える

---

## 17. Vite のチャンク分割戦略

### 技術: WebGPU 関連モジュールの優先度付きコード分割

```js
// vite.config.js
manualChunks(id) {
  const priorities = [
    { match: 'react-dom', name: 'react', priority: 30 },
    { match: '@react-three/fiber', name: 'fiber', priority: 25 },
    { match: '@react-three/drei', name: 'drei', priority: 24 },
    { match: 'three/src/renderers/webgpu', name: 'webgpu-three', priority: 23 },
    { match: 'three/src/nodes', name: 'tsl-nodes', priority: 22 },
    { match: 'three', name: 'three-core', priority: 20 },
    { match: 'node_modules', name: 'vendor', priority: 10 },
  ]
}
```

**要点:**
- Three.js の WebGPU レンダラーと TSL ノードシステムを独立チャンクに分離
- 優先度マッチングにより、`three/src/renderers/webgpu` が `three` より先にマッチする
- WebGPU 対応ブラウザでのみ必要なコードを遅延ロード可能にする設計

---

## 技術マップ総括

```
┌─────────────────────────────────────────────────────┐
│  React Layer                                         │
│  ┌─────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ App.jsx │  │ Scene.jsx    │  │ Html (drei)    │  │
│  │ Canvas  │  │ OrbitControls│  │ PerformanceHud │  │
│  │ gl=async│  │ useFrame     │  │                │  │
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
│  │ equirectangular│ │ curr ──project──→ world    │   │
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
│  │    .vertexNode = billboarding(positionNode)   │   │
│  │    .opacityNode = shapeCircle()               │   │
│  │  InstancedMesh (up to 1M instances)           │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```
