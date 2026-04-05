# WaterHeightfieldLayer 実装プラン

## 前回の失敗原因

1. **StorageTexture の textureLoad/textureStore が動作しなかった** — このプロジェクトで未使用の API
2. **複数の storage() ノードが同一 GPU バッファを共有しない** — compute の書き込みがマテリアルに反映されない
3. **法線パスの後に update が走りデータが破壊された** — ピンポン管理の複雑さが原因

## 対策

- **StorageBufferAttribute** を使用（`runBarsCompute.js` で実績あり）
- **1つの storage() ノードを compute と描画で共有**（`runBarsCompute.js` と同じパターン）
- **update + normal を1パスに統合**（余計なステップを排除）
- **まず in-place（1バッファ）で試す**（race condition の影響が小さければ採用）

## Step 1: 波動シミュレーション compute

### バッファ構成

```
StorageBufferAttribute(Float32Array(256 * 256 * 4), 4)
1セルあたり vec4: [height, velocity, normalX, normalZ]
合計: 65,536 セル = 1,048,576 bytes
```

### compute ノード（update + normal 統合）

```
instanceIndex → 2D座標 (x, y)
  x = instanceIndex % 256
  y = instanceIndex / 256 (整数除算)

近傍インデックス（境界クランプ）:
  left  = max(0, x-1) + y * 256
  right = min(255, x+1) + y * 256
  up    = x + max(0, y-1) * 256
  down  = x + min(255, y+1) * 256

波動方程式:
  average = (hLeft + hRight + hUp + hDown) * 0.25
  velocity += (average - height) * 2.0
  velocity *= 0.995
  height += velocity

法線計算:
  nx = height - hRight
  nz = height - hDown

書き込み:
  element(instanceIndex).assign(vec4(height, velocity, nx, nz))
```

### drop compute ノード

```
セル座標 → UV (0~1)
距離 = length(uv - center) / radius
drop = max(0, 1 - 距離)
dropVal = 0.5 - cos(drop * π) * 0.5
height += dropVal * strength
```

### エクスポート API

```js
createWaterSimulation() → {
  dataNode,    // storage() ノード — compute が書き、マテリアルが読む（同一ノード）
  simSize,     // 256
  init(renderer),
  update(renderer),
  addDrop(x, z, radius, strength),
  destroy()
}
```

### in-place vs ピンポン

- `runBarsCompute.js` は1バッファ in-place で動作（各パーティクルは独立）
- 波動方程式は近傍を読むので理論的にはピンポンが必要
- **まず in-place で試す** — GPU の実行順序で部分的に古い値を読む可能性があるが、視覚的影響は小さい可能性
- ダメなら2バッファに切り替え（ただし同一 storage ノードの共有問題を解決する必要あり）

## Step 2: メッシュ変位

### ジオメトリ

```
PlaneGeometry(2, 2, 200, 200)
rotation: [-PI/2, 0, 0]  → XZ 平面
scale: [width/2, height/2, 1]
```

### positionNode

```js
const uvCoord = uv()
const gridX = int(floor(uvCoord.x.mul(float(SIM_SIZE - 1))))
const gridY = int(floor(uvCoord.y.mul(float(SIM_SIZE - 1))))
const index = gridY.mul(SIM_SIZE).add(gridX)

const info = dataNode.element(index)  // 同一 storage ノード
const heightDisp = info.x.mul(heightScale)

material.positionNode = vec3(
  positionLocal.x,
  positionLocal.y.add(heightDisp),
  positionLocal.z
)
```

### normalNode

```js
const nx = info.z.mul(normalScale)
const nz = info.w.mul(normalScale)
const ny = sqrt(max(0, 1 - nx*nx - nz*nz))
material.normalNode = vec3(nx, ny, nz).normalize()
```

## Step 3: クリックで波紋

```js
onPointerDown = (event) => {
  if (!event.uv) return
  sim.addDrop(event.uv.x, event.uv.y, 0.03, 0.015)
}
```

- UV はそのまま drop の center として使用（0~1 範囲）
- drop compute を次フレームで実行

## Step 4: 見た目の調整

### マテリアル

```
MeshPhysicalNodeMaterial:
  transmission: 0.6
  ior: 1.333
  roughness: 0.12
  attenuationColor: '#064a3e'
  attenuationDistance: 2.5
```

### カラー

```
高さに応じたグラデーション:
  shallow: '#48c9b0' (ターコイズ)
  deep:    '#0c5c52' (エメラルド)
```

### チューニングパラメータ

| パラメータ | 初期値 | 用途 |
|---|---|---|
| heightScale | 2.0 | 変位の振幅スケール |
| normalScale | 8.0 | 法線の強調度 |
| WAVE_STIFFNESS | 2.0 | 波の伝播速度 |
| WAVE_DAMPING | 0.995 | 減衰率 |
| dropRadius | 0.03 | クリック波紋の半径 |
| dropStrength | 0.015 | クリック波紋の強さ |
| 初期ドロップ数 | 15 | init 時のランダム波紋 |

## 参照ファイル

| ファイル | 参照箇所 |
|---|---|
| `src/compute/runBarsCompute.js` | storage + element + assign パターン、1バッファ in-place |
| `src/layers/MovingEntitiesLayer.jsx:54` | vertex shader で storage ノードを読む実例 |
| `docs/webgpu-water-reference.md` | 波動方程式・法線・drop の詳細アルゴリズム |
| `reference/webgpu-water/src/shaders/water/update.frag.wgsl` | 波動方程式の WGSL 実装 |

## 検証方法

1. `npm run dev` でブラウザ確認
2. 水面に初期波紋が見えるか（init 時の 15 ドロップ）
3. 波が時間経過で伝播・減衰するか
4. クリックで新しい波紋が広がるか
5. 法線が正しく計算され、光の反射パターンが波に追従するか
