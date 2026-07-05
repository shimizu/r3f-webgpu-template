# StageLayer

チェッカーボード模様のステージ床レイヤー。

## 概要

明暗 2 色のタイルを市松（チェッカーボード）状に並べた床と、その下に敷くベース台からなるジオラマステージ。タイルは `InstancedMesh` で 1 メッシュにまとめ、`setColorAt` で市松の色分けを行う。タイルはクリアコート付きの `meshPhysicalMaterial`、ベース台は `meshStandardMaterial`。GridLayer の代わりに使う撮影台のような床。現在の `Scene.jsx` では未マウントで、import のみトグル運用で保持されている（lookdev 中に有効化／無効化を切り替えるため。CLAUDE.md 参照）。

## 前提・依存

- 配置前提: なし
- 連携: タイル・ベースともに `receiveShadow`。IBL / LightingRig の照明で質感が出る

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| columns | number | 16 | タイルの列数 |
| rows | number | 10 | タイルの行数 |
| tileSize | number | 2.2 | 1 タイルの一辺サイズ（ワールド単位） |
| position | [x,y,z] | [0,0,0] | ステージ全体の配置位置 |

タイル色（bright/dark）・材質・ベース台の寸法はモジュール内定数（`TILE_COLORS` / `TILE_MATERIAL` / `BASE`）で定義され props では変更できない。

## 使用例

```jsx
import StageLayer from './layers/StageLayer'

// 既定（16×10 タイル）
<StageLayer />

// 小さめの正方ステージ
<StageLayer columns={8} rows={8} tileSize={2} position={[0, -1, 0]} />
```

## 調整のポイント

- タイルは `(column + row) % 2` で明暗を市松に振り分ける
- 床の実サイズは `columns * tileSize` × `rows * tileSize`。ベース台は `BASE.padding` ぶん外側に広がる
- `useLayoutEffect` で `instanceMatrix` / `instanceColor` を設定するため、columns/rows/tileSize 変更時に再構築される

## 関連

- ソース: `src/layers/StageLayer.jsx`
- 関連: 青グリッド床は `GridLayer`。マテリアル基準は `MaterialSamplesLayer`
