# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

React Three Fiber + WebGPU による GPU ファーストの GIS 可視化テンプレート（コードネーム "Rogue Hunter"）。大量の地理エンティティ（船舶・航空機）をリアルタイムに GPU 上で投影・補間し描画する。

設計思想は「ジオラマがホスト、GIS がゲスト」。フラットな地図 SDK ではなく、空・水・地形・天候を備えた箱庭ステージの上に GIS データを「展示物」として配置する lookdev / 可視化環境として機能している。

- **GPU ファースト**: CPU はデータ取得とパックのみ。投影（lon/lat→XY）・補間・パーティクル移流・地形衝突・描画はすべて GPU（TSL）で行う
- **地図 SDK を使わない**: Mapbox / Leaflet 等は導入しない。GIS ロジックは自前実装か軽量ユーティリティ（geotiff 等）で構築する

## 開発コマンド

```bash
npm install          # 依存パッケージのインストール（lockfile使用）
npm run dev          # Vite開発サーバー起動
npm run build        # 本番ビルド（dist/）
npm run preview      # ビルド済みアプリの確認
npm run lint         # ESLintチェック（PR前に必須）
```

自動テストは未構成。品質ゲートは lint + 手動確認（`npm run dev`）+ build成功。

## アーキテクチャ

### データフロー: CPU → GPU → 描画

```
CPU(受信・パック) → GPU(投影・補間) → Draw(インスタンス描画)
```

- **CPU**: 観測データを TypedArray にパックするのみ。per-frame の個別エンティティ更新は行わない
- **GPU**: TSL (Three.js Shader Language) compute shader で投影・補間を実行
- **描画**: InstancedMesh + ビルボードクアッドでレンダリング

### シーン構成

`App.jsx` → `Scene.jsx` → 各レイヤー の階層構造:

- `App.jsx` — Canvas シェル、WebGPU レンダラー初期化（`gl={createRenderer}` で `WebGPURenderer` を非同期 init）。`navigator.gpu` チェックで非対応環境にはフォールバック表示を出す
- `Scene.jsx` — シーン合成の入口。空・照明・カメラ操作（MapControls）・投影コンテキスト・レイヤー群を組み立てる
- `ErrorBoundary.jsx` — 描画ツリーの実行時エラーで白画面にならないための最小境界（main.jsx でラップ）
- `FpsStats.jsx` — FPS 表示オーバーレイ
- `StudioEnvironment.jsx` — RoomEnvironment による IBL（PMREM 生成）
- `LightingRig.jsx` — ambient / hemisphere / directional（シャドウ付き）/ spot のスタジオ照明セット

**レイヤーのトグル運用**: `Scene.jsx` では多くのレイヤー import が `// eslint-disable-next-line no-unused-vars` 付きでコメント的に保持されている。これは lookdev 中に有効化・無効化を切り替えるための運用パターンなので、未使用 import を安易に削除しないこと。アクティブなレイヤー構成は頻繁に入れ替わるため、現状は `Scene.jsx` の JSX を直接確認する。ランタイムのパラメータトグルには leva（`useControls`）を使う。

### 投影コンテキスト（`src/gis/`）

投影は `<Coordinate>` コンテキストコンポーネントで一元管理する。これがこのプロジェクトの GIS 設計の中核:

- `CoordinateContext.jsx` — `<Coordinate projection view position rotation>` で投影設定を子に提供。子レイヤーは `useProjection()` フックで `{ view, projUniforms, projectionType }` を取得する
- `regions.js` — 地域プリセット（DEM url・bbox・view・seaLevel・terrain params・labels を 1 オブジェクトに集約）。`regionFootprint()` で投影後フットプリントを bbox から導出。Scene の leva「地域」セレクタで切替
- `HeightFieldContext.jsx` — 地形ハイトフィールドの共有コンテキスト。TerrainLayer の heightInfo と GPU バッファ（heights の StorageBufferAttribute を 1 個だけ）を保持し、`useHeightField()` で `{ heightInfo, gpu: { attribute, node, sampler }, setHeightInfo }` を配布。sampler は `src/tsl/sampleHeightField.js` の `{ heightAt, normalAt, elevationAt }`（バイリニア補間）。草の接地・雨の地形衝突・今後の災害レイヤーはこれを使うこと（自前で heights のバッファを作らない）
- `LandCoverContext.jsx` / `landcover.js` — 土地被覆（Dynamic World、クラス 0..8）の共有コンテキストとヘルパー。`region.landcoverUrl` を Provider が読み、`useLandCover()` で `{ status, info, texture, classAtWorld, worldToLonLat }` を配布。地形のクラス別配色（texMap > landCover > 標高 stops）と草木の散布 rejection（`TREE_CLASSES`/`GRASS_CLASSES`）が使う。カテゴリカル値なので補間厳禁（縮小読み込みなし・NearestFilter・CPU も nearest）。url の無い region は idle のまま従来動作。将来の建物配置は built クラス + `classAtWorld`/`info` を使う想定
- `views.js` — DEM を持たない汎用ビュー定義（`WORLD_VIEW` / `JAPAN_VIEW`）。地域ビューは regions.js 側
- `projectionGPU.js` — 図法の実装。`projectLonLatGPU(lonNode, latNode, uniforms, projectionType)` が TSL ノードを返す。対応図法は `PROJECTIONS` で切替する4種: `equirectangular` / `mercator` / `lambert-cylindrical` / `natural-earth`。日付変更線ラッピング（`normalizeLon`/`normalizeRing`）とポリゴンクリップ（Sutherland-Hodgman）も含む。CPU 側（Geometry 生成）と GPU 側（Shader 実行）で同じ計算式を共有する
- `projectionUniforms.js` — 投影パラメータから TSL `uniform()` セットを生成。各レイヤー/pass が独立に保持し `update()` で更新
- `projectionOptions.js` — 投影オプションのデフォルト解決

新レイヤーで地理座標を扱う場合は、自前で投影せず `useProjection()` 経由で `projUniforms` を取得し `projectLonLatGPU()` を使うこと。

### レイヤー構成（`src/layers/`）

レイヤーは独立した React コンポーネントとして実装し、`Scene.jsx` で合成する:

- `SkyLayer` — 室内・卓上トーンの空ドーム（静的グラデーション + fBM 雲。大気散乱モデルではない）
- `StageLayer` / `GridLayer` — ジオラマ床（チェッカーボード／グリッド）
- `MaterialSamplesLayer` — マテリアルサンプル球体の lookdev 基準（後述）
- `WaterBoxLayer` / `WaterBlobLayer` / `WaterOceanLayer` — TSL による水面シミュレーション（Perlin/FBM ノイズ + 波・フレネル・深度カラーを GPU 計算）。WaterOcean は `floodLevel`（水位上昇）と `murkiness`（濁り、uniform 駆動）で浸水表現に対応
- `TerrainLayer` — GeoTIFF (DEM) ベースの 3D 地形メッシュ
- `TreeLayer` — GPU インスタンス樹木（1 ドローコール。針葉樹/広葉樹を同一トポロジーで焼き込み per-instance に切替。GrassLayer と同じマスク・接地・トグル運用）
- `CloudLayer` — TSL raymarching による体積雲（cumulus / stratus / cirrus の3プリセット、範囲・coverage・厚みを props 指定）。GPU 負荷が高いので steps は控えめに（TDR 注意、既定構成は steps≈12）
- `RainLayer` — GPU パーティクルの降雨（地形衝突あり）。`intensity` 0..1 で粒数・風の強さが uniform 駆動で変わる
- `HeightFogLayer` — scene.fogNode に距離+高さの指数フォグを設定する非描画レイヤー（`src/tsl/heightFog.js`）。マウントしっぱなしで density を uniform 駆動（条件マウントは全マテリアル再コンパイルを招くので禁止）。自前の大気表現を持つレイヤー（空・雲）は `fog: false` で除外
- `SnowLayer` — GPU パーティクルの降雪（RainLayer 派生。低速落下 + 強い横流され + 着地静止フェード。雪トグルで TerrainLayer の堆積も時定数駆動）
- `LightningLayer` — 稲妻。ボルトは CPU 生成（ミッドポイント変位 + 確率分岐）の billboard リボン + 加算ブレンド。ポアソン過程（rate 回/分）+ 3 段エンベロープ。フラッシュはポイントライトと flashUniform（CloudLayer の雲内発光と共有）の 2 系統
- `TornadoLayer` — 竜巻。windField の vortex 項（Rankine 渦近似）で螺旋上昇するデブリ（runVortexCompute）+ LatheGeometry の漏斗雲メッシュ（vertex ノイズ揺らぎ + スクロールノイズ opacity。raymarch 不使用で雲と steps 予算を食い合わない）。中心はリサージュ軌道で移動
- `FireLayer` — 山火事の炎 + 火の粉。burnField（`src/tsl/burnField.js`、発火点距離場の解析近似）と同じ ignition/radius uniform で燃焼前線リングからスポーン（runEmberCompute のパラメータ差で 2 役）。TerrainLayer は同じマスクで焼け跡 albedo + 前線残火 emissive
- `SmokeLayer` — 山火事の煙。CloudLayer の 'smoke' プリセット + 延焼マスクの XZ ゲート（gateAt prop）の薄いラッパー。山火事中は deriveLayerInputs が通常雲の coverage を絞って raymarch 予算を折半
- `GeojsonLayer` — GeoJSON ベクター地図描画
- `MovingEntitiesLayer` — GPU 移動体（船舶・航空機）の補間描画
- `Labels3DLayer` — drei `<Html>` による 3D 空間内の HTML ラベル（地名等）

### シナリオ層（`src/scenario/`）

災害シナリオと天候連動の一元化（plan.md Phase 3）:

- `weather.js` — `DEFAULT_WEATHER` と `deriveLayerInputs(weather)`。「雨→濡れ」「浸水→濁り」等の連動ルールはここだけに書く（Scene に直書きしない）。霧・雲量は明示値のみで自動連動しない
- `scenarios.js` — 天候キーフレーム列（`SCENARIOS`）と `sampleScenario(scenario, t)`（smoothstep 補間）。各キーフレームはそのシナリオで動かす全フィールドを毎回書くこと。cloudType はシナリオ固定（再コンパイル対策）
- `useScenario.js` — leva「シナリオ」フォルダ（選択/再生/進行）と useFrame 進行。weather state は 0.25 秒間隔にスロットリング（毎フレーム再レンダー回避）。none 選択時は null を返し手動（天候フォルダ）にフォールバック

新しい天候連動を足すときは deriveLayerInputs に、新しい災害の演出は SCENARIOS のキーフレームに書く。

### マテリアルベースライン

`MaterialSamplesLayer` のマテリアルサンプルが lookdev の基準（`Matte` → `Semi Gloss` → `Metal` → `Mirror` → `Glass`）。マテリアル調整の指示（「もっとマット」「ガラスっぽく」等）は、これらプリセットからの相対調整を優先する。新規マテリアルをゼロから作るより、最も近いプリセットから調整すること。

### ポストプロセッシング（`src/effects/`）

WebGPU ネイティブの後処理パイプライン:

- `SceneEffects.jsx` — `RenderPipeline` + `pass(scene, camera)` で scenePass を作り、各エフェクトをノードグラフで合成。`rp.outputNode` を `useFrame` で描画
- `createBloom.js` / `createTiltShift.js` / `createDof.js` / `createGodrays.js` — 個別エフェクトを `create*Pass()` として分離。Bloom + Tilt-Shift（ミニチュア風ぼかし）を合成し、Godrays / DoF はコメントアウトで無効化中。SceneEffects 自体の有効/無効は Scene.jsx のトグル運用に従う（GPU 負荷次第で外すことがある）

### GPU コンピュート（`src/compute/`）

- `createInterpolationPass.js` — GIS エンティティの補間 + 投影コンピュートパス（MovingEntitiesLayer が使用）。日付変更線をまたぐ最短経路補間に対応
- `runRainCompute.js` — 降雨パーティクルの物理・風場・地形衝突。新しい災害パーティクル（火の粉等）はこれをテンプレートにコピーベースで派生させる
- `runSnowCompute.js` — 降雪パーティクル（rain 派生の実例。スプラッシュなし、rest バッファで着地静止 + フェード）
- `particleBuffers.js` — パーティクル用 StorageBuffer 群の生成/破棄の定型（`createParticleBuffers(count, fields)` → `{ attributes, nodes, dispose }`）。新パーティクル系はこれを使うこと
- `src/tsl/windField.js` — 3D ノイズ風場の共有 Fn（`createWindField()` → `windAt(pos, time)`）。雨・雪・火の粉で共有。竜巻の vortex 項はここに追加予定
- `disposeStorageAttributes.js` — compute 専用 StorageBufferAttribute の GPU バッファ解放ヘルパー。各パスの `destroy(renderer)` から呼ぶ（新パスを作る場合も必ず組み込むこと）
- `observationLayout.js` — 観測データレイアウト定義。`OBSERVATION_STRIDE = 12` floats/エンティティ: lon, lat, alt, timestamp, prevLon, prevLat, prevAlt, prevTimestamp, speed, heading, type, status
- `src/data/mockObservations.js` — 開発用のモック観測データ（`region` オプションで生成域を限定可能）

### TSL パターン

このプロジェクトでは Three.js Shader Language (TSL) を多用する。典型的なパターン:

- `MeshPhysicalNodeMaterial` に対して `positionNode`, `colorNode`, `normalNode` 等をノードグラフで構築
- `mx_noise_float` 等のビルトインノイズ関数で手続き的テクスチャ生成
- `uniform()` でCPU↔GPU間のパラメータ連携
- compute shader は `Fn()` + `compute()` で定義し、`renderer.compute()` で実行

## コーディングスタイル

- 2スペースインデント、シングルクォート、セミコロンなし
- React コンポーネント / レイヤー: PascalCase（`WaterOceanLayer.jsx`）
- ヘルパーモジュール: camelCase（`createBloom.js`）
- 機能ごとにファイルをコロケーション。Three.js / R3F の props は過度に抽象化せず明示的に書く
- ESLint設定で Three.js 固有プロパティ（args, attach, intensity, material, position 等）を許可済み
- アセットは `public/` 配下の安定パスで参照（`/data/world.geojson`, `/textures/waternormals.jpg` 等）。重い DEM / GeoTIFF / テクスチャの複製は避ける

## 言語

開発者は日本人。応答・レビュー・進捗報告は日本語で行う。コード・ファイル名・コマンド・API識別子は英語のまま。

## 参考ドキュメント

- `docs/disaster-simulation-architecture.md` — 災害ジオラマ可視化アーキテクチャ（地域プリセット・共有部品・各災害・シナリオ層）
- `docs/gpu-gis-particle-architecture.md` — GPU-GIS アーキテクチャ詳細ガイド
- `docs/webgpu-particles-tutorial.md` — WebGPU パーティクル入門チュートリアル
- `docs/r3f-computeshader_llm.md` — R3F + ComputeShader の実装リファレンス（§18〜20 に共有部品）
- `docs/rain-terrain-collision.md` — 地形衝突と共有ハイトフィールドの設計
- `docs/webgpu-quality-enhancement.md` — WebGPU 品質向上の指針
- `docs/projection-formulas.md` — 投影図法の数式リファレンス（projectionCPU/GPU の実装根拠）
- `AGENTS.md` — リポジトリガイドライン（コミット規約、PR要件等）
- `GEMINI.md` — プロジェクトコンセプトと技術スタックの概観
- `manual/` — 各レイヤーの使用マニュアル（1 レイヤー 1 ファイル。props・前提・使用例・調整ポイント）。`manual/README.md` が索引
- `plan.md` — 災害ジオラマ可視化基盤への育成ロードマップ（リファクタリング + 災害別アプローチ + 実装順序）
- `refactoring.md` — リファクタリング候補の記録
