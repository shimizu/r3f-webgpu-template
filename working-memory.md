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

- `c70528c`
- message: `add gpu first gis plan`

## 主要な決定事項

### 1. GPU First を維持する

- 緯度経度の座標変換も GPU で扱う前提
- 船舶や航空機の移動補間も GPU で行う
- トレイルは GPU リングバッファで持つ
- 風や海流は compute ベースの flow particle として扱う

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

## 参考ファイル

- [plan.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/plan.md)
- [task.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/task.md)
- [AGENTS.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/AGENTS.md)
- [.codex/config.toml](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/config.toml)
- [.codex/hooks.json](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks.json)
- [.codex/hooks/session_start.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/session_start.py)
- [.codex/hooks/stop_working_memory_check.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/stop_working_memory_check.py)
- [reference/projection.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/projection.md)
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

- 既存実装は正方グリッド上のランダムウォーク粒子
- WebGPU compute の最小基盤はある
- GIS 向けの投影、移動体、トレイル、ベクトル場、LOD は未実装
- `plan.md` は GPU First 方針に更新済み
- `task.md` は実装タスク分解済み
- `.codex` に SessionStart / Stop フックを追加済み
- SessionStart で `working-memory.md` を developer context に注入する
- Stop で `working-memory.md` の整合確認を促す継続フックを入れた

## 次に着手するべき作業

優先順:

1. `src/compute/runBarsCompute.js` の責務分離方針を決める
2. `rawObservationBuffer` のレイアウトを決める
3. `src/compute/createProjectionPass.js` を作る
4. `src/layers/MovingEntitiesLayer.jsx` の最小描画を作る
5. 10 万件のダミー移動体を表示する

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
- 次回は説明ではなく、P0 タスクから着手する
