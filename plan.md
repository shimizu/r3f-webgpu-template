# ジオラマ GIS 可視化計画

## 方針転換

当初は「GPU First の地理空間可視化基盤」として、リッチ地図テンプレートを目指していた。しかし実際の開発を通じて、プロジェクトは **ジオラマ風ステージ上に GIS 機能を統合する方向** へ進化した。

この方向を正式な軸とする。

## コンセプト

ミニチュアジオラマの卓上に、地形・海・空・天候が揃った箱庭世界がある。その舞台の上で、地理空間データが GPU 駆動で動く。地図アプリではなく、「触れる地球儀の中身を覗く」ような体験を作る。

## 現状の達成物

### ジオラマ舞台（lookdev 環境）

| レイヤー | 役割 | 状態 |
|---|---|---|
| SkyLayer | Preetham 大気散乱 + アニメ雲 | 稼働中 |
| GridLayer | 工作マット風 400×400 床面 | 稼働中 |
| MaterialSamplesLayer | PBR サンプル球体 5 種 + CubeCamera 反射 | 稼働中 |
| WaterBoxLayer | TSL 波高シミュレーション水面 | 稼働中 |
| WaterBlobLayer | パルス変形水面 | 稼働中 |
| WaterOceanLayer | ノーマルマップスクロール海面 | 稼働中 |
| LightingRig | ambient / hemisphere / directional / spot | 稼働中 |
| StudioEnvironment | RoomEnvironment IBL | 稼働中 |
| SceneEffects | Bloom + Godrays | 稼働中 |
| TerrainLayer | GeoTIFF DEM + ガウスぼかし | 実装済み・未配置 |
| RainLayer | GPU 雨粒 + 地形衝突スプラッシュ | 実装済み・未配置 |
| StageLayer | チェッカーボード床 | 実装済み・未配置 |

### GIS 機能

| 要素 | 役割 | 状態 |
|---|---|---|
| BaseMapLayer | GeoJSON 海岸線の LineSegments + Points 描画 | 稼働中 |
| MovingEntitiesLayer | GPU 補間パーティクル（船舶・航空機 billboard） | 稼働中 |
| createProjectionPass | GPU 等距円筒投影 | 実装済み |
| createInterpolationPass | GPU 時刻補間 + 投影 | 稼働中 |
| projection.js | CPU 等距円筒投影（BaseMapLayer 用） | 稼働中 |
| mockObservations.js | ダミー移動体データ生成 | 稼働中 |

### スケール関係

現在の WORLD_VIEW（worldScale: 4.6）では、地球全体が約 4.6 ユニット幅に収まる。GridLayer の 400×400 ユニットの中では非常に小さい。ジオラマの一部として地図を「テーブルの上の地球儀」のように見せるにはこのスケールで問題ないが、地形レイヤーや天候レイヤーと空間的に連携するには view 設定の調整が必要になる。

## 設計思想

### ジオラマが主、GIS が客

地図 SDK を作るのではない。ジオラマ世界の中に GIS データを「展示物」として置く。

- ジオラマ舞台のルック（照明、空、ポストエフェクト）が全体の画を支配する
- GIS データはその舞台の上で動く演出要素
- カメラ操作はジオラマ鑑賞が基本（MapControls のまま）
- GIS 特有の UI（パンニング、ズームレベル切替）は最小限に留める

### GPU は演出の中核

CPU はデータ受信とパッキングに徹し、GPU が投影・補間・移流・衝突・描画属性を担う。この原則は旧 plan.md から変わらない。

### 既存の lookdev パターンを GIS に転用する

RainLayer の GPU パーティクル + 地形衝突パターンは、GIS パーティクルにそのまま応用できる:

- `StorageBufferAttribute` による位置・速度・寿命管理
- `runRainCompute.js` の height map サンプリング → 地形上に GIS パーティクルを配置
- スプラッシュ生成 → GIS イベントトリガーのエフェクトに転用
- 3D FBM 風場 → ベクトル場粒子の移流に転用

新機能をゼロから設計するより、Rain/Terrain のパターンを GIS 文脈で再利用する。

## レイヤー体系

### ジオラマ基盤レイヤー（変更なし）

- SkyLayer — 空と雲
- GridLayer — 工作マット床面
- LightingRig — 照明セット
- SceneEffects — Bloom / Godrays

### 素材展示レイヤー（lookdev）

- MaterialSamplesLayer — PBR マテリアルリファレンス
- WaterBoxLayer / WaterBlobLayer / WaterOceanLayer — 水面シミュレーション各種

### 地形レイヤー

- TerrainLayer — DEM 地形メッシュ（GIS パーティクルの衝突面としても機能）

### 天候レイヤー

- RainLayer — GPU 雨パーティクル + 地形衝突スプラッシュ

### GIS レイヤー

- BaseMapLayer — GeoJSON 海岸線・行政界
- MovingEntitiesLayer — GPU 移動体パーティクル
- TrailLayer — GPU リングバッファ軌跡（未実装）
- FlowFieldLayer — ベクトル場粒子（未実装）

## ロードマップ

### Phase A: ジオラマ + GIS の空間統合（現在地）

**完了済み:**
- BaseMapLayer を XZ 床面に回転配置
- MovingEntitiesLayer の billboarding 位置を XZ 変換
- leva で entityCount を実行時調整

**残作業:**
- TerrainLayer と GIS レイヤーの空間的整合（DEM 上に地図を重ねる）
- view 設定の調整（worldScale とジオラマスケールの関係を詰める）
- BaseMapLayer の投影を GPU に統一する（現在 CPU 投影で二重実装）

### Phase B: 地形連携 GIS パーティクル

TerrainLayer の DEM を GIS パーティクルの衝突面として活用する。RainLayer のパターンを転用。

- 移動体パーティクルが地形高さに追従して走る
- 海上の船舶は海面レイヤーの波高に追従
- 航空機は高度に応じた Y 位置で飛行
- 地形上にアイコンやマーカーを GPU で配置

### Phase C: GPU トレイル

移動体の軌跡を GPU リングバッファで保持・描画する。

- 各移動体に固定長の履歴スロット
- 現在位置更新時に最新トレイル頂点を書き込み
- 古い頂点は循環上書き
- age ベースのフェードを shader で計算
- トレイルが地形面に沿って走る

### Phase D: ベクトル場粒子

風や海流を高密度パーティクルで可視化する。RainLayer の風場パターンを拡張。

- `u/v` グリッドデータから compute で粒子を移流
- 寿命・リスポーン・速度連動の色変更
- ジオラマの空気の流れとして自然に見える演出
- 地形との干渉（山で風が巻く、谷に沿って流れる）

### Phase E: 演出の統合

GIS データとジオラマ演出を融合させる。

- 移動体の発光を Bloom で強調
- 海上トラフィックと海面シミュレーションの視覚的統合
- 天候（雨）と移動体の共存シーン
- 昼夜切替で移動体の見え方を変える

## Compute パス構成

### 既存（稼働中）

| パス | ファイル | 役割 |
|---|---|---|
| Projection | createProjectionPass.js | lon/lat → XY 投影 |
| Interpolation | createInterpolationPass.js | 時刻補間 + 投影 |
| Rain | runRainCompute.js | 雨粒物理 + 地形衝突 + スプラッシュ |
| Bars | runBarsCompute.js | ランダムウォーク粒子（退役候補） |

### 追加予定

| パス | 役割 | ベースにするパターン |
|---|---|---|
| Trail Update | リングバッファ軌跡更新 | runBarsCompute の lifecycle 管理 |
| Flow Advection | ベクトル場粒子移流 | runRainCompute の風場 + 寿命管理 |
| Terrain Snap | GIS 座標を DEM 高さに吸着 | runRainCompute の height map サンプリング |

## バッファ設計

### 移動体（既存）

- `rawObservationBuffer` — lon, lat, alt, timestamp, prev 値, speed, heading, type, status（STRIDE=12）
- `projectedPositionAttribute` — GPU 投影済み vec3

### トレイル（Phase C で追加）

- `trailPositionBuffer` — エンティティ × 履歴長の vec3 リングバッファ
- `trailMetaBuffer` — 書き込みヘッド、age

### ベクトル場（Phase D で追加）

- `vectorFieldTexture` — u/v グリッド
- `flowParticleBuffer` — position, life, seed, speed

## ファイル構成方針

現在のフラットな `src/layers/` 構成を維持する。ジオラマレイヤーと GIS レイヤーを同じディレクトリに並べる。

```
src/
├── compute/
│   ├── createProjectionPass.js      # 既存
│   ├── createInterpolationPass.js   # 既存
│   ├── runRainCompute.js            # 既存
│   ├── runBarsCompute.js            # 退役候補
│   ├── createTrailUpdatePass.js     # Phase C
│   └── createFlowAdvectionPass.js   # Phase D
├── gis/
│   ├── projection.js                # 既存（GPU 統一後は縮小）
│   ├── projectionOptions.js         # 既存
│   └── views.js                     # 既存
├── layers/
│   ├── SkyLayer.jsx                 # ジオラマ
│   ├── GridLayer.jsx                # ジオラマ
│   ├── MaterialSamplesLayer.jsx     # lookdev
│   ├── WaterBoxLayer.jsx            # lookdev
│   ├── WaterBlobLayer.jsx           # lookdev
│   ├── WaterOceanLayer.jsx          # lookdev
│   ├── TerrainLayer.jsx             # 地形
│   ├── RainLayer.jsx                # 天候
│   ├── BaseMapLayer.jsx             # GIS
│   ├── MovingEntitiesLayer.jsx      # GIS
│   ├── TrailLayer.jsx               # GIS（Phase C）
│   └── FlowFieldLayer.jsx           # GIS（Phase D）
├── data/
│   └── mockObservations.js          # 既存
└── effects/
    ├── SceneEffects.jsx             # 既存
    ├── createBloom.js               # 既存
    ├── createDof.js                 # 既存
    └── createGodrays.js             # 既存
```

## 判断基準

新しい機能や演出を追加するときは、以下で判断する。

- ジオラマの世界観を壊していないか
- CPU で個体ごとの毎フレーム処理を増やしていないか
- 既存の lookdev パターン（Rain, Terrain, Water）を転用できないか
- GIS 専用の複雑な UI を持ち込んでいないか
- ポストエフェクトとレイヤー演出の責務が混ざっていないか

## 旧 plan.md から引き継ぐ原則

以下は方針転換後も有効:

- CPU はデータ受信・パッキング・UI 制御に限定する
- GPU は投影・補間・移流・衝突・描画属性を担う
- GeoJSON と移動体で投影ロジックを分けない
- compute パスは用途別に分割する（1 本の巨大 compute に詰めない）
- バッファは用途別に分ける

## 旧 plan.md から外す要素

以下はジオラマ方向では優先しない:

- ~~GPU 集約と LOD（Phase 5）~~ — 100 万件級の密度制御より、数万件の演出品質を優先
- ~~テーマ / スタイルプリセット切替~~ — ジオラマのルックは統一する
- ~~主題図テンプレート（choropleth, hexbin 等）~~ — 地図 SDK 的な方向には寄せない
- ~~リッチ地図テンプレート 4 層構成~~ — Scene.jsx での直接合成を維持
- ~~projection と camera fit の厳密な分離~~ — ジオラマカメラは MapControls で十分
