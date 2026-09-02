# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

React Three Fiber + WebGPU（three r185 / TSL）による GPU ファーストの GIS ジオラマ可視化テンプレート。DEM 地形の上に空・水・草木・天候・災害（雨・雪・雷・竜巻・山火事）を載せ、GeoJSON や大量の移動体（船舶・航空機）を「展示物」として配置する lookdev 環境。

- **GPU ファースト**: CPU はデータ取得と TypedArray へのパックのみ。投影（lon/lat→XY）・補間・パーティクル移流・地形衝突・描画は TSL compute / node material で GPU 上で行う
- **地図 SDK を使わない**: Mapbox / Leaflet 等は導入しない。GIS ロジックは自前実装 + 軽量ユーティリティ（geotiff, earcut）で構築する
- **WebGPU 必須**: `navigator.gpu` が無い環境は `App.jsx` がフォールバック表示を出す。WebGL への自動フォールバックはしない

## 開発コマンド

```bash
npm install          # lockfile から依存をインストール
npm run dev          # Vite 開発サーバー
npm run build        # 本番ビルド（dist/）。バンドルエラーの検出にも使う
npm run preview      # ビルド済み dist/ の確認
npm run lint         # ESLint（flat config）。PR 前に必須
```

自動テストは未構成。品質ゲートは **lint → `npm run dev` での目視確認 → build 成功** の 3 点。lint は `dist` / `reference` / `referencejs` を除外している（`referencejs` は gitignore 済みのローカル参照用ベンダリングコード）。

## アーキテクチャ

### マウント階層

```
main.jsx → ErrorBoundary → App (Canvas, WebGPURenderer 非同期 init)
  → Scene = HeightFieldProvider
      → SceneContent (leva の全フォルダ + 天候/シナリオの合成)
          → LandCoverProvider (region.landcoverUrl)
              → LightingRig / SceneEffects / SkyLayer / HeightFogLayer / MapControls
              → <Coordinate view=region.view> → TerrainLayer (onHeightData → setHeightInfo)
              → 災害・水・雲・草木・ラベル各レイヤー
```

`Scene.jsx` が唯一の合成点。地域プリセット（`src/gis/regions.js`）から 1 つ選び、天候→レイヤー入力の導出結果（`deriveLayerInputs`）を各レイヤーへ配線するだけの役務にとどめる。

### Scene.jsx のトグル運用（削除禁止）

- `// eslint-disable-next-line no-unused-vars` 付きの未使用 import は、lookdev 中にレイヤーを出し入れするための意図的な保持。**未使用だからと削除しない**
- ランタイムのパラメータは leva `useControls`。同名フォルダ（「草」「木」）を Scene と各レイヤーで分けて宣言し、leva がマージする方式。表示トグルを Scene 側に置くのは、非表示中もフォルダを残すため
- ポストFX（`SceneEffects`）は GPU 負荷と TDR リスクのため既定オフ。雲 `steps` も 12 程度に抑える

### 3 つの共有コンテキスト（`src/gis/`）

新しいレイヤーは必ずこれらを経由し、自前で投影・高さ場・土地被覆を持たない。

| コンテキスト | フック | 提供物 | ルール |
| --- | --- | --- | --- |
| `<Coordinate>` (`CoordinateContext.jsx`) | `useProjection()` / `useProjectionMaybe()` | `{ view, projUniforms, projectionType }`。投影平面を床に寝かせる回転を内蔵 | 地理座標は `projectLonLatGPU(lon, lat, projUniforms, projectionType)`（`projectionGPU.js`）で GPU 投影する。CPU 側は `projectionCPU.js` が同じ式を共有 |
| `HeightFieldProvider` (`HeightFieldContext.jsx`) | `useHeightField()` | `{ heightInfo, gpu: { attribute, node, sampler }, setHeightInfo }` | heights の StorageBuffer は Provider が 1 個だけ持つ。接地・衝突・延焼判定は `gpu.sampler`（`heightAt / normalAt / elevationAt`、`src/tsl/sampleHeightField.js`）を使い、自前でバッファを作らない。地形依存レイヤーは `heightInfo &&` で条件マウント |
| `LandCoverProvider` (`LandCoverContext.jsx`) | `useLandCover()` | `{ status, info, texture, classAtWorld, worldToLonLat }`（Dynamic World クラス 0..8、`landcover.js` の `LC` 定数） | カテゴリカル値なので **補間厳禁**（NearestFilter、CPU も nearest）。url の無い region は `idle` のまま従来動作にフォールバックさせる |

地域を追加する場合は `regions.js` の 1 オブジェクト（demUrl・bbox・view・seaLevel・terrain・cloudHeight・labels・任意の landcoverUrl）を足すだけで Scene は変更しない。`seaLevel` は物理 0m ではなく正規化標高上の見た目基準値。手順は `manual/Regions.md`。

### 天候とシナリオ（`src/scenario/`）

- `weather.js` — `DEFAULT_WEATHER` と `deriveLayerInputs(weather)`。「雨→濡れ」「浸水→濁り」「山火事中は通常雲を絞って raymarch 予算を煙と折半」などの **連動ルールはここにだけ書く**。霧・雲量は明示値のみで自動連動しない
- `scenarios.js` — `SCENARIOS` はキーフレーム列（t は 0..1、smoothstep 補間）。各キーフレームはそのシナリオで動かす全フィールドを毎回書く（欠けると DEFAULT に落ちる）。`cloudType` はシナリオ固定（切替が再コンパイルを伴うため）
- `useScenario.js` — leva「シナリオ」フォルダと `useFrame` 進行。weather state は 0.25 秒間隔にスロットリング（毎フレーム再レンダー回避）。`none` で null を返し、Scene は手動（天候フォルダ）にフォールバック

### GPU コンピュートの定型（`src/compute/`, `src/tsl/`）

- パーティクル系は `runRainCompute.js` をテンプレートにコピーベースで派生させる（雪・火の粉・竜巻デブリが実例）。update Fn の中身は災害ごとに異なるので抽象化しない
- バッファは `createParticleBuffers(count, fields)` → `{ attributes, nodes, dispose }`。風は `createWindField()`（`src/tsl/windField.js`、vortex 項付き）を共有
- compute 専用の StorageBufferAttribute は geometry 経由でないため自動解放されない。各パスの `destroy(renderer)` から必ず `disposeStorageAttributes` を呼ぶ（private API `renderer._attributes` 依存、存在チェック付き）
- 移動体は `createInterpolationPass.js` + `observationLayout.js`（`OBSERVATION_STRIDE = 12` floats/エンティティ。日付変更線をまたぐ最短経路補間対応）

### 再コンパイルを避けるためのルール

TSL ノードグラフの構造変更はマテリアル/パイプラインの再コンパイルを招く。頻繁に動く値は必ず `uniform()` 駆動にする。

- `HeightFogLayer` は **マウントしっぱなし** で density を uniform 駆動（条件マウントすると全マテリアルが再コンパイルされる）。自前の大気表現を持つ空・雲は `fog: false`
- レイヤー間で共有する uniform（例: 雷の `lightningFlash` を LightningLayer が書き、CloudLayer が読む）は `useMemo` で参照を安定させる
- 地域切替で DEM が変わる `TerrainLayer` は `key={region.id}` で再マウントし、`setHeightInfo(null)` で旧地形の高さ場を先に破棄する
- 雲の type / quality 切替は再コンパイル前提。coverage は uniform

### ポストプロセッシング（`src/effects/`）

`SceneEffects.jsx` が `RenderPipeline` + `pass(scene, camera)` で scenePass を作り、Bloom → Tilt-Shift → Film Grade をノードグラフで合成して `useFrame` で描画する。Godrays / DoF は `create*.js` を残したままコメントアウトで無効化中。エフェクト追加は `create*Pass()` を 1 ファイル追加してチェーンに挟む。

### マテリアルの基準

`MaterialSamplesLayer` のプリセット（Matte → Semi Gloss → Metal → Mirror → Glass）が lookdev の基準。マテリアル調整は最も近いプリセットからの相対調整で行い、ゼロから作らない。

## コーディングスタイル

- 2 スペース、シングルクォート、セミコロンなし。React 関数コンポーネント + JSX
- レイヤー/コンポーネントは PascalCase（`WaterOceanLayer.jsx`）、ヘルパーは camelCase（`createBloom.js`）。機能ごとにコロケーション
- Three.js / R3F の props は過度に抽象化せず明示的に書く。ESLint は R3F 向けに `dom-no-unknown-property` 等をオフ済み、React Compiler 系の可変オブジェクト警告もオフ
- アセットは `public/` の安定パス（`./dem/*.tif`, `./landcover/*.tif`, `/data/*.geojson`, `/textures/*`）で参照。重い DEM / GeoTIFF の複製は避ける
- ソース内コメントの「plan.md R2 / D4 / Phase 3」等は削除済みロードマップへの参照。該当内容は `docs/disaster-simulation-architecture.md` に統合されているので plan.md を探さない

## コミット・PR

- 件名は短い命令形 + プレフィックス（`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:` / `style:`）。1 コミット 1 関心事
- PR には概要、アセット/データ変更の有無、見た目の変更はスクリーンショットか短い録画を添える

## 言語

開発者は日本人。応答・レビュー・進捗報告は日本語。コード・ファイル名・コマンド・API 識別子は英語のまま。

## 参考ドキュメント

- `manual/README.md` — 各レイヤーとシステム（Coordinate / HeightField / LandCover / Regions / Scenario / SceneEffects）の使用マニュアル索引。props と前提を確認するならまずここ
- `docs/disaster-simulation-architecture.md` — 災害ジオラマ基盤の全体設計
- `docs/rain-terrain-collision.md` — 共有ハイトフィールドと地形衝突
- `docs/gpu-gis-particle-architecture.md` / `docs/r3f-computeshader_llm.md` / `docs/webgpu-particles-tutorial.md` — GPU compute と R3F 統合パターン
- `docs/webgpu_tsl_llm.md` — 他プロジェクトへ持ち出せる WebGPU / TSL の汎用知見
- `docs/projection-formulas.md` — 投影図法の数式（projectionCPU/GPU の根拠）
- `docs/webgpu-quality-enhancement.md` — 品質向上手法の現状表
- `refactoring.md` — リファクタリング候補（水系 3 レイヤーの共通化が最優先）
