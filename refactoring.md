# リファクタリングメモ

ロードマップに着手する前に、現状構成で先に整理した方がよい点をまとめる。

## 1. ESLint 設定を R3F / WebGPU 向けに調整する

現在、`npm run build` は通るが、`npx eslint .` は大量のエラーが出る。多くは React DOM 前提の `react/no-unknown-property` による誤検知で、React Three Fiber の `castShadow`、`rotation`、`emissive` などが対象になっている。

この状態だと本当に危険な警告が埋もれるため、コード側を全面修正する前に `eslint.config.js` をプロジェクト実態に合わせるべき。

優先対応:

- `react/no-unknown-property` の扱いを見直す
- `src/backup_Scene.jsx` のような退避ファイルを lint 対象から外すか整理する
- R3F で正当な props と、本当に不要な変数や副作用警告を切り分けられる状態にする

## 2. `Scene.jsx` の責務を分割する

`src/Scene.jsx` は現在、lookdev レイヤー、GIS レイヤー、演出確認用メッシュ、カメラ設定までを直接抱えている。さらに未使用 state の `heightInfo` も残っている。

Phase A 以降で地形、雨、トレイル、流体場が増えると、`Scene.jsx` が肥大化して見通しを失いやすい。

候補:

- `DioramaLookdev`
- `GisOverlay`
- `SceneDebug`

のように責務ごとにまとめ、`Scene.jsx` は最終合成だけを担当させる。

## 3. 投影と座標変換の責務を一本化する

現在、CPU 側の `src/gis/projection.js` と GPU 側の `src/compute/createInterpolationPass.js` に同系統の投影ロジックが存在する。`plan.md` にある通り、これは将来的に GPU 統一したい。

また、座標の scene 変換もレイヤーごとにばらつきがある。

- `GeojsonLayer` は親 `group` の回転で XY → XZ を変換
- `MovingEntitiesLayer` は shader 側で XY → XZ を変換

TerrainLayer や RainLayer と空間統合する前に、少なくとも以下の責務を分離した方がよい。

- `lon/lat -> projected XY`
- `projected XY -> scene XZ`

## 4. レイヤーからデータ取得・前処理を分離する

`GeojsonLayer` は fetch、GeoJSON 展開、サンプリング、geometry 生成、描画をまとめて持っている。`MovingEntitiesLayer` も mock データ生成、compute 初期化、描画を一体化している。

今後、実データ、DEM、高度、海面追従を扱うなら、レイヤーは描画責務に寄せた方が安全。

候補:

- `useGeoJsonGeometry()`
- `useMovingEntitiesSystem()`

のような hook または補助モジュールへ分離する。

## 結論

現時点で必要なのは大規模な作り直しではない。まずは次の4点を優先する。

1. ESLint を実態に合わせて整備する
2. `Scene.jsx` の責務を分割する
3. 投影と座標変換の責務を整理する
4. データ取得と描画レイヤーを分離する

この4点を先に整えると、Phase A 以降の実装追加で破綻しにくくなる。
