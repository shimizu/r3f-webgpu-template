# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

React Three Fiber + WebGPU による GPU ファーストの GIS 可視化テンプレート（コードネーム "Rogue Hunter"）。大量の地理エンティティ（船舶・航空機）をリアルタイムに GPU 上で投影・補間し描画する。

設計思想は「ジオラマがホスト、GIS がゲスト」。フラットな地図 SDK ではなく、空・水・地形・天候を備えた箱庭ステージの上に GIS データを「展示物」として配置する lookdev / 可視化環境として機能している。

- **GPU ファースト**: CPU はデータ取得とパックのみ。投影（lon/lat→XY）・補間・パーティクル移流・地形衝突・描画はすべて GPU（TSL）で行う
- **地図 SDK を使わない**: Mapbox / Leaflet 等は導入しない。GIS ロジックは自前実装か軽量ユーティリティ（geotiff, chroma-js）で構築する

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

- `App.jsx` — Canvas シェル、WebGPU レンダラー初期化（`gl={createRenderer}` で `WebGPURenderer` を非同期 init）
- `Scene.jsx` — シーン合成の入口。空・照明・カメラ操作（MapControls）・投影コンテキスト・レイヤー群を組み立てる
- `FpsStats.jsx` — FPS 表示オーバーレイ
- `StudioEnvironment.jsx` — RoomEnvironment による IBL（PMREM 生成）
- `LightingRig.jsx` — ambient / hemisphere / directional（シャドウ付き）/ spot のスタジオ照明セット

**レイヤーのトグル運用**: `Scene.jsx` では多くのレイヤー import が `// eslint-disable-next-line no-unused-vars` 付きでコメント的に保持されている。これは lookdev 中に有効化・無効化を切り替えるための運用パターンなので、未使用 import を安易に削除しないこと。アクティブなレイヤー構成は頻繁に入れ替わるため、現状は `Scene.jsx` の JSX を直接確認する。ランタイムのパラメータトグルには leva（`useControls`）を使う。`backup_Scene.jsx` は過去の構成のスナップショット。

### 投影コンテキスト（`src/gis/`）

投影は `<Coordinate>` コンテキストコンポーネントで一元管理する。これがこのプロジェクトの GIS 設計の中核:

- `CoordinateContext.jsx` — `<Coordinate projection view position rotation>` で投影設定を子に提供。子レイヤーは `useProjection()` フックで `{ view, projUniforms, projectionType }` を取得する
- `views.js` — `WORLD_VIEW` / `JAPAN_VIEW` 等のビュー定義（centerLon/Lat, worldScale, sampleStep など）
- `projectionGPU.js` — 図法の実装。`projectLonLatGPU(lonNode, latNode, uniforms, projectionType)` が TSL ノードを返す。対応図法は `PROJECTIONS` で切替する4種: `equirectangular` / `mercator` / `lambert-cylindrical` / `natural-earth`。日付変更線ラッピング（`normalizeLon`/`normalizeRing`）とポリゴンクリップ（Sutherland-Hodgman）も含む。CPU 側（Geometry 生成）と GPU 側（Shader 実行）で同じ計算式を共有する
- `projectionUniforms.js` — 投影パラメータから TSL `uniform()` セットを生成。各レイヤー/pass が独立に保持し `update()` で更新
- `projectionOptions.js` — 投影オプションのデフォルト解決

新レイヤーで地理座標を扱う場合は、自前で投影せず `useProjection()` 経由で `projUniforms` を取得し `projectLonLatGPU()` を使うこと。

### レイヤー構成（`src/layers/`）

レイヤーは独立した React コンポーネントとして実装し、`Scene.jsx` で合成する:

- `SkyLayer` — Preetham モデルによる大気散乱の空
- `StageLayer` / `GridLayer` — ジオラマ床（チェッカーボード／グリッド）
- `MaterialSamplesLayer` — マテリアルサンプル球体の lookdev 基準（後述）
- `WaterBoxLayer` / `WaterBlobLayer` / `WaterOceanLayer` — TSL による水面シミュレーション（Perlin/FBM ノイズ + 波・フレネル・深度カラーを GPU 計算）
- `TerrainLayer` — GeoTIFF (DEM) ベースの 3D 地形メッシュ
- `RainLayer` — GPU パーティクルの降雨（地形衝突あり）
- `GeojsonLayer` — GeoJSON ベクター地図描画
- `MovingEntitiesLayer` — GPU 移動体（船舶・航空機）の補間描画
- `Labels3DLayer` — drei `<Html>` による 3D 空間内の HTML ラベル（地名等）

### マテリアルベースライン

`MaterialSamplesLayer` のマテリアルサンプルが lookdev の基準（`Matte` → `Semi Gloss` → `Metal` → `Mirror` → `Glass`）。マテリアル調整の指示（「もっとマット」「ガラスっぽく」等）は、これらプリセットからの相対調整を優先する。新規マテリアルをゼロから作るより、最も近いプリセットから調整すること。

### ポストプロセッシング（`src/effects/`）

WebGPU ネイティブの後処理パイプライン（`@react-three/postprocessing` は依存に入っているが src では未使用）:

- `SceneEffects.jsx` — `RenderPipeline` + `pass(scene, camera)` で scenePass を作り、各エフェクトをノードグラフで合成。`rp.outputNode` を `useFrame` で描画
- `createBloom.js` / `createTiltShift.js` / `createDof.js` / `createGodrays.js` — 個別エフェクトを `create*Pass()` として分離。現在は Bloom + Tilt-Shift（ミニチュア風ぼかし）が有効、Godrays / DoF はコメントアウトで一時無効化

### GPU コンピュート（`src/compute/`）

- `runBarsCompute.js` — パーティクルシステム。`StorageBufferAttribute` で位置・速度・寿命を管理し、TSL compute node で毎フレーム GPU 更新（バウンス、ジッター、リスポーン）
- `runRainCompute.js` — 降雨パーティクルの物理・風場（FBM）・地形衝突
- `createProjectionPass.js` / `createInterpolationPass.js` — GIS エンティティの投影・補間コンピュートパス
- `observationLayout.js` — 観測データレイアウト定義。`OBSERVATION_STRIDE = 12` floats/エンティティ: lon, lat, alt, timestamp, prevLon, prevLat, prevAlt, prevTimestamp, speed, heading, type, status
- `src/data/mockObservations.js` — 開発用のモック観測データ

### TSL パターン

このプロジェクトでは Three.js Shader Language (TSL) を多用する。典型的なパターン:

- `MeshPhysicalNodeMaterial` に対して `positionNode`, `colorNode`, `normalNode` 等をノードグラフで構築
- `mx_noise_float` 等のビルトインノイズ関数で手続き的テクスチャ生成
- `uniform()` でCPU↔GPU間のパラメータ連携
- compute shader は `Fn()` + `compute()` で定義し、`renderer.computeAsync()` で実行

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

- `docs/gpu-gis-particle-architecture.md` — GPU-GIS アーキテクチャ詳細ガイド
- `docs/webgpu-particles-tutorial.md` — WebGPU パーティクル入門チュートリアル
- `docs/r3f-computeshader_llm.md` — R3F + ComputeShader の実装リファレンス
- `docs/rain-terrain-collision.md` — 降雨パーティクルと地形衝突の設計
- `docs/webgpu-quality-enhancement.md` — WebGPU 品質向上の指針
- `AGENTS.md` — リポジトリガイドライン（コミット規約、PR要件等）
- `GEMINI.md` — プロジェクトコンセプトと技術スタックの概観
- `plan.md` / `task.md` / `refactoring.md` — 開発フェーズと進行中タスク
