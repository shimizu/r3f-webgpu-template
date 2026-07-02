# リファクタリングメモ

ロードマップに着手する前に、現状構成で先に整理した方がよい点をまとめる。
（完了した項目は「完了済み」節に移動。詳細な指摘と優先度は review.md を参照）

## 完了済み

- **ESLint を R3F / WebGPU 向けに調整する** — `eslint.config.js` を flat config で整備済み。`react/no-unknown-property` を off、`backup_Scene.jsx` を lint 対象外、react version を実体（19.2）に明示
- **投影ロジックの CPU/GPU 数式共有** — `src/gis/projectionCPU.js` / `projectionGPU.js` に分割し、4図法とも係数レベルで一致（natural-earth は d3 準拠の絶対緯度基準に修正済み）。座標の scene 変換も `<Coordinate>` のデフォルト回転で一元化された
- **補間パスの既知バグ** — 日付変更線・timestamp 恒等式・GPU バッファ解放（review.md H1/H2）を解消済み

## 1. `Scene.jsx` の責務を分割する

`src/Scene.jsx` は現在、lookdev レイヤー、GIS レイヤー、カメラ設定までを直接抱えている。未使用 state の `heightInfo`（RainLayer 有効化時の地形衝突配線用）も eslint-disable 付きで残っている。

レイヤーが増えると `Scene.jsx` が肥大化して見通しを失いやすい。

候補:

- `DioramaLookdev`
- `GisOverlay`
- `SceneDebug`

のように責務ごとにまとめ、`Scene.jsx` は最終合成だけを担当させる。

## 2. 水系3レイヤーの共通化（review.md M1）

`WaterBoxLayer` / `WaterBlobLayer` / `WaterOceanLayer`（計1200行超）は定数群と TSL ノード構築がほぼコピペ重複している。共有モジュール（例: `src/layers/water/waterNodes.js`）へ抽出すると、水の look 調整が一箇所で済むようになる。現状の最優先リファクタ対象。

## 3. レイヤーからデータ取得・前処理を分離する

`GeojsonLayer` は fetch、GeoJSON 展開、サンプリング、geometry 生成、描画をまとめて持っている。`MovingEntitiesLayer` も mock データ生成、compute 初期化、描画を一体化している。

今後、実データ、DEM、高度、海面追従を扱うなら、レイヤーは描画責務に寄せた方が安全。

候補:

- `useGeoJsonGeometry()`
- `useMovingEntitiesSystem()`

のような hook または補助モジュールへ分離する。

## 4. デッドコードの整理（review.md M5）

`createProjectionPass.js` / `runBarsCompute.js`（補間パスに置換済み）、`createDof.js` / `createGodrays.js`（コメントアウト中）、`backup_Scene.jsx`、未使用の `StudioEnvironment.jsx`（IBL として有効化する価値あり、review.md M2 参照）の去就を決める。

## 結論

現時点で必要なのは大規模な作り直しではない。次の順で進めると Phase B 以降の実装追加で破綻しにくい。

1. 水系3レイヤーの共通化（M1）
2. `Scene.jsx` の責務を分割する
3. データ取得と描画レイヤーを分離する
4. デッドコード整理（M5）
