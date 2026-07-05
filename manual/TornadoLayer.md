# TornadoLayer

vortex 風場のデブリ + メッシュ漏斗雲による竜巻レイヤー。中心は緩い軌道で移動。

## 概要

竜巻を 2 要素で構成するレイヤー。漏斗雲は `LatheGeometry` ベースのメッシュで、vertex でノイズ揺らぎとスウェイ（上部ほど大きい蛇行）、fragment でスクロールノイズの opacity を与える（raymarch は使わず CloudLayer と steps 予算を食い合わない）。デブリ/塵は `runVortexCompute` の GPU パーティクルで、windField の vortex 項（接線 + 吸引 + 上昇気流）により螺旋上昇する。中心は `useFrame` で緩いリサージュ軌道を描き、vortex.center uniform と漏斗メッシュ位置を同期させる（React 再レンダーなし）。`strength` 0..1 が実質のマスターで、接線速度・上昇気流・不透明度に連動する。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（`useHeightField()` の `heightInfo` / GPU サンプラを使用）。中心移動と接地高さ、デブリの地形参照に必要
- 連携: 中心のリサージュ移動は毎フレーム `heightInfo.terrainWidth/Depth` から範囲を計算し、漏斗メッシュの接地位置・高さスケールを地表に合わせる

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `position` | `[x,y,z]` | `[0, 0, 0]` | レイヤーの配置位置 |
| `topY` | `number` | `4.5` | 漏斗の上端（雲底、レイヤーローカル） |
| `strength` | `number` | `1` | 0..1 マスター（uniform 駆動。接線速度・吸引・上昇気流・不透明度に連動） |
| `particleCount` | `number` | `8000` | デブリ/塵パーティクルの総数 |

## 使用例

Scene.jsx では `inputs.tornadoActive && heightInfo` を条件にマウントし、`topY` を雲高さに、`strength` を天候/シナリオ由来の値に合わせている。

```jsx
{inputs.tornadoActive && heightInfo && (
  <TornadoLayer
    position={[0, 0.5, 0]}
    topY={region.cloudHeight - 0.9}   // 漏斗上端を雲底に合わせる
    strength={inputs.tornadoStrength} // 天候フォルダ「竜巻」/ シナリオ由来
  />
)}
```

## 調整のポイント

- 竜巻の強さは `strength` を動かす。uniform 駆動なので resources 再生成なしで接線速度・吸引・上昇気流・漏斗不透明度が連動して変わる
- `particleCount` / `topY` の変更は `useMemo` 依存に入っており、変わると GPU リソースが再生成される
- 漏斗の形状（半径・プロファイルカーブ・分割・色・揺らぎ・蛇行）や vortex 既定値（特性半径・接線速度・吸引・上昇気流）、デブリのサイズ・色、中心移動のリサージュ係数はファイル冒頭の `FUNNEL` / `VORTEX_DEFAULTS` / `DEBRIS` / `WANDER` 定数で固定（props ではない）
- 漏斗雲は意図的にメッシュ方式（raymarch しない）。CloudLayer の steps 予算と競合させないため

## 関連

- ソース: `src/layers/TornadoLayer.jsx` / `src/compute/runVortexCompute.js`
- 依存: `src/tsl/windField.js`（vortex 項）、`src/tsl/valueNoise.js`（`valueFbm3`）、`src/gis/HeightFieldContext.jsx`、`src/tsl/sampleHeightField.js`（`cpuHeightAt`）
- 関連: `CloudLayer`（steps 予算を分け合う）
