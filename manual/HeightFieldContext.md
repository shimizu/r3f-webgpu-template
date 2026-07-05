# HeightFieldContext（共有ハイトフィールド）

地形の高さ場（DEM）を全レイヤーで共有するコンテキスト。GPU バッファは 1 個だけ生成。

## 概要

TerrainLayer が `onHeightData` で発行する heightInfo を Provider が保持し、
DEM の `StorageBufferAttribute` を **1 個だけ**生成して全消費者に配布する。
草の接地・雨/雪/火の粉の地形衝突・落雷点の選定・延焼の標高判定が同じ高さ場を
共有するため、レイヤー間で「地面の解釈」がずれない。prop drilling と
消費者ごとの DEM GPU コピー増を防ぐのが目的。

## API

### `<HeightFieldProvider>`

Scene 本体をラップする（`useThree` を使うため `<Canvas>` 内必須）。
heightInfo の差し替え・アンマウント時に旧 GPU バッファを自動解放する。

### `useHeightField()`

```js
const { heightInfo, gpu, setHeightInfo } = useHeightField()
```

| 値 | 説明 |
|----|------|
| `heightInfo` | `{ heights, cols, rows, terrainWidth, terrainDepth, minY, rangeY }` \| null |
| `gpu.attribute` | heights の StorageBufferAttribute（Provider 所有。消費側で解放しない） |
| `gpu.node` | readOnly の storage ノード |
| `gpu.sampler` | `{ heightAt, normalAt, elevationAt }`（バイリニア補間の TSL Fn） |
| `setHeightInfo` | TerrainLayer の `onHeightData` に接続する setter |

Provider 外では空値（heightInfo=null）を返すので、レイヤー単体マウントでも壊れない。

### サンプラ（`src/tsl/sampleHeightField.js`）

| Fn | 入出力 | 用途 |
|----|--------|------|
| `heightAt(worldXZ)` | vec2 → float（ローカル Y） | 接地・衝突（バイリニア補間） |
| `normalAt(worldXZ)` | vec2 → vec3 | 有限差分の地形法線 |
| `elevationAt(worldXZ)` | vec2 → float（正規化標高 0..1） | 雪線・生育帯・延焼の閾値判定 |
| `cpuHeightAt(heightInfo, x, z)` | CPU 版（GPU と同式） | 落雷点・竜巻中心の接地 |

## 使用例

```jsx
// Scene.jsx — Provider でラップし、TerrainLayer と接続
function Scene(props) {
  return (
    <HeightFieldProvider>
      <SceneContent {...props} />
    </HeightFieldProvider>
  )
}
function SceneContent() {
  const { heightInfo, setHeightInfo } = useHeightField()
  return (
    <>
      <TerrainLayer url={...} onHeightData={setHeightInfo} />
      {/* heightInfo 到着を待ってから消費レイヤーをマウント */}
      {rain && heightInfo && <RainLayer width={heightInfo.terrainWidth} ... />}
    </>
  )
}
```

```js
// 消費レイヤー / compute 内
const { gpu } = useHeightField()
const sampler = gpu?.sampler ?? null
// compute シェーダー内:
const groundY = sampler.heightAt(vec2(pos.x, pos.z))
```

## 調整のポイント

- **新しいレイヤーで heights の GPU バッファを自前生成しないこと**。必ず
  `gpu.sampler` / `gpu.node` を使う（複製防止・解釈の統一）
- 消費レイヤーは「heightInfo 到着後にマウント」が基本（Scene 側で `heightInfo &&` ガード）
- 地域切替時は Scene が `setHeightInfo(null)` で旧地形を破棄 → 新 DEM ロード後に再発行。
  この間、消費レイヤーは自動的にアンマウントされる
- 等間隔格子前提のバイリニア補間。mercator / natural-earth 図法では近似になる

## 関連

- ソース: `src/gis/HeightFieldContext.jsx`, `src/tsl/sampleHeightField.js`
- ドキュメント: `docs/rain-terrain-collision.md`（データフロー全体）
- 消費者: `GrassLayer` / `TreeLayer`（接地・生育帯）, `RainLayer` / `SnowLayer` /
  `FireLayer` / `TornadoLayer`（衝突・スポーン）, `LightningLayer`（落雷点、CPU 版）
