# Working Memory

## 現在の目的

このプロジェクトを、単なる WebGPU 粒子デモではなく、GPU First な GIS 可視化基盤へ拡張する。

重要なのは以下。

- CPU でできることをやるのではなく、CPU では主役にしにくい規模を GPU で成立させる
- CPU は受信、最小限のパッキング、UI 制御に限定する
- GPU は投影、補間、トレイル、風場粒子、集約を担う

## 現在のブランチ

- `feat/gis`

## 直近のコミット

- `b19cb54`
- message: `add gpu gis architecture docs`

## 主要な決定事項

### 1. GPU First を維持する

- 緯度経度の座標変換も GPU で扱う前提
- 船舶や航空機の移動補間も GPU で行う
- トレイルは GPU リングバッファで持つ
- 風や海流は compute ベースの flow particle として扱う
- GeoJSON と移動体で投影ロジックを分けない

### 2. CPU へ逃がさない

避けること:

- 移動体の個体ごとの毎フレーム CPU 補間
- CPU でのトレイル polyline 更新
- CPU 主体のベクトル場粒子更新

CPU に残してよいもの:

- データ受信
- typed array への最小限のパッキング
- GeoJSON の初回パース
- UI、レイヤー制御、デバッグ表示

### 3. GeoJSON は主役ではない

- 背景地図として使う
- 主役は大量移動体、GPU 補間、GPU トレイル、風場粒子、GPU 集約
- ただし投影式は背景地図と移動体で必ず共有する

## 参考ファイル

- [plan.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/plan.md)
- [task.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/task.md)
- [AGENTS.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/AGENTS.md)
- [.codex/config.toml](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/config.toml)
- [.codex/hooks.json](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks.json)
- [.codex/hooks/session_start.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/session_start.py)
- [.codex/hooks/stop_working_memory_check.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/stop_working_memory_check.py)
- [reference/projection.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/projection.md)
- [docs/gpu-gis-particle-architecture.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/docs/gpu-gis-particle-architecture.md)
- [src/Scene.jsx](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/Scene.jsx)
- [src/compute/runBarsCompute.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/runBarsCompute.js)

## projection.md から覚えておくこと

`reference/projection.md` は CPU 実装メモだが、式の分解は GPU 実装でも有効。

使う考え方:

- `degrees -> radians`
- `rotate(lambda, phi)`
- `projectRaw(lambda, phi) -> (u, v)`
- `scale / translate / reflect`

GPU 実装で最初に使う候補:

- `equirectangularRaw`
- `mercatorRawSafe`
- `rotateLambda`

注意:

- `toScreen` はそのまま使わない
- pixel 座標ではなく Three.js の `worldX/worldZ` に変換する
- Mercator は `phi` clamp が必要

## いまの実装状態

- 既存のランダムウォーク中心 Scene は、最小 GIS Scene へ置き換えた
- `src/compute/createProjectionPass.js` を追加し、GPU で `lon/lat/alt -> world position` を投影できる
- `src/compute/createInterpolationPass.js` を追加し、`prevLon/prevLat` と `lon/lat` を GPU 補間できる
- `src/compute/observationLayout.js` で `rawObservationBuffer` の stride と offsets を固定した
- `src/data/mockObservations.js` で `lon:-180..180`, `lat:-90..90` の全世界ランダム観測データを生成できる
- `src/layers/MovingEntitiesLayer.jsx` を追加し、投影済み state を billboard instancing で描画している
- `src/layers/BaseMapLayer.jsx` を追加し、`public/data/world.geojson` の海岸線を背景ラインとして描画できる
- `src/gis/projection.js` を追加し、CPU 側の静的 GeoJSON 投影にも同じ view 設定を使えるようにした
- `src/gis/views.js` を追加し、world / Tokyo Bay の view 定義を `gis` 配下へ集約した
- `src/gis/projectionOptions.js` を追加し、CPU/GPU が同じ投影オプション解決を使う形に寄せた
- `public/data/japan.geojson` を追加し、日本地図の単独表示でベースマップ確認を進めている
- `public/data/world.geojson` も追加され、現在は world 表示デバッグに切り替えている
- `src/gis/projection.js` で軸を入れ替え、現在は `x = 東西`, `y = 南北`, `z = 重なり回避` の扱い
- `src/compute/createProjectionPass.js` も軸を揃え、現在は `x = 東西`, `y = 南北`, `z = 0` でパーティクルを平面へ置いている
- `MovingEntitiesLayer` は `Interpolation Pass` を使う形へ変更済みで、現在は 6 秒ループで動く
- 移動量には個体ごとのランダム倍率を入れていて、速度は最大約 4 倍までばらつく
- `japan.geojson` は points/lines として正しく表示できる状態になった
- `MovingEntitiesLayer` は world view に合わせて再表示済み
- camera の `near/far` と `OrbitControls.minDistance` を緩め、近距離ズームしやすくした
- UI の件数プリセットには `500000` と `1000000` を追加済み
- control panel の説明文は、ComputeShader で緯度経度から画面座標へ変換する実験内容に合わせて更新済み
- `reference/observation-buffer.md` に buffer layout メモを追加した
- `src/Scene.jsx` と `src/compute/*` に入門者向けの解説コメントを追加済み
- `docs/gpu-gis-particle-architecture.md` に、現行アーキテクチャ、データフロー、実データを GPU へ渡す方法の入門者向け解説を追加した
- トレイル、風場、LOD はまだ未実装
- `plan.md` は GPU First 方針に更新済み
- `task.md` は実装タスク分解済み
- `.codex` に SessionStart / Stop フックを追加済み
- SessionStart で `working-memory.md` を developer context に注入する
- Stop で `working-memory.md` の整合確認を促す継続フックを入れた
- 現在は `world.geojson` とパーティクルを同時表示して位置関係を確認している

## 次に着手するべき作業

優先順:

1. GeoJSON と移動体で共有する projection kernel の形を決める
2. `src/compute/createInterpolationPass.js` を作り、`prev*` と `timestamp` を GPU 補間へつなぐ
3. `src/layers/MovingEntitiesLayer.jsx` を projected state と interpolation state の二段構成へ広げる
4. `src/compute/runBarsCompute.js` は役割縮小または退役方針を決める
5. `Trail Update Pass` の設計に入る

直近のデバッグ優先順位:

1. `world.geojson` を適切な投影と scale で安定表示する
2. GeoJSON と移動体で共有する projection kernel にさらに寄せる
3. Interpolation Pass の速度・補間仕様を必要なら調整する
4. その後にトレイルへ進む

## 実装の最初の完成ライン

以下を満たしたら第一段階完了。

- 緯度経度ベースの大量移動体が GPU 投影で表示される
- GPU 補間で動く
- GPU トレイルが出る
- ベクトル場粒子を重ねられる
- CPU が個体ごとの毎フレーム処理をしていない

## 注意

- `reference/projection.md` は未コミットの可能性があるので、次回再開時に Git 状態を確認する
- フックを有効にするため、Codex 側で repo-local `.codex/config.toml` が読まれる前提
- Stop hook は 1 回だけ継続をかけ、そのターンの終了前確認を促す実装
- `npm run build` は通過済み
- `npm run lint` は通過済み
- `public/data/world.geojson` は今回の表示切り替え対象
- 次回は world 表示の確認か、Interpolation Pass の補間仕様調整から再開する
