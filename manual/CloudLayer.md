# CloudLayer

TSL raymarching による体積雲レイヤー。

## 概要

単位ボックスを `[width, thickness, depth]` に引き伸ばし、フラグメントシェーダ内で AABB 交差 → 固定ステップの raymarch を行って体積雲を描く。密度は「weather 場 → coverage remap → 垂直プロファイル → base shape → detail 侵食」の順で組織化し、サンプルごとに太陽方向へ短い光学深度マーチをかけて Beer 減衰 + powder + Henyey-Greenstein 位相でライティングする。`cumulus`（積雲）/ `stratus`（層雲）/ `cirrus`（巻雲）/ `smoke`（山火事の煙）の 4 プリセットを持ち、ジオラマ上空に低層雲を敷きたいときに使う。

## 前提・依存

- 配置前提: なし（`<Coordinate>` とは無関係のワールド座標レイヤー）
- 制限: シーン深度クランプを持たないため、不透明物がボックス内部に食い込むと貫通して見える。雲は必ず地形より上に置くこと
- 連携: `flashNode` を LightningLayer の雷フラッシュ uniform と共有すると雲内発光が同期する。`gateAt` に burnField 由来のゲート Fn を渡すと SmokeLayer のように密度を XZ で絞れる
- 依存モジュール: raymarch 部品 `src/tsl/raymarchUtils.js`、ノイズ `src/tsl/valueNoise.js`

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| width | number | 24 | XZ 範囲の幅（ワールド単位） |
| depth | number | 15 | XZ 範囲の奥行 |
| thickness | number | 2.5 | 雲層の厚み（Y） |
| coverage | number | 0.45 | 雲量 0..1。remap 閾値シフトの uniform 駆動。スライダー変更で再コンパイルなし |
| type | string | `'cumulus'` | `'cumulus'` \| `'stratus'` \| `'cirrus'` \| `'smoke'`。変更で再コンパイル |
| steps | number | 32 | raymarch サンプル数。GPU コスト直結（TDR 注意） |
| quality | string | `'low'` | `'low'`（軽量 value noise）\| `'high'`（mx Perlin + Worley）。変更で再コンパイル |
| position | Array | `[0, 6, 0]` | 雲ボックス中心のワールド座標 |
| flashNode | uniform\|null | `null` | 雷フラッシュ用の 0..1 uniform。雲内を一様発光。安定参照で渡すこと |
| gateAt | Fn\|null | `null` | worldXZ(vec2) → 0..1 の密度ゲート Fn。安定参照で渡すこと |

## 使用例

Scene.jsx での実マウント（天候フォルダと連動、steps を絞って TDR 回避）:

```jsx
<CloudLayer
  width={footprint.width}
  depth={footprint.depth}
  thickness={1.5}
  coverage={inputs.cloudCoverage}
  type={inputs.cloudType}
  steps={12}
  quality={cloudQuality}
  position={[0, region.cloudHeight, 0]}
  flashNode={lightningFlash}
/>
```

## 調整のポイント

- `steps` が最大の負荷要因。Windows の TDR タイムアウト（約 2 秒）で GPU デバイスロストになるため、まず 24〜32 の範囲で調整し、他エフェクトと併用する実運用では 12 程度まで絞る
- `coverage` は uniform 駆動なのでスライダーで滑らかに変えられる（面積が変わる）。一方 `type` / `quality` の変更はシェーダ再コンパイルを伴う
- `quality='high'` は積雲のカリフラワー構造（Worley セル）が良く出るが単価が高い。`'low'` は縁がややもや寄りになる代わりに 1/3〜1/5 の単価
- `flashNode` / `gateAt` は useMemo 等で安定参照にすること。参照が変わるたび material が再生成される
- 透明ソートが不安定なため `renderOrder={10}` で海面より後に描いている

## 関連

- ソース: `src/layers/CloudLayer.jsx`（`src/tsl/raymarchUtils.js`, `src/tsl/valueNoise.js`）
- 関連: `SmokeLayer`（`type='smoke'` + `gateAt` のラッパー）、`LightningLayer`（`flashNode` 供給元）、`docs/webgpu-quality-enhancement.md`
