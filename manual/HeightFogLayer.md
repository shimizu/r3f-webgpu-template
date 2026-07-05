# HeightFogLayer

距離 + 高さの指数フォグを `scene.fogNode` に設定する非描画レイヤー。

## 概要

`scene.fogNode` に、距離が伸びるほど・高さが低いほど濃くなる指数フォグを設定する非描画レイヤー（自身は `null` を返す）。地表付近に灰白の霧を溜め、雨天・盆地・湿潤なシーンの空気感を出すのに使う。マウントしっぱなしで `density` を uniform 駆動する運用が前提で、`density=0` なら見た目・負荷とも実質ゼロ。

## 前提・依存

- 配置前提: なし（Scene 直下でよい）
- 運用上の注意: **常時マウントし `density` を uniform で駆動すること**。条件マウントにするとトグルごとに全マテリアルの再コンパイルが走る
- 連携: 空・雲など自前の大気表現を持つレイヤーは `material.fog = false` で除外済み（SkyLayer / CloudLayer 等）
- 依存モジュール: `src/tsl/heightFog.js`（`createHeightFogFactor`）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| density | number | 0 | フォグ濃度 0..1（0 = 完全無効）。内部で `FOG_DENSITY_SCALE(0.04)` を掛けて指数係数へ変換 |
| fogColor | string | `'#c8cdd3'` | フォグ色（雨天の灰白） |
| falloff | number | 0.35 | 高さ減衰。大きいほど地表に張り付く |
| baseY | number | 0.5 | 基準高さ（海面レベル） |

## 使用例

Scene.jsx での実マウント（天候の霧スライダーと連動、常時マウント）:

```jsx
<HeightFogLayer density={inputs.fogDensity} baseY={0.5} />
```

## 調整のポイント

- `density` は uniform 駆動なので滑らかに変えられる。手動運用ではスライダー 0 で完全無効、シナリオ再生時はキーフレームで明示駆動する
- `density=1.0` で距離 25 units の透過率が 4 割弱になる濃さ（ジオラマの視程を潰さない範囲に調整済み）
- `falloff` を上げると霧が低地に溜まり、下げると高い位置まで均一に広がる
- `baseY` はシーンの海面レベルに合わせる（Scene では 0.5）
- `fogColor` は uniform 更新なので再コンパイルなしで変えられる

## 関連

- ソース: `src/layers/HeightFogLayer.jsx`（`src/tsl/heightFog.js`）
- 関連: `SkyLayer` / `CloudLayer`（fog 除外側）、`docs/webgpu-quality-enhancement.md`
