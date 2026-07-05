# MovingEntitiesLayer

大量の移動体（船舶・航空機）を GPU で補間・投影して描画するレイヤー。

## 概要

観測データ（前回位置・現在位置・時刻）を GPU の StorageBuffer に転送し、Compute Shader（TSL）が再生時刻に基づいて 2 点間を線形補間、そのまま GPU 上で lon/lat をワールド座標へ投影する。各エンティティは三角形インスタンスで描かれ、頂点シェーダー内で進行方向（heading）に回転する。船舶は水色、航空機は黄色。`LOOP_DURATION=6` 秒でループ再生する。現在の `Scene.jsx` では未マウントで、import のみトグル運用で保持されている（lookdev 中に有効化／無効化を切り替えるため。CLAUDE.md 参照）。

## 前提・依存

- 配置前提: **`<Coordinate>` 配下必須**。`useProjection()` で `view` を取得する
- 連携: `src/compute/createInterpolationPass.js`（補間＋投影パス）、`src/data/mockObservations.js`（モック観測データ生成）、`src/compute/observationLayout.js`（データレイアウト）に依存。日付変更線をまたぐ最短経路補間に対応

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| entityCount | number | （必須） | 生成する移動体の数。Scene のデフォルトでは 2000 が渡される想定 |
| region | bbox \| null | null | モック観測データの生成域（`createMockObservationBuffer` に渡す bbox）。**inline オブジェクトではなく安定参照（定数等）で渡すこと**（`useMemo` の依存になる） |
| altitude | number | 0 | 投影面からの浮かせ量（投影フレームの +Z）。GeojsonLayer の altitude と同義。地形などの上に出したいとき指定 |

エンティティサイズ・色・ループ長はモジュール内定数（`ENTITY_SIZE` / `ENTITY_COLORS` / `LOOP_DURATION`）。

## 使用例

```jsx
import Coordinate from './gis/CoordinateContext'
import MovingEntitiesLayer from './layers/MovingEntitiesLayer'
import { entityRegion } from './gis/regions' // 安定参照の region を渡す

<Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
  {/* entityCount 変更時は key で再マウントするのが安全 */}
  <MovingEntitiesLayer key={entityCount} entityCount={2000} region={region.entityRegion} />
</Coordinate>
```

## 調整のポイント

- `entityCount` / `region` を変えると `dataset` が `useMemo` で作り直され、GPU リソースも再構築される。`entityCount` 変更時は `key` で再マウントするのが確実
- `region` は必ず安定参照で渡す。inline オブジェクトだと毎レンダー再生成され GPU リソースが作り直される
- 補間・投影の再計算は `useFrame` で毎フレーム `system.update(renderer, playbackTime, updateOptions)` を呼ぶ。`updateOptions` は view 変更時のみ作り直して GC を抑える
- 投影パス初期化に失敗した場合は `resourceError` を `console.error` して `null` を返す（クラッシュしない）
- アンマウント時に geometry / material の dispose と `system.destroy(renderer)`（GPU バッファ解放）を行う
- `frustumCulled = false`（常に描画）

## 関連

- ソース: `src/layers/MovingEntitiesLayer.jsx`
- 関連: `src/compute/createInterpolationPass.js`、`src/compute/observationLayout.js`、`src/data/mockObservations.js`。ベクター地図は `GeojsonLayer`。アーキテクチャは `docs/gpu-gis-particle-architecture.md`
