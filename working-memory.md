# Working Memory

## 現在の目的

このプロジェクトを、単なる WebGPU 粒子デモではなく、GPU First な GIS 可視化基盤へ拡張する。

重要なのは以下。

- CPU でできることをやるのではなく、CPU では主役にしにくい規模を GPU で成立させる
- CPU は受信、最小限のパッキング、UI 制御に限定する
- GPU は投影、補間、トレイル、風場粒子、集約を担う

## 現在のブランチ

- `main`

## 直近のコミット

- `73b2ae7`
- message: `refine material test stage lookdev`

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

### 4. テンプレートとして育てる

- このプロジェクトは単発デモではなく、WebGPU / Compute を使ったリッチな地図表現テンプレートとして育てる
- `Data / Projection`、`Layer`、`Style / Theme`、`Post Effects` の 4 層で責務を分ける
- Bloom や Tilt Shift などの演出は、地図レイヤー実装と分離して `Post Effects` 層で扱う
- 主題図、移動体、流体表現、集約表現を同じ view / projection 管理で重ねられる構造を目指す

### 5. ジオラマ風の舞台を先に作る

- 全体のルックは、地図を平面 UI としてではなく、工作マット上のジオラマとして成立させる方向を取る
- まず `StageLayer`、`LightingRig`、`StudioEnvironment`、`ExtrudedGridLayer` を作り、floor、材質サンプル、ライティングだけで絵が成立する状態を先に作る
- その後に Base Map、Aggregation、Glow、Moving Entities、Trail などのレイヤーを上に重ねる
- GIS レイヤー実装より先に lookdev の基準を固め、後続レイヤーの見た目判断基準にする
- 現在の lookdev は、工作マット表現よりも一度 `material test stage` 寄りに振って、床材、反射、粗さ、影、少数ライト構成の基準を先に固める

## 参考ファイル

- [plan.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/plan.md)
- [task.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/task.md)
- [AGENTS.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/AGENTS.md)
- [.codex/config.toml](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/config.toml)
- [.codex/hooks.json](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks.json)
- [.codex/hooks/session_start.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/session_start.py)
- [.codex/hooks/stop_working_memory_check.py](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/.codex/hooks/stop_working_memory_check.py)
- [reference/projection.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/projection.md)
- [reference/example.png](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/example.png)
- [reference/materials_sphere_640x360.jpg](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/materials_sphere_640x360.jpg)
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
- `src/layers/StageLayer.jsx` は checker floor と低い台座、奥の背景面を持つ material test stage に寄せて調整中
- `src/layers/ExtrudedGridLayer.jsx` は多数の box 群ではなく、材質見本として 5 つの sphere を並べる構成へ寄せた
- `src/LightingRig.jsx` は演出的な多灯構成より、少数ライトで影と反射を見やすい構成へ整理中
- `src/StudioEnvironment.jsx` を追加したが、現状の `WebGPURenderer` では `PMREMGenerator.fromScene(RoomEnvironment)` で落ちるため、いったん `Scene` から外している
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
- `plan.md` は GPU First 方針に加えて、リッチな地図表現テンプレートとして育てる 4 層構成、主題図候補、theme / postfx 方針、Phase A-D のロードマップを追記済み
- `task.md` は実装タスク分解済み
- `.codex` に SessionStart / Stop フックを追加済み
- SessionStart で `working-memory.md` を developer context に注入する
- Stop で `working-memory.md` の整合確認を促す継続フックを入れた
- 現在は `world.geojson` とパーティクルを同時表示して位置関係を確認している
- Layer API、Theme API、Post Effects パイプラインはまだ未着手
- `reference/example.png` を、押し出し集約、発光密度、粒子ボリューム、フロー、ネットワーク表現の参照として追加した
- `reference/materials_sphere_640x360.jpg` を、床材、反射、粗さ、影、少数ライト構成を確認する lookdev 参照として追加した
- テンプレートの初期表現候補としては `AggregationLayer`、`GlowPointLayer`、`TrailLayer`、`FlowFieldLayer` の優先度が高い
- ジオラマ風ルックの方針が追加され、工作マット風 floor、厚みのある stage、box 表現、リッチなライティングを先に整える方針になった
- `Scene` は背景色、fog、flat な stage、lighting rig を持つ構成へ更新済み
- `StageLayer`、`LightingRig`、`ExtrudedGridLayer` の最小実装は着手済み
- `MovingEntitiesLayer` の実装は保持したまま、舞台確認のため現在は `Scene` から外して非表示にしている
- `BaseMapLayer` の実装も保持したまま、舞台確認のため現在は `Scene` から外して非表示にしている
- control panel と HUD は削除済みで、現在の画面は Canvas のみの最小構成になっている
- 現在の lookdev では、グリッド線や発光を増やす前に、床材、反射、粗さ、影、少数ライト構成の整理を優先する
- カメラ操作は、特殊な固定視点ではなく一般的な OrbitControls に戻し、斜め俯瞰のデフォルト操作へ寄せている
- OrbitControls の `polarAngle` 制限も緩め、ボードを上方向にも十分傾けられる状態にしている
- `RectAreaLight` は `WebGPURenderer` で `LTC_FLOAT_1` エラーを出したため使わず、現在は spot / point / directional のみで構成している
- `npm run build` は通過した
- `npm run lint` はこの環境で `eslint` バイナリが見つからず未確認

## 次に着手するべき作業

優先順:

1. `StageLayer` と `LightingRig` の lookdev を詰め、床材、影、反射、少数ライト構成を優先して material test stage の質感を上げる
2. `ExtrudedGridLayer` の材質見本をさらに詰め、マット、セミグロス、金属、ガラスの差を明確にする
3. テンプレート向けの Layer API を決める
4. GeoJSON と移動体で共有する projection kernel の形を決める
5. `ExtrudedGridLayer` を今後の `AggregationLayer` へつながる API に寄せる
6. Theme / Style API と Post Effects の責務分離方針を決める
7. `src/compute/runBarsCompute.js` は役割縮小または退役方針を決める
8. `Trail Update Pass` の設計に入る

直近のデバッグ優先順位:

1. floor, stage, material samples, lighting だけで material test stage として成立する look を作る
2. `Scene` を `view / stage / layers / postfx` の組み立て役に縮小できる構成を維持する
3. 床材、マテリアル差、影の接地感を優先して lookdev する
4. カメラ位置、sphere の間隔、床の反射量を参照画像に近づける
5. `ExtrudedGridLayer` をデータ駆動 layer へ一般化できる形にする
6. `world.geojson` を適切な投影と scale で安定表示する
7. GeoJSON と移動体で共有する projection kernel にさらに寄せる

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
- `npm run lint` は現在の環境では `eslint` バイナリが見つからず未実行
- `public/data/world.geojson` は今回の表示切り替え対象
- 次回は `StageLayer` / `LightingRig` / `ExtrudedGridLayer` の material lookdev 調整、または UI を持たない状態での floor / camera 調整から再開する
