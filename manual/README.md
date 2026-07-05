# レイヤー使用マニュアル

`src/layers/` の各レイヤーコンポーネントの使い方をまとめたリファレンス。
1 レイヤー = 1 ファイル。props・前提・使用例・調整ポイントを記載する。

設計思想やアーキテクチャの背景は `docs/` を参照:
- `docs/disaster-simulation-architecture.md` — 災害基盤の全体像
- `docs/rain-terrain-collision.md` — 地形衝突と共有ハイトフィールド
- `docs/webgpu-quality-enhancement.md` — ポスト処理・品質

## 前提の凡例

各レイヤーは次のいずれかの「配置前提」を持つ:

- **なし** — ワールド座標にそのまま置ける（`position` prop で移動）
- **`<Coordinate>` 配下** — GIS 投影コンテキスト内に置く必要がある（`useProjection`）
- **`HeightFieldProvider` 配下** — 地形ハイトフィールドを参照する（`useHeightField`）。
  `TerrainLayer` の `onHeightData` が発行した高さ場を待ってからマウントする

## レイヤー一覧

### 地形・地面・水
- [TerrainLayer](./TerrainLayer.md) — GeoTIFF DEM 地形（濡れ/堆積/延焼の表面表現つき）
- [GrassLayer](./GrassLayer.md) — GPU インスタンス草（1 ドローコール）
- [TreeLayer](./TreeLayer.md) — GPU インスタンス樹木（針葉樹 + 広葉樹の混在、1 ドローコール）
- [WaterOceanLayer](./WaterOceanLayer.md) — 海面（浸水・濁り対応）
- [WaterBoxLayer](./WaterBoxLayer.md) — 箱型の水面シミュレーション
- [WaterBlobLayer](./WaterBlobLayer.md) — ブロブ状の水面
- [GridLayer](./GridLayer.md) — 工作マット風グリッド床
- [StageLayer](./StageLayer.md) — チェッカーボードのステージ床

### 空・雲・大気
- [SkyLayer](./SkyLayer.md) — 空ドーム
- [CloudLayer](./CloudLayer.md) — TSL raymarching 体積雲
- [HeightFogLayer](./HeightFogLayer.md) — 高さフォグ（`scene.fogNode`）

### 災害
- [RainLayer](./RainLayer.md) — 降雨パーティクル
- [SnowLayer](./SnowLayer.md) — 降雪パーティクル
- [LightningLayer](./LightningLayer.md) — 稲妻
- [TornadoLayer](./TornadoLayer.md) — 竜巻
- [FireLayer](./FireLayer.md) — 山火事の炎・火の粉
- [SmokeLayer](./SmokeLayer.md) — 山火事の煙

### GIS・オーバーレイ
- [GeojsonLayer](./GeojsonLayer.md) — GeoJSON ベクター描画
- [MovingEntitiesLayer](./MovingEntitiesLayer.md) — GPU 移動体（船舶・航空機）
- [Labels3DLayer](./Labels3DLayer.md) — 3D 空間内の HTML ラベル

### lookdev
- [MaterialSamplesLayer](./MaterialSamplesLayer.md) — マテリアル基準サンプル球
