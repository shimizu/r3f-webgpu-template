# Labels3DLayer

3D 空間内に HTML ラベル（地名等）を表示するレイヤー。

## 概要

drei の `<Html>` を使い、指定した 3D 座標に半透明の黒背景・白文字のラベルを浮かべる。`center` と `distanceFactor={16}` により、カメラからの距離に応じてラベルがスケールし、常に中央揃えで表示される。地名などの注記を箱庭ステージ上に配置する用途。Scene では `labels={region.labels}` で地域プリセット由来のラベルを渡してマウントされている。

## 前提・依存

- 配置前提: なし（`<Coordinate>` 配下でなくてよい）。position は素の 3D ワールド座標
- 連携: `@react-three/drei` の `Html` に依存。ラベルデータは `regions.js` の `region.labels` から供給される

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| labels | Array | [] (DEFAULT_LABELS) | `{ id, text, position }` の配列。`position` は 3D ワールド座標 `[x,y,z]`、`id` は React key、`text` は表示文字列 |

ラベルの見た目（色・背景・パディング・フォント）はモジュール内定数 `LABEL_STYLE` で定義され props では変更できない。

## 使用例

```jsx
import Labels3DLayer from './layers/Labels3DLayer'

// Scene での実際の使い方（地域プリセット由来）
<Labels3DLayer labels={region.labels} />

// 手書きで渡す場合
<Labels3DLayer
  labels={[
    { id: 'tokyo', text: 'Tokyo', position: [0, 0.5, 0] },
    { id: 'osaka', text: 'Osaka', position: [-3, 0.5, 2] },
  ]}
/>
```

## 調整のポイント

- `labels` の既定値はモジュール定数 `DEFAULT_LABELS`（空配列）。inline `[]` を既定にすると毎レンダー再生成されるのを避けるためのパターン
- `distanceFactor={16}` を下げるとラベルは近づいたとき大きく、上げると小さくなる
- HTML オーバーレイなので `pointerEvents: 'none'` でカメラ操作を邪魔しない。大量に置くと DOM 負荷になる点に注意
- ラベル座標は投影後のワールド座標で指定する。GIS 座標（lon/lat）から出す場合は `regions.js` 側で投影済みの値を用意する

## 関連

- ソース: `src/layers/Labels3DLayer.jsx`
- 関連: ラベルデータ定義は `src/gis/regions.js` の `region.labels`
