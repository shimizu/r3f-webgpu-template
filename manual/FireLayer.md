# FireLayer

山火事の炎 + 火の粉を燃焼前線リングに沿って描く GPU パーティクルレイヤー。

## 概要

TerrainLayer の延焼マスク（burnField）と同じ `ignition` / `radius` を受け取り、燃焼前線リングに沿って炎と火の粉を描く。炎は縦長の billboard で fBM 形状浸食した加算グラデーション（浮力弱・寿命短で前線に張り付く）、火の粉は小さな加算粒（浮力強・風の影響大で舞い上がる）。2 つを `runEmberCompute` のパラメータ違い（炎 2500 粒 / 火の粉 4500 粒）で GPU コンピュートしている。山火事シナリオで延焼の最前線を表現するときに使う。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（`useHeightField()` でハイトサンプラを取得。地面の高さに着火点を合わせる）
- 連携: `ignition` / `radius` は TerrainLayer の burnField と同じ値を渡すこと（前線位置が地形の焼け跡と一致する）。`radius` は uniform 駆動で再コンパイルなし
- 依存モジュール: `src/compute/runEmberCompute.js`（`createEmberComputeRunner`）、`src/tsl/valueNoise.js`、`src/gis/HeightFieldContext.js`

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| position | Array | `[0, 0, 0]` | グループのワールド座標 |
| ignition | Array\|null | `null` | 発火点 `[x, z]`。TerrainLayer の burnField と同じ値を渡す |
| radius | number | 0 | 延焼半径（uniform 駆動） |
| band | number | 0.35 | 前線帯の幅 |

## 使用例

Scene.jsx での実マウント（山火事アクティブかつ heightInfo / 発火点が確定してから条件マウント）:

```jsx
{inputs.fireActive && heightInfo && fireIgnition && (
  <FireLayer
    position={[0, 0.5, 0]}
    ignition={fireIgnition}
    radius={fireRadius}
  />
)}
```

## 調整のポイント

- `radius` は uniform 駆動。Scene では延焼進行 0..1 → 地形対角の 4 割まで（`fireRadius`）にマッピングして滑らかに広げている
- `band` を広げると炎の帯が太くなり、狭めると前線が細いリングになる
- 炎・火の粉の粒数・サイズ・浮力・寿命・色はモジュール定数 `FLAME` / `EMBER` に集約（props では変えられない）
- 加算ブレンド（`AdditiveBlending`）+ `depthWrite: false`。`fog: false` で HeightFog の影響を受けない
- `frustumCulled = false`。ハイトサンプラが未取得（`heightInfo` 未ロード）だとサンプラ null で着地判定が効かないため、条件マウントで heightInfo 確定を待つこと

## 関連

- ソース: `src/layers/FireLayer.jsx`（`src/compute/runEmberCompute.js`, `src/tsl/valueNoise.js`）
- 関連: `SmokeLayer`（同じ ignition/radius で煙）、`TerrainLayer`（burnField 延焼マスク）、`docs/rain-terrain-collision.md`
