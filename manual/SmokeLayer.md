# SmokeLayer

山火事の煙を延焼マスクの XZ ゲート付きで立ち上らせるレイヤー。

## 概要

CloudLayer の `'smoke'` プリセット（暗色・吸収強・等方散乱寄り）を、burnField と同じ `ignition` / `radius` uniform で作った XZ ゲートで絞る薄いラッパー。燃焼前線（強）と焼け跡（くすぶり、弱）からだけ煙が立ち上る。山火事シナリオで炎（FireLayer）の上に立ちのぼる煙柱を表現する。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（正確には burnField の `ignition` / `radius` を FireLayer / TerrainLayer と共有する）
- GPU 予算: 独自の raymarch を持つため、山火事中は通常雲の coverage を絞って合計 steps を予算内に収める（Scene の `deriveLayerInputs` 側で制御）
- 連携: `ignition` / `radius` は TerrainLayer の burnField と同じ値を渡す。内部で CloudLayer を `type='smoke'`, `quality='low'`, `gateAt=<burnField ゲート>` で構築
- 依存モジュール: `src/layers/CloudLayer.jsx`（内部利用）、`src/tsl/burnField.js`（`createBurnField`）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| position | Array | `[0, 2.2, 0]` | 煙ボックス中心のワールド座標 |
| width | number | 24 | XZ 範囲の幅 |
| depth | number | 15 | XZ 範囲の奥行 |
| thickness | number | 3 | 煙層の厚み（Y） |
| ignition | Array\|null | `null` | 発火点 `[x, z]`。TerrainLayer の burnField と同じ値 |
| radius | number | 0 | 延焼半径（uniform 駆動） |
| band | number | 0.5 | 前線帯の幅 |
| steps | number | 8 | raymarch サンプル数。通常雲 12 と合わせて予算内 |
| coverage | number | 0.85 | 煙量 0..1 |

## 使用例

Scene.jsx での実マウント（山火事アクティブかつ heightInfo / 発火点確定後に条件マウント）:

```jsx
{inputs.fireActive && heightInfo && fireIgnition && (
  <SmokeLayer
    position={[0, 2.2, 0]}
    width={footprint.width}
    depth={footprint.depth}
    thickness={3}
    ignition={fireIgnition}
    radius={fireRadius}
  />
)}
```

## 調整のポイント

- `steps` は CloudLayer と同じく GPU コスト直結。山火事中は通常雲側の coverage を絞って合計 steps を予算内に収める設計（既定 8）
- XZ ゲートは前線帯（`state.x`）から濃く、焼け跡（`state.y`）からくすぶり程度に立ち上る式（`state.x*0.45 + state.y*1.3` を 0..1 clamp）。ゲート Fn は useMemo で安定参照にしており、CloudLayer のシェーダ再構築を避けている
- `radius` は uniform 駆動なので延焼の広がりに滑らかに追従する
- 煙の色・吸収・散乱特性は CloudLayer の `CLOUD_TYPES.smoke` プリセットに集約（SmokeLayer からは変えられない）
- CloudLayer 同様シーン深度クランプがないため、地形より上に置くこと（既定 position の Y は炎より高い 2.2）

## 関連

- ソース: `src/layers/SmokeLayer.jsx`（`src/layers/CloudLayer.jsx`, `src/tsl/burnField.js`）
- 関連: `CloudLayer`（内部利用・`gateAt` の受け側）、`FireLayer`（同じ発火点の炎）、`TerrainLayer`（burnField 延焼マスク）
