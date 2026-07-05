# GrassLayer

GPU インスタンスによる草原レイヤー（全ブレードを 1 ドローコールで描画）。

## 概要

多数の草ブレードを 1 つの `InstancedBufferGeometry`・1 ドローコールで描画する GPU ファーストのレイヤー。CPU は初期化時に per-instance 属性（配置 XZ・yaw・個体差）を詰めるだけで、以降の per-frame 更新は一切しない。形状（円弧カール・コヒーレント風揺れ・接地）はすべて頂点ステージの `positionNode` で計算する。カバレッジマスク外のブレードは高さ・幅を 0 に潰して消す（GPU カリング）。接地は `terrain=false` で手続きマウンド（groundField）、`terrain=true` で HeightFieldContext の DEM 高さ場（バイリニア補間）に切り替わる。細かいパラメータ（密度・被覆率・草丈・風・色・生育標高域など）は leva「草」フォルダから uniform 駆動で調整する。

## 前提・依存

- 配置前提: `terrain=false` はどこでも可。`terrain=true` は `HeightFieldProvider` 配下 + heightInfo 到着後
- `terrain=true` では HeightFieldContext（Scene の Provider + TerrainLayer の `onHeightData`）が heightInfo を発行するまで何も描画しない
- DEM 接地時は RainLayer の地形衝突と同じ storage buffer（共有サンプラ）を使う
- leva「草」フォルダの多数のパラメータでランタイム調整（下記）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| area | number | 40 | 散布する正方形の一辺（レイヤーローカル単位。`terrain` 時は無視され地形フットプリントを使用） |
| maxCount | number | 100000 | 生成ブレード数（`density` で間引く） |
| position | [x,y,z] | [0,0,0] | 配置位置 |
| terrain | boolean | false | true で HeightFieldContext の DEM 高さ場に接地 |
| seaLevel | number | 0 | 正規化標高（TerrainLayer と同じ値）。leva「生育下限標高」の初期値にのみ使用 |
| bladeScale | number | 1 | 草丈・葉幅の一括倍率（leva 値に乗算。DEM 上でスケールを合わせる） |

### leva「草」フォルダのパラメータ

| ラベル | キー | 既定値 | 説明 |
|--------|------|--------|------|
| 密度 | density | 0.15 | 表示ブレード比率（instanceCount のみ変更、再生成なし） |
| 被覆率 | coverage | 0.62 | カバレッジマスクの被覆率 |
| パッチスケール | maskScale | 0.15 | マスクの空間周波数 |
| パッチ境界 | maskEdge | 0.25 | マスク境界のぼかし幅 |
| 草丈 | bladeHeight | 0.8 | ブレードの高さ（`bladeScale` を乗算） |
| 葉幅 | bladeWidth | 0.035 | ブレードの幅（`bladeScale` を乗算） |
| カール | curl | 1.14 | 円弧カールの全角 |
| 風の強さ | windStrength | 0.5 | 揺れの振幅 |
| 風速 | windSpeed | 1.8 | gust 波の進行速度 |
| 風向° | windDirection | 20 | 風向（度） |
| 突風サイズ | gustSize | 0.35 | gust 波の空間周波数 |
| フラッター | flutter | 0.6 | ブレード個体の細かい揺れ |
| 根元色 | colorBase | '#33421b' | 根元のカラー |
| 先端色 | colorTip | '#9bc24a' | 先端のカラー |
| 個体色差 | colorVar | 0.47 | 個体ごとの色ばらつき |
| 透過光 | translucency | 0.6 | 逆光トランスルーセンシーの強さ |
| 起伏の高さ | moundDepth | 0.55 | 手続きマウンドの起伏（`terrain=false` のみ） |
| 起伏スケール | moundScale | 0.12 | マウンドの空間周波数（`terrain=false` のみ） |
| 生育下限標高 | elevMin | seaLevel+0.01 | 生育の下限（DEM モードのみ有効。正規化標高） |
| 生育上限標高 | elevMax | 1 | 生育の上限（既定 1 は山頂まで） |
| 標高フェード幅 | elevFade | 0.04 | 生育域境界のフェード幅 |

## 使用例

Scene.jsx の切替構成（leva「草」フォルダの表示トグル + 配置セレクタ）:

```jsx
{/* ステージ床版 */}
{showGrass && grassPlacement === 'floor' && (
  <GrassLayer area={40} position={[0, -1, 0]} />
)}

{/* 地形(DEM)版: heightInfo 到着後にマウント */}
{showGrass && grassPlacement === 'terrain' && heightInfo && (
  <GrassLayer
    terrain
    seaLevel={region.seaLevel}
    bladeScale={0.4}
    position={[0, 0.5, 0]}
  />
)}
```

## 調整のポイント

- 密度は `geometry.instanceCount` の変更だけでスケールする（ジオメトリ再生成なし）。負荷が高ければ leva「密度」を下げる
- DEM 接地時は `bladeScale`（Scene では 0.4）で地形スケールに草丈を合わせる。等倍だと草が巨大になりやすい
- 生育標高域（elevMin / elevMax）は DEM モードのみ有効。水没域を避けるには elevMin を上げる
- 草配置は決定的（mulberry32, seed=1337）なのでリロードで同じ配置が再現される（lookdev の比較に有利）
- `terrain=true` で region に土地被覆データ（LandCoverContext）があれば、散布時の
  rejection sampling で草地系クラス（grass/crops/shrub）にのみ配置される。全インスタンスが
  有効配置になるため density の意味（≒見える本数）が保たれる。ロード中はマウント保留。
  データの無い region は従来の無条件散布と bit 同一
- `maxCount` は初期化時のバッファサイズ。増やすと初期化コストとメモリが増える
- uniform 駆動なので leva 操作で再コンパイルは走らない

## 関連

- ソース: `src/layers/GrassLayer.jsx`
- 関連: `src/layers/groundField.js`（手続きマウンド接地）, `src/gis/HeightFieldContext.jsx`（DEM 高さ場共有）, `src/tsl/coverageMask.js`
- 連携レイヤー: `TerrainLayer`（heightInfo 発行元）, `RainLayer`（同じ高さ場サンプラを共有）
