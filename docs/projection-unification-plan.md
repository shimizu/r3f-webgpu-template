# 投影処理の GPU 一本化計画

## 背景

lon/lat → ワールド座標の投影ロジックが CPU と GPU に重複実装されている。

| 実装 | ファイル | 環境 | 用途 |
|------|---------|------|------|
| `projectLonLatToWorld()` | `src/gis/projection.js` | CPU | GeoJSON 静的データ |
| compute shader 直書き | `src/compute/createProjectionPass.js` | GPU | 移動体の単発投影 |
| `createProjectedNode()` | `src/compute/createInterpolationPass.js` | GPU | 移動体の補間+投影 |

### 問題

- 投影式の変更時に CPU/GPU の3箇所を同期する必要がある
- CPU 版を維持する技術的理由がない

## 目標

**CPU 版投影（`projection.js`）を廃止し、GPU 投影に一本化する。**

## 設計

### 核心: earcut に投影座標は不要

現在の GeojsonLayer は投影後のワールド座標で earcut を実行しているが、
earcut は 2D トポロジーを決めるだけなので **lon/lat をそのまま渡せる**。
等距円筒図法は線形変換であり、lon/lat 空間での三角形分割結果は投影後も有効。

```
現在:  lon/lat → CPU投影 → worldXY → earcut → BufferGeometry → 描画
変更後: lon/lat → normalizeLon(centerLon基準) → earcut → 正規化済みlon/latを頂点属性に格納 → GPU投影(positionNode) → 描画
```

### レイヤー構成

```
┌──────────────────────────────────────┐
│  投影パラメータ (projectionOptions.js) │
└──────────────────┬───────────────────┘
                   │
                   ▼
         ┌───────────────────┐
         │ GPU 投影関数       │
         │ projectionGPU.js  │
         │                   │
         │ projectLonLatGPU()│
         └────────┬──────────┘
                  │
       ┌──────────┼──────────┐
       ▼          ▼          ▼
  GeojsonLayer  Interpolation  Projection
  (positionNode) Pass          Pass
```

### 新設ファイル: `src/gis/projectionGPU.js`

```javascript
import { float, select, vec3 } from 'three/tsl'

const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

/**
 * lon を centerLon 基準で [-180, +180] の範囲に正規化する。
 * earcut 前処理用。GPU 側の wrappedLambda と同じ折り返し規約。
 *
 * @param {number} lon - 経度（度数法）
 * @param {number} centerLon - 中心経度（度数法）
 * @returns {number} 正規化された経度
 */
export function normalizeLon(lon, centerLon) {
  let offset = lon - centerLon
  while (offset > 180) offset -= 360
  while (offset < -180) offset += 360
  return offset + centerLon
}

/**
 * lon/lat の TSL ノードを受け取り、投影済みワールド座標の vec3 ノードを返す。
 * プロジェクト唯一の投影関数。
 *
 * @param {Node} lonNode - 経度（度数法）の TSL ノード
 * @param {Node} latNode - 緯度（度数法）の TSL ノード
 * @param {Object} uniforms - { centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode }
 * @returns {Node} vec3(worldX, worldY, 0)
 */
export function projectLonLatGPU(lonNode, latNode, uniforms) {
  const { centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode } = uniforms

  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()

  const wrappedPositive = select(
    lambda.greaterThan(float(PI)), lambda.sub(float(TAU)), lambda
  ).toVar()
  const wrappedLambda = select(
    wrappedPositive.lessThan(float(-PI)), wrappedPositive.add(float(TAU)), wrappedPositive
  ).toVar()

  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}
```

### 新設ファイル: `src/gis/projectionUniforms.js`

```javascript
import { uniform } from 'three/tsl'
import { resolveProjectionOptions } from './projectionOptions'

const DEG2RAD = Math.PI / 180

/**
 * 投影パラメータから TSL uniform セットを生成する。
 * 各レイヤー/pass が独立にインスタンスを生成・保持する。
 */
export function createProjectionUniforms(options = {}) {
  const resolved = resolveProjectionOptions(options)

  const centerLonNode = uniform(resolved.centerLon)
  const centerLatNode = uniform(resolved.centerLat)
  const worldScaleNode = uniform(resolved.worldScale)
  const cosCenterLatNode = uniform(Math.cos(resolved.centerLat * DEG2RAD))

  return {
    centerLonNode, centerLatNode, worldScaleNode, cosCenterLatNode,

    update(nextOptions) {
      if (typeof nextOptions.centerLon === 'number') {
        centerLonNode.value = nextOptions.centerLon
      }
      if (typeof nextOptions.centerLat === 'number') {
        centerLatNode.value = nextOptions.centerLat
        cosCenterLatNode.value = Math.cos(nextOptions.centerLat * DEG2RAD)
      }
      if (typeof nextOptions.worldScale === 'number') {
        worldScaleNode.value = nextOptions.worldScale
      }
    },
  }
}
```

### GeojsonLayer の修正（最大の変更点）

#### 変更前
- `projectLonLatToWorld()` で CPU 投影した座標を earcut に渡す
- `Float32BufferAttribute` にワールド座標を格納
- `meshBasicMaterial` で描画

#### 変更後
- earcut には **centerLon 基準で正規化した lon/lat** を渡す（CPU 投影は不要）
- 頂点属性に **正規化済み lon/lat を格納**（position.x = normalizedLon, position.y = lat, position.z = 0）
- マテリアルの `positionNode` で `projectLonLatGPU()` を使い GPU 投影
- ライン・ポイントも同様に lon/lat → positionNode で GPU 投影

```javascript
// GeojsonLayer 内のマテリアル設定（概要）
import { projectLonLatGPU } from '../gis/projectionGPU'
import { createProjectionUniforms } from '../gis/projectionUniforms'

const projUniforms = createProjectionUniforms(view)
// position 属性に lon/lat が入っている
const lonNode = positionLocal.x
const latNode = positionLocal.y
material.positionNode = projectLonLatGPU(lonNode, latNode, projUniforms)
```

#### サンプリング（`appendSampledSegment`）について
現在の大円補間サンプリングは CPU 投影と密結合している。
等距円筒図法では直線セグメントで十分なため、サンプリングを簡略化できる。
ただし将来的に非線形図法を追加する場合は GPU 側でテッセレーションが必要になる。
初期段階では CPU 投影だけを除去し、lon/lat 空間での線形補間による densify は維持する。

### 既存 compute pass の修正

#### `createInterpolationPass.js`
- ローカルの `createProjectedNode()` を削除
- `projectLonLatGPU()` と `createProjectionUniforms()` を import して使用

#### `createProjectionPass.js`
- 投影計算の直書きを `projectLonLatGPU()` に委譲
- uniform 生成を `createProjectionUniforms()` に委譲

### 削除するファイル

- `src/gis/projection.js` — CPU 版投影関数。全利用箇所を GPU 版に移行後に削除

## ファイル構成（変更後）

```
src/gis/
  projectionGPU.js        ← 唯一の投影関数（新設）
  projectionUniforms.js   ← uniform 管理（新設）
  projectionOptions.js    ← パラメータ解決（既存・変更なし）
  views.js                ← ビュー定義（既存・変更なし）
  projection.js           ← 削除

src/compute/
  createProjectionPass.js        ← projectionGPU に委譲
  createInterpolationPass.js     ← 同上。ローカル関数削除

src/layers/
  GeojsonLayer.jsx        ← lon/lat 頂点 + positionNode で GPU 投影
```

## 設計上の補足

- **uniform の ownership**: 各レイヤー/pass が独立に `createProjectionUniforms()` を呼び、自身のインスタンスを保持・更新・破棄する
- **earcut の精度**: lon/lat 空間での三角形分割は、極地方（高緯度）で経度方向の歪みが大きくなるが、等距円筒図法を使う限り描画結果は正しい（投影後の見た目と一致する）
- **lineSegments / points**: mesh と同様に positionNode で GPU 投影できる。MeshBasicNodeMaterial → LineBasicNodeMaterial / PointsNodeMaterial に相当するノードマテリアルを使う

## 反経線（lon 180/-180）の対応

日本中心（centerLon=139.82）などで描画する場合、反経線は太平洋上（lon ≈ -40）に移動し、
ヨーロッパ〜アフリカ付近のポリゴンが反経線をまたぐことになる。これを正しく扱う必要がある。

### 方針: centerLon 基準の lon 正規化

earcut に渡す前に、`projectionGPU.js` の `normalizeLon()` で全 lon 値を `[centerLon - 180, centerLon + 180]` の範囲に正規化する。

**例: centerLon = 139.82（日本中心）**
- 有効範囲: [-40.18, 319.82]
- lon = -170（太平洋）→ 190（正規化後。earcut は連続平面として処理）
- lon = -30（大西洋）→ -30（変化なし。反経線の手前）

**これにより:**
- earcut が見る lon/lat 平面と、GPU 投影の `wrappedLambda` が同じ折り返し基準になる
- ポリゴン分割は不要。座標の正規化だけで earcut と GPU 投影が整合する
- 180度以上の経度幅を持つポリゴン（南極大陸の一部等）は例外だが、実用上は稀

### line / point 用ノードマテリアル

- `LineBasicNodeMaterial` / `PointsNodeMaterial` は `NodeMaterial` を継承しており、`positionNode` に対応済み（three.js ソースで確認済み）
- 現在の `lineBasicMaterial` / `pointsMaterial` をそのままノードマテリアル版に差し替える

### サンプリング（`appendSampledSegment`）

- 現在のサンプリングは CPU 投影と密結合しているが、線分密度と point 密度の生成も兼ねている
- **対応方針**: 投影を除去し lon/lat 空間での線形補間のみ残す（densify 機能は維持）。CPU 投影への依存だけを切る

## 実装上の注意

### `normalizeLon()` の配置と管理

- `normalizeLon()` は GPU 投影の `wrappedLambda` と同じ折り返し規約を CPU 側で持つ前処理
- **`projectionGPU.js` に同居させる** — 折り返し規約の変更時に GPU 投影とセットで見直されることを保証する
- ファイル名は「GPU」だが、`normalizeLon()` は CPU で実行される。JSDoc で「earcut 前処理用。GPU 側の wrappedLambda と対になる」と明記する

### パラメータ変更時の挙動の違い

| パラメータ | compute pass（移動体） | GeojsonLayer |
|-----------|----------------------|--------------|
| `worldScale` | uniform 更新のみ | uniform 更新のみ |
| `centerLat` | uniform 更新のみ | uniform 更新のみ |
| `centerLon` | uniform 更新のみ | **ジオメトリ再生成が必要** |

- GeojsonLayer は正規化済み lon/lat を頂点属性に持つため、`centerLon` が変わると earcut からやり直す必要がある
- 現在の `useMemo` 依存配列 `[geojson, view]` により `view.centerLon` 変更時に自動で再生成される
- コードコメントで「centerLon 変更 = geometry 再構築」であることを明記する

## 作業順序

1. `src/gis/projectionGPU.js` を新設
2. `src/gis/projectionUniforms.js` を新設
3. `createInterpolationPass.js` を修正（ローカル関数削除、import に切り替え）
4. `createProjectionPass.js` を修正（投影計算を委譲）
5. `GeojsonLayer.jsx` を修正:
   - lon を centerLon 基準で正規化する `normalizeLon()` を追加
   - earcut に正規化済み lon/lat を渡すように変更
   - 頂点属性を正規化済み lon/lat に変更
   - マテリアルに positionNode を設定して GPU 投影
   - `projectLonLatToWorld` の import を削除
   - `appendSampledSegment` から投影を除去し lon/lat 空間での densify に変更
   - マテリアルを `LineBasicNodeMaterial` / `PointsNodeMaterial` に差し替え
6. `src/gis/projection.js` を削除
7. 動作確認:
   - `WORLD_VIEW`（centerLon=0）で GeoJSON が正しく描画されること
   - `TOKYO_BAY_VIEW`（centerLon=139.82）に切り替えて、反経線付近のポリゴンが破綻しないこと
   - 移動体が GeoJSON と同じ座標系に正しく重なること
   - ロシア・フィジー等の反経線またぎポリゴンが正しく表示されること
   - ライン密度と points 密度が変更前と同等であること
   - `npm run lint` が通ること
