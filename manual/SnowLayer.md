# SnowLayer

GPU パーティクルによる降雪レイヤー。低速落下・横流され・着地静止フェード。

## 概要

RainLayer をテンプレートにした派生レイヤー。雪片を GPU compute でゆっくり落下させ、風で横に流し、view 空間 billboard の小さなクアッドとして描画する。回転は compute を使わず vertex 内で `time × 個体位相` から計算し、個体ごとにサイズ差をつける。着地後は静止残量に応じてフェードアウトする（スプラッシュはなし）。天候演出で「雪を降らせたい」ときに使う。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（`useHeightField()` で地形サンプラを取得）。サンプラ未発行の間は y=0 平面への着地になる
- 連携: 地形への積雪（堆積）表現は本レイヤーでは扱わない。TerrainLayer の堆積は Scene 側が `snowing`（時定数追従）で別途駆動する。SnowLayer は降雪パーティクルのみ

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `position` | `[x,y,z]` | `[0, 0, 0]` | レイヤーの配置位置 |
| `width` | `number` | `15` | 散布領域の幅（X） |
| `depth` | `number` | `13` | 散布領域の奥行き（Z） |
| `topY` | `number` | `8` | 雪の発生高さ（レイヤーローカル） |
| `particleCount` | `number` | `12000` | 雪片の総数 |
| `snowSpeed` | `number` | `0.012` | 落下速度（雨より遅い） |
| `wind` | `[x,y,z]` | `[0.006, 0, 0.003]` | 風ベクトル。成分値で依存するため inline 配列でも再生成されない |
| `intensity` | `number` | `1` | 雪量 0..1（uniform 駆動。粒数の見え方と風の強さが連動） |

## 使用例

Scene.jsx では `inputs.snowActive && heightInfo` を条件にマウントし、散布域を地形フットプリントに合わせている。

```jsx
{inputs.snowActive && heightInfo && (
  <SnowLayer
    position={[0, 0.5, 0]}
    width={heightInfo.terrainWidth}   // 地形フットプリントに合わせる
    depth={heightInfo.terrainDepth}
    topY={6}
    particleCount={12000}
    intensity={inputs.snowIntensity}  // 天候フォルダ / シナリオ由来
  />
)}
```

## 調整のポイント

- 雪量の増減は `intensity` を動かす。uniform 駆動なので低コスト
- `particleCount` / `width` / `depth` / `topY` / `snowSpeed` / `wind` の変更は `useMemo` 依存に入っており、変わると GPU リソースが全再生成される
- 雪片のサイズ・回転速度・不透明度などの見た目定数はファイル冒頭の調整用パラメータで固定（props ではない）
- 地面に積もった見た目が欲しい場合は SnowLayer 単体では不十分。TerrainLayer の堆積（`snowAmount` / `snowing`）を併用する

## 関連

- ソース: `src/layers/SnowLayer.jsx` / `src/compute/runSnowCompute.js`
- 依存: `src/gis/HeightFieldContext.jsx`（共有ハイトフィールド）
- 関連: `RainLayer`（テンプレート元）、`TerrainLayer`（積雪堆積）
