# RainLayer

GPU パーティクルによる降雨レイヤー。地形衝突とスプラッシュ表現つき。

## 概要

多数の雨粒を GPU compute で移流させ、速度方向に引き伸ばしたストリークとして描画する降雨レイヤー。地形（共有ハイトフィールド）に衝突するとスプラッシュ粒子が飛び、着地位置が地表に沿う。天候演出で「雨を降らせたい」ときに使う。`intensity`（雨量）は uniform 駆動で、粒数の見え方と風の強さが連動して変化する（再コンパイルなし）。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（`useHeightField()` で地形サンプラを取得）。サンプラ未発行の間は y=0 平面への衝突になる
- 連携: 地形衝突は `HeightFieldContext` の共有 GPU サンプラを使う（`heightInfo` prop は廃止済み）。Scene 側では雨が TerrainLayer の「濡れ」目標も駆動する（連動は `deriveLayerInputs`）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `position` | `[x,y,z]` | `[0, 0, 0]` | レイヤーの配置位置 |
| `width` | `number` | `15` | 散布領域の幅（X） |
| `depth` | `number` | `13` | 散布領域の奥行き（Z） |
| `topY` | `number` | `8` | 雨の発生高さ（レイヤーローカル） |
| `particleCount` | `number` | `30000` | 雨粒の総数 |
| `rainSpeed` | `number` | `0.08` | 落下速度 |
| `wind` | `[x,y,z]` | `[0.01, 0, 0.005]` | 風ベクトル。inline 配列を渡しても成分値で依存するため再生成されない |
| `intensity` | `number` | `1` | 雨量 0..1（uniform 駆動。粒数の見え方と風の強さが連動） |

## 使用例

Scene.jsx では `inputs.rainActive && heightInfo` を条件にマウントし、散布域を地形フットプリントに合わせている。

```jsx
{inputs.rainActive && heightInfo && (
  <RainLayer
    position={[0, 0.5, 0]}
    width={heightInfo.terrainWidth}   // 地形フットプリントに合わせる
    depth={heightInfo.terrainDepth}
    topY={6}
    particleCount={15000}
    intensity={inputs.rainIntensity}  // 天候フォルダ / シナリオ由来
  />
)}
```

## 調整のポイント

- 雨量の増減は `intensity` を動かす。uniform 駆動なので resources 再生成が起きずコストが低い
- `particleCount` / `width` / `depth` / `topY` / `rainSpeed` / `wind` の変更は `useMemo` 依存に入っており、変わると GPU リソースが全再生成される。多用しない
- `wind` は必ず安定参照（モジュール定数 or 成分固定）で渡すこと。inline 新規配列でも成分値で依存するため問題ないが、意図しない再生成を避けたいなら定数化推奨
- ストリーク長・幅・不透明度・スプラッシュ等の見た目定数はファイル冒頭の調整用パラメータで固定（props ではない）
- 粒数が多いと GPU 負荷が上がる。Scene の実使用では 15000 に抑えている

## 関連

- ソース: `src/layers/RainLayer.jsx` / `src/compute/runRainCompute.js`
- 依存: `src/gis/HeightFieldContext.jsx`（共有ハイトフィールド）
- 関連: `SnowLayer`（本レイヤーの派生）、`TerrainLayer`（濡れ表現）、`docs/rain-terrain-collision.md`
