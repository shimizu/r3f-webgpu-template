# コードレビュー: r3f-webgpu-template ("Rogue Hunter")

- レビュー日: 2026-07-02（対象コミット: `bfe8e6f`）
- 目的: WebGPU の機能を活かした「次世代 look のジオラマ的 GIS 可視化」モックとしての現状評価
- 観点: ①アーキテクチャ ②コード品質・バグ ③lookdev（見た目） ④プロジェクト基盤

---

## 総評

**設計の核は健全。** 「CPU はパックのみ、投影・補間・描画は GPU」という GPU ファースト方針が `<Coordinate>` コンテキスト + `projectLonLatGPU` / `projectLonLatCPU` の二本柱で一貫して実装されており、CPU/GPU の投影数式は 4 図法すべてで一致していることを確認した。TiltShift + 室内トーンの Sky によるミニチュア look の芯も出ている。モック（lookdev 環境）としての到達度は高い。

一方で、モックゆえの負債が3系統たまっている:

1. **GPU リソース管理の抜け** — compute 系の `destroy()` がバッファを解放しない、SkyLayer / GridLayer に dispose がない。レイヤーをトグルしながら使う lookdev 運用と相性が悪く、実害が出やすい
2. **補間パスの数理バグ** — 日付変更線未対応と、timestamp 機構が恒等式に潰れている問題。移動体（本プロジェクトの主役機能）を本格化する前に直すべき
3. **重複とデッドコード** — 水系3レイヤーの約1200行コピペ、未使用ファイル群。モックから先へ進む際の足かせ

---

## 1. アーキテクチャ

### 良い点

- **投影コンテキストの設計**（`src/gis/CoordinateContext.jsx`）: `<Coordinate projection view>` で投影を一元化し、子レイヤーが `useProjection()` で参照する構造は明快。`useProjectionMaybe()`（throw しない版）による TerrainLayer の投影/legacy 両対応も筋が良い
- **CPU/GPU 数式の一致**: `projectionCPU.js` と `projectionGPU.js` を突き合わせ、equirectangular / mercator / lambert-cylindrical / natural-earth の4図法すべてで係数レベルの一致を確認。「ジオメトリ焼き込み（地形）と GPU 投影（ベクター）が同一平面に乗る」という設計保証が実際に成立している
- **日付変更線処理**（`projectionGPU.js`）: `normalizeRing`（リング連続化）+ Sutherland-Hodgman クリップ + ±360° 複製による dateline 対応は本格的
- **バッファレイアウトの単一ソース化**（`src/compute/observationLayout.js`）: STRIDE / OFFSET / ENUM を CPU・GPU で共有する設計は正しい
- **模範的なリソース管理の例もある**: `StudioEnvironment.jsx` は dispose・環境復元まで完備（ただし未使用、後述）。`TerrainLayer` / `GeojsonLayer` は非同期ロードの `ignore` フラグによるレース対策と dispose が丁寧

### 課題

- **水系3レイヤーの大規模重複（最重要リファクタ対象）**: `WaterBoxLayer.jsx`（426行）/ `WaterBlobLayer.jsx`（504行）/ `WaterOceanLayer.jsx`（287行）は定数群（COLORS / EFFECTS / GLINT / CAUSTIC / FOAM ...）と TSL ノード構築（波高・コースティクス・フレネル・泡）がほぼコピペ。`createWaveHeightNode()` は WaterBox と WaterBlob でほぼ完全一致。共有モジュール（例: `src/layers/water/waterNodes.js`）への抽出で数百行削減でき、水の look 調整も一箇所で済むようになる
- **デッドコードの氾濫**:
  - `src/compute/createProjectionPass.js` — `createInterpolationPass` に置換済みで呼び出しゼロ
  - `src/compute/runBarsCompute.js` — 呼び出しゼロ
  - `src/StudioEnvironment.jsx` — import ゼロ（有効化すれば水系の反射品質が上がるはずで、消し忘れか意図的か要判断）
  - `src/effects/createDof.js` / `createGodrays.js` — `SceneEffects.jsx:16-42` でコメントアウトされたまま
  - `src/backup_Scene.jsx` — Git 履歴で足りる旧構成スナップショット。eslint ignore で延命中
- **Scene.jsx の配線切れ**: `heightInfo` state（`Scene.jsx:35`）が定義されているが `TerrainLayer` に `onHeightData` を渡しておらず、RainLayer を有効化しても地形衝突が機能しない断絶がある
- **暗黙の手動同期**: 海面サイズ `width={21.3} height={12.6}`（`Scene.jsx:77-78`）は `HORMUZ_VIEW` の投影フットプリント（コメント値 21.38×12.68）の手打ち近似。地形と海面の位置 `[0, 0.5, 0]` も別々にハードコード。view から自動算出できると崩れない

## 2. コード品質・バグ（重大度順）

### 2-1. compute 系の `destroy()` が GPU バッファを解放しない — リーク

4ファイル共通で `destroy()` が compute node の dispose のみを行い、`StorageBufferAttribute` を解放しない:

- `createInterpolationPass.js:167-169` — `rawObservationAttribute` / `projectedPositionAttribute` / `headingAttribute` の3本が未解放
- `runRainCompute.js:418-421` — 雨とスプラッシュの position / velocity / life + heightMap の計6本が未解放
- `createProjectionPass.js` / `runBarsCompute.js` — 同構造（ただし未使用）

レイヤーのマウント/アンマウントを繰り返す lookdev 運用では再生成のたびに GPU メモリが積み上がる。

### 2-2. 補間パスの数理バグ（`createInterpolationPass.js`）

- **日付変更線未処理**（`:128`）: `mix(prevLon, lon, blend)` を素の経度で行うため、antimeridian をまたぐ移動体は地球を逆回りする。`mockObservations.js:19-20` は「lon 180 → −180 に西進」とコメントしつつ、実際は 0° 経由で東進する（コメントと実挙動の矛盾がバグの実証になっている）。projectionGPU には `normalizeRing` 相当のラップ処理が既にあるので、補間前に `lon - prevLon` を ±180 に正規化するだけで直せる
- **timestamp 機構が恒等式に潰れている**（`:119-126`）: `playbackTimestamp = mix(prevTs, ts, norm)` の直後に `(playbackTimestamp − prevTs) / (ts − prevTs)` で割り戻すため、`blend ≡ normalizedPlayback` に恒等収束し、per-entity の timestamp は一切効いていない。さらに `ts == prevTs` のとき 0 除算で NaN（clamp では復旧しない）

### 2-3. dispose 漏れ（レイヤー間で不統一）

- `SkyLayer.jsx:135` — `skyMaterial` を useMemo で生成するが dispose する useEffect がない
- `GridLayer.jsx:93-99` — geometry / material とも dispose 不在

TerrainLayer / GeojsonLayer / Water系 / MovingEntitiesLayer は dispose 済みなので、この2ファイルだけが取り残されている。

### 2-4. useMemo 依存配列の問題

- `GridLayer.jsx:99` — `createGridMaterial(materialOptions)` を呼ぶのに依存配列が空 `[]`。props でグリッド色等を変えても反映されない（ESLint も警告済み）
- `RainLayer.jsx:184` — 依存に `heightInfo`（オブジェクト）と `wind`（配列）。呼び出し側がインライン値を渡すとレンダーごとに compute システム全体（GPU バッファ含む）を再生成する。2-1 のリークと組み合わさると被害が増幅する
- `MovingEntitiesLayer.jsx:119` — 同型の問題（`[dataset, view]`）。加えて `:145-157` で useFrame 内に毎フレーム `{...view, loopDuration}` の新規オブジェクト生成（GC プレッシャー）
- `TerrainLayer.jsx:461-464` — `colors === DEFAULT_COLORS` の参照比較依存。現状は無害だが、インライン指定に弱い

### 2-5. WebGPU 非対応フォールバック・ErrorBoundary 不在

- `App.jsx:15-24` — `new WebGPURenderer()` を無条件生成。`navigator.gpu` チェックも `renderer.init()` 失敗時の表示もなく、非対応ブラウザでは白画面
- `main.jsx` — ErrorBoundary なし。DEM / GeoJSON の fetch 失敗も console.error のみで UI に出ない

テンプレート（他人が clone して動かすもの）としては最低限「WebGPU 非対応です」の表示が欲しい。

### 2-6. natural-earth 図法の準拠性

`projectionGPU.js:174-206` / `projectionCPU.js:43-55` とも、Natural Earth の多項式を**相対緯度 φ（lat − centerLat）**に適用している。コメントは「d3-geo-projection の実装に準拠」と謳うが、d3 は絶対緯度に適用する。`HORMUZ_VIEW`（centerLat=27）等では本来の Natural Earth と異なる形状になる。CPU/GPU 間は一致しているため整合性は壊れていないが、「参照実装準拠」の主張は現状では誤り。絶対緯度基準に直すか、コメントを実態に合わせるべき。

### 2-7. その他

- `RainLayer.jsx:205` — useFrame 内で `state.clock.getDelta()` を呼ぶと R3F 内部と競合し delta が 0 になりがち（`|| DEFAULT_DELTA` で握っているのがその兆候）。useFrame の第2引数 delta を使うべき
- `runRainCompute.js:247-249` — 水平速度クランプの `hSpeedSq.pow(0.5)` は真下落下時（h速度≈0）に 0 除算 → NaN 混入の余地
- `TerrainLayer.jsx:499,511` — デバッグ用 console.log の残骸
- `TerrainLayer.jsx` の gaussianBlur は CPU で O(W×H×radius) の同期実行。512² DEM では許容だが、上限拡大時はメインスレッドブロックに注意
- `GeojsonLayer.jsx:1` ほか数ファイルの先頭に空白行（フォーマット揺れ）

## 3. lookdev（次世代 look に向けた評価）

### 効いているもの

- **TiltShift**（`createTiltShift.js`）: 水平帯シャープ + 上下ぼかしが卓上ミニチュア感の主役。完成度高
- **SkyLayer のトーン設計**: zenith をベージュ系に振り、雲をほぼ静止させて「室内の天井」に見せる意図が明確で、ジオラマ＝箱庭のコンセプトに整合
- **WaterOceanLayer の作り込み**: transmission / clearcoat / 4方向スクロール法線 / 疑似コースティクス / フレネル / 上面・側面マスクと厚みは十分

### 改善余地

1. **水面の反射色が世界観から浮いている**: `WaterOceanLayer.jsx:230-232` の反射色が屋外の空色 `#87ceeb` ハードコードで、Sky のベージュ室内トーンと不一致。ジオラマの色設計が水面だけ破綻している。Sky の色定数を共有するか uniform 化を推奨
2. **IBL が未接続**: `envMapIntensity=0.5` を設定しているのに `scene.environment` が未設定（`StudioEnvironment` が未使用のため）。有効化すれば水・地形のスペキュラ品質が一段上がるはず。「次世代 look」への最も費用対効果の高い一手
3. **ミニチュア感が TiltShift 単独依存**: DoF / Godrays は実装済みだが無効化中。DoF（物理ボケ）への置き換え、または近景 DoF + 遠景 TiltShift の併用は検討価値あり
4. **コメントと実装の乖離が look の判断を誤らせる**: Scene.jsx のコメントは「Preetham モデル」だが実装は静的グラデ + fBM 雲（`SkyLayer.jsx`）。`GridLayer.jsx:26` は「工作シートの緑」とコメントしつつ実色は青 `#3f73d3`。lookdev 環境ではコメント＝アートディレクション情報なので、実態に合わせて直すべき
5. **影の一貫性**: キーライト（directional, 4096² shadow map）のみ影あり、spot は影なし（`LightingRig.jsx`）。透明な海面ボックスが `castShadow`（`WaterOceanLayer.jsx:275`）で、影が濃く出るとミニチュア感を損なう恐れ
6. **MaterialSamplesLayer**: CubeCamera `frames: Infinity` ×2（Metal / Mirror）は毎フレーム2回のキューブレンダリングで重い。lookdev 基準としては `frames: 1` や更新間引きで十分な場面が多い

## 4. プロジェクト基盤

### 依存関係（package.json）

- **未使用の dependencies が3件**: `@react-three/postprocessing`（WebGPU ネイティブ後処理へ移行済み）、`chroma-js`（src で import ゼロ。CLAUDE.md は「chroma-js で構築する」と使用前提で記載しており矛盾）、`three-stdlib`（`three/addons` 直接参照のため不要）
- 未宣言依存はなし（`earcut` / `geotiff` / `leva` / `stats-gl` は宣言・使用一致）

### 設定

- `eslint.config.js:20` — `settings.react.version: '18.3'` だが実体は React 19.2。ルール判定がずれる可能性
- `vite.config.js` — 手動チャンク分割（three-webgpu / three-tsl 分離）は WebGPU テンプレートとして妥当

### ドキュメント整合性

- `refactoring.md` / `plan.md` が存在しない `src/gis/projection.js` を参照（実体は `projectionCPU.js` / `projectionGPU.js` に分割済み）
- `refactoring.md` の4項目は #1（ESLint 調整）のみ完了だが本文が未更新。`task.md` は M1〜M5 定義のみで進捗記録なし
- CLAUDE.md の「参考ドキュメント」に `docs/projection-formulas.md` が未記載
- `index.html` — title が「Vite + React」のまま、favicon `/vite.svg` は 404、`lang="en"`

### アセット・テスト

- `public/dem/` に taiwan.tif（972K）と taiwan.png（2.4M）が併存。CLAUDE.md 自身が「DEM の複製は避ける」と明記しており片方は整理候補
- テストは皆無。GPU 依存部分の自動化は難しいが、`projectionCPU.js` / `observationLayout.js` は純関数であり、特に **CPU/GPU 数式一致という設計保証**は projectionCPU の単体テスト（既知の期待値との突き合わせ）で担保できる。最初のテスト対象として最適

---

## 5. 優先度付き改善タスクリスト

### High（実害バグ・look の破綻）

| # | タスク | 対象 |
|---|---|---|
| H1 | compute 系 `destroy()` に StorageBufferAttribute の解放を追加 | `createInterpolationPass.js`, `runRainCompute.js`（+ 残すなら `createProjectionPass.js`, `runBarsCompute.js`） |
| H2 | 補間パスの日付変更線対応（Δlon を ±180 正規化）と timestamp 恒等式・0除算の修正 | `createInterpolationPass.js:119-129`, `mockObservations.js` |
| H3 | WebGPU 非対応時のフォールバック表示 + ErrorBoundary 追加 | `App.jsx`, `main.jsx` |
| H4 | SkyLayer / GridLayer に dispose を追加 | `SkyLayer.jsx:135`, `GridLayer.jsx:93-99` |
| H5 | GridLayer の useMemo 依存配列修正（materialOptions が効かない） | `GridLayer.jsx:99` |

### Medium（保守性・look 品質）

| # | タスク | 対象 |
|---|---|---|
| M1 | 水系3レイヤーの共通 TSL ノード・定数を共有モジュールへ抽出 | `WaterBoxLayer.jsx`, `WaterBlobLayer.jsx`, `WaterOceanLayer.jsx` |
| M2 | StudioEnvironment（IBL）を有効化し、水面反射色を Sky トーンと整合させる | `StudioEnvironment.jsx`, `WaterOceanLayer.jsx:230-232`, `Scene.jsx` |
| M3 | natural-earth を絶対緯度基準に修正、またはコメントを実態に合わせる | `projectionGPU.js:174-206`, `projectionCPU.js:43-55` |
| M4 | RainLayer / MovingEntitiesLayer の依存配列と毎フレームのオブジェクト生成を解消。RainLayer の delta は useFrame 第2引数に | `RainLayer.jsx:184,205`, `MovingEntitiesLayer.jsx:119,145-157` |
| M5 | デッドコード整理（削除 or 用途明記）: createProjectionPass / runBarsCompute / createDof / createGodrays / backup_Scene | `src/compute/`, `src/effects/`, `src/backup_Scene.jsx` |
| M6 | 未使用依存3件の削除、eslint react version を 19 に | `package.json`, `eslint.config.js:20` |
| M7 | Scene.jsx の heightInfo 配線（onHeightData）を整備 or 削除。海面サイズ・位置の view 由来自動算出 | `Scene.jsx:35,74-78` |
| M8 | デバッグ console.log 削除 | `TerrainLayer.jsx:499,511` |

### Low（整備・ドキュメント）

| # | タスク | 対象 |
|---|---|---|
| L1 | projectionCPU の単体テスト導入（CPU/GPU 数式一致の担保） | `src/gis/projectionCPU.js`, `observationLayout.js` |
| L2 | ドキュメント更新: projection.js 参照の修正、chroma-js 記述の削除、projection-formulas.md の追記、refactoring.md/task.md の進捗反映 | `refactoring.md`, `plan.md`, `CLAUDE.md`, `task.md` |
| L3 | コメントと実装の乖離修正（Preetham → 静的グラデ、緑 → 青、フットプリント数値） | `Scene.jsx`, `SkyLayer.jsx`, `GridLayer.jsx:26` |
| L4 | index.html 整備（title / favicon / lang） | `index.html` |
| L5 | taiwan DEM の重複整理（tif / png のどちらかに統一） | `public/dem/` |
| L6 | MaterialSamplesLayer の CubeCamera 更新頻度を間引く | `MaterialSamplesLayer.jsx:31,43` |
