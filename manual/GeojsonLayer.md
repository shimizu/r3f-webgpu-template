# GeojsonLayer

GeoJSON をフェッチしてベクター地図（線・点・塗り）を GPU 投影で描画するレイヤー。

## 概要

指定 URL の GeoJSON を読み込み、CPU 側で頂点の正規化・日付変更線クリップ・（ポリゴンは earcut で）三角形分割を行い、頂点に生の lon/lat を格納する。描画時に頂点シェーダー（TSL）が `projectLonLatGPU` で lon/lat を現在の図法のワールド座標へ投影する。ポリゴン塗り（LABELRANK で緑系に色分け）・線（水色）・点（白）の 3 種を同時に描く。現在の `Scene.jsx` では未マウントで、import のみトグル運用で保持されている（lookdev 中に有効化／無効化を切り替えるため。CLAUDE.md 参照）。

## 前提・依存

- 配置前提: **`<Coordinate>` 配下必須**。`useProjection()` で `{ view, projUniforms, projectionType }` を取得して投影する
- 連携: 投影パラメータは `<Coordinate>` から供給される。`view.centerLon` / `sampleLonStep` / `sampleLatStep` によってサンプリング密度が決まる。earcut に依存

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| url | string | （必須） | 読み込む GeoJSON の URL（例: `/data/world.geojson`） |
| altitude | number | 0.025 (Z_OFFSET) | 投影面からの浮かせ量。投影フレームの +Z（回転後の world +Y）方向。地形などの上に線を出したいときに上げる |

線色・点サイズ・塗り色などはモジュール内定数（`LINE_STYLE` / `POINT_STYLE` / `FILL_COLORS`）で定義され props では変更できない。

## 使用例

```jsx
import Coordinate from './gis/CoordinateContext'
import GeojsonLayer from './layers/GeojsonLayer'

<Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
  <GeojsonLayer url='/data/world.geojson' />
  {/* 地形の上に線を浮かせる場合 */}
  <GeojsonLayer url='/data/coastline.geojson' altitude={0.1} />
</Coordinate>
```

## 調整のポイント

- 線分は図法により曲線になるため、`appendSampledSegment` で地理座標系のまま細かく分割してサンプリングされる（`view.sampleLonStep` / `sampleLatStep`、既定 0.2 度）
- 日付変更線をまたぐ大きな移動は乱れの原因になるためスキップ（`|Δlon| > 180` を除外）
- ポリゴン塗りは `feature.properties.LABELRANK` に応じて `FILL_COLORS`（2〜7）で色分け、既定色は `#52b788`、不透明度 0.6
- geometry は `geojson` と `view` を依存に、material は `projUniforms` と `projectionType` を依存に再生成。すべてアンマウント時に `dispose()` される
- url フェッチ失敗時は `console.error` を出し `null` を返す（クラッシュしない）

## 関連

- ソース: `src/layers/GeojsonLayer.jsx`
- 関連: 投影は `src/gis/projectionGPU.js` / `CoordinateContext.jsx`。移動体は `MovingEntitiesLayer`。図法数式は `docs/projection-formulas.md`
