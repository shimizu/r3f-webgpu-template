# 災害ジオラマ可視化基盤 育成ロードマップ

このプロジェクトを「任意地域の自然災害（豪雨・竜巻・雷・雪・山火事）を DEM 地形上に
ジオラマ風に再現する可視化基盤」へ育てるための計画。汎用 3D 可視化基盤としての性格
（lookdev / GIS 展示ステージ）は維持する。

---

## 0. 全体方針

- **二層構造を維持する**: 「汎用基盤（投影・レイヤー・compute・effects）」の上に
  「災害シナリオ層（`src/scenario/`）」を薄く載せる。災害固有のロジックを既存レイヤーに
  埋め込まない。
- **やり過ぎないリファクタ原則**: 個人 lookdev プロジェクトなので、「災害を 2 つ以上
  追加したときに確実に重複が発生する箇所」だけを事前に共有化する。共有するのは以下の
  5 点のみ。フルジェネリックな「パーティクルシステム基盤」は作らない（→ R4 の判断参照）。
  - (a) 地域プリセット
  - (b) 高さ場サンプラ（heightAt / normalAt / elevationAt）
  - (c) 風場 Fn（FBM + 突風 + vortex）
  - (d) raymarch 部品（hitBox / hgPhase / remapClamped）
  - (e) パーティクルバッファ定型（生成 / 破棄）
- **既存パターン厳守**: uniform 駆動 leva（再コンパイル回避）、`useMemo([])` uniforms、
  `disposeStorageAttributes`、時定数追従（TerrainLayer の wet rise/fall パターン）を
  全災害で踏襲する。
- **GPU 予算**: raymarch 合計 steps ≈ 12〜16、パーティクル合計 ≈ 3〜4 万粒を上限目安。
  シナリオ側で「同時に重いものを 2 つ焚かない」制御を持つ
  （例: 山火事シナリオ中は通常雲の coverage を下げる / 非表示にする）。

---

## Phase 1: リファクタリング（災害追加の前提）

### R1. 地域プリセット化 — `src/gis/regions.js`（新規）　規模: S

**課題**: Scene.jsx に HORMUZ_VIEW 固定 import、`SEA_LEVEL = 0.19`、DEM url、
terrain params（smooth/heightScale/baseHeight）、投影後フットプリント 21.3×12.6 の
手打ちが 3 箇所（海面 1 + 雲 2）散在している。views.js のビュー構造も不統一
（JAPAN_VIEW のみ extent を持つ）。

**方針**: 地域に紐づく設定を 1 オブジェクトに集約する。

```js
// src/gis/regions.js
export const REGIONS = {
  hormuz: {
    id: 'hormuz', label: 'ホルムズ海峡',
    demUrl: './dem/hormuz.tif',
    bbox: { lonMin: 45.850, lonMax: 65.1875, latMin: 21.8958, latMax: 32.1167 },
    view: { centerLon: 55.51875, centerLat: 27.00625, worldScale: 71.1,
            projectionType: 'equirectangular', sampleLonStep: 0.2, sampleLatStep: 0.2 },
    seaLevel: 0.19,
    terrain: { smooth: 1.25, heightScale: 0.5, baseHeight: 1.5 },
    cloudHeight: 5,
  },
  taiwan: { /* public/dem/taiwan.tif（既存・未使用）を第 2 リージョンとして登録 */ },
}

// views.js 冒頭コメントの数式（幅 = Δλ·cos(centerLat)·worldScale）を関数化し
// 手打ち 21.3×12.6 を撲滅する
export function regionFootprint({ bbox, view }) { ... }
```

- Scene.jsx は leva dropdown で region を選択し `region.*` を配線するだけにする。
  WaterOcean / CloudLayer のサイズは `regionFootprint()` 由来に（heightInfo 到着前に
  マウントされるレイヤーがあるため bbox から事前計算する）。
- region 切替は DEM 再ロードを伴うので TerrainLayer に `key={region.id}` を付ける。
- 変更: `src/gis/regions.js`（新規）、`src/Scene.jsx`、`src/gis/views.js`（吸収/整理）。

### R2. heightInfo の Context 化 + 高さ場サンプラ共有　規模: M

**課題**: heightInfo が Scene の useState + prop drilling で配布され、高さサンプリングが
GrassLayer（バイリニア）と runRainCompute（最近傍）で重複・非対称実装になっている。
消費者が増えるたびに DEM の GPU コピーも増える。

**2a. `src/gis/HeightFieldContext.jsx`（新規）**

```jsx
// Provider が heightInfo と GPU リソースを一元保持
// - StorageBufferAttribute はここで 1 個だけ生成して配布（DEM の GPU コピー増を防ぐ）
// - value = { heightInfo, gpu: { attribute, node }, setHeightInfo }
export function HeightFieldProvider({ children }) { ... }
export function useHeightField() { ... }
```

TerrainLayer 自体は `onHeightData` prop を維持し Context 非依存のまま（汎用性維持）。
Scene 側で Provider の setter を渡す。

**2b. `src/tsl/sampleHeightField.js`（新規）**

`groundField.js` と同じ `{ heightAt, normalAt }` インターフェースを返すファクトリにして、
手続き地形と DEM 地形を差し替え可能にする（groundField.js の設計意図どおり）。

```js
export function createHeightFieldSampler({ node, cols, rows, terrainWidth, terrainDepth, minY, rangeY }) {
  const heightAt    = Fn(([worldXZ]) => { /* GrassLayer のバイリニア補間を移設 */ })
  const normalAt    = Fn(([worldXZ]) => { /* groundField.js と同じ有限差分 */ })
  const elevationAt = Fn(([worldXZ]) => heightAt(worldXZ).sub(minY).div(rangeY)) // 正規化標高
  return { heightAt, normalAt, elevationAt }
}
```

消費者: GrassLayer（移行）、runRainCompute（nearest → bilinear 化で衝突精度向上）、
以後の雪・火の粉・竜巻デブリ・延焼マスクすべて。

**2c. 状態管理の判断: Zustand は導入しない**

毎フレーム値は「React を通さず uniform に直書き」する既存設計で貫かれており、
React が持つべき状態は region / シナリオ選択・heightInfo 到着程度（低頻度）→ Context で
十分。依存追加ゼロの方針とも一致。タイムライン操作パネル等 UI が育ったら再検討。

### R3. 天候/シナリオ状態の集約 — `src/scenario/weather.js`（新規）　規模: S〜M

**課題**: 天候 leva が独立スライダー群で、雨→濡れの連動だけ Scene.jsx に直書き
（`wetness={Math.max(wetness, rain ? 0.85 : 0)}`）。「災害シナリオ」という単位がない。

```js
// 「天候の意味論」を 1 箇所に集約
export const DEFAULT_WEATHER = {
  rainIntensity: 0, snowIntensity: 0,          // 0..1
  windSpeed: 0.2, windDir: 0,
  cloudCoverage: 0.65, cloudType: 'stratus',
  fogDensity: 0,
  floodLevel: 0,                                // 海面かさ上げ（world units）
  lightningRate: 0,                             // 回/分
  fire: null,      // { ignition: [lon, lat], spreadSpeed, age }
  tornado: null,   // { center: [x, z], radius, strength }
}

// weather → 各レイヤー入力の導出ルール（濡れ・霧・雲量の連動はここだけに書く）
export function deriveLayerInputs(weather) {
  return {
    wetnessTarget: Math.max(weather.rainIntensity * 0.9, weather.floodLevel > 0 ? 1 : 0),
    fogDensity:    weather.fogDensity + weather.rainIntensity * 0.4,
    cloudCoverage: Math.max(weather.cloudCoverage, weather.rainIntensity * 0.85),
    // snowAccumTarget: 時間積分はレイヤー側の時定数追従に任せる
    ...
  }
}
```

leva の天候フォルダは「weather の各フィールドを手動 override するデバッグ UI」として
残す（Phase 3 のシナリオが同じ weather オブジェクトを駆動する）。

### R4. パーティクル部品の切り出し（ランナー抽象化は**しない**）　規模: S

**判断**: 雨・雪・火の粉・竜巻デブリは update Fn の中身が本質的に違い、コールバック
注入型のジェネリックランナーは TSL ビルダー文脈の受け渡しが複雑になる割に 400 行中
80 行程度しか共有できない。**runXxxCompute.js はコピーベース**（runRainCompute が
テンプレート）とし、確実に重複する部品だけ切り出す:

1. `src/compute/particleBuffers.js`（新規）: バッファ生成/破棄の定型。
   ```js
   createParticleBuffers(count, { pos: 3, vel: 3, life: 1, ... })
   // → { attributes, nodes, dispose(renderer) }  // 内部で disposeStorageAttributes
   ```
2. `src/tsl/windField.js`（新規）: runRainCompute の FBM 風場 + 突風を
   `Fn(([pos, time, params]) => vec3)` に移設。**vortex 項（中心・半径・接線速度・
   上昇気流の uniform）をオプション追加**できる形にしておく（竜巻の準備）。
3. 高さサンプリングは R2b の共有サンプラを使用。

### R5. raymarch 部品切り出し — `src/tsl/raymarchUtils.js`（新規）　規模: S

CloudLayer の `hitBox` / `remapClamped` / `hgPhase` を移設して export、CloudLayer は
import に変更。挙動変更なしの純移動なので**最初のコミットに最適**。
煙・漏斗雲・砂嵐が将来の消費者。

### R6. 退役掃除（任意・低優先）　規模: S

`src/compute/createProjectionPass.js`、`src/compute/runBarsCompute.js`、
`src/backup_Scene.jsx` を削除（runRainCompute 冒頭コメントの参照だけ書き換え）。
※ runBarsCompute の寿命系ロジックは火の粉実装の参考になるため、削除前に D5 で
参照する可能性を考慮して良い（git 履歴に残るので削除で問題なし）。

**Phase 1 の順序と依存**: R5 → R6（無リスク）→ R1 → R2 → R4 → R3。
R3 は R1（region 既定天候）と R2（連動先レイヤー）の後が自然。

---

## Phase 2: 各災害の技術アプローチ

| 災害 | 規模 | 追加 GPU 負荷 | 主な再利用 |
|---|---|---|---|
| 雪 | S | 雨と同等（〜1.5 万粒） | runRainCompute, acc uniforms（堆積） |
| 豪雨強化 | S〜M | ほぼ増分なし | RainLayer, WaterOcean, wet uniforms |
| 雷 | M | ほぼゼロ（CPU 生成 + emissive） | Bloom（任意）, LightingRig |
| 竜巻 | L | パーティクル +1〜2 万粒 | windField, particleBuffers |
| 山火事 | L | storage texture 256²（軽微）+ 煙 raymarch（雲と予算折半） | CloudLayer, coverageMask, rain 派生 |

### D1. 豪雨（既存 Rain 強化）　規模: S〜M

- **雨量パラメータ**: `rainIntensity` uniform。可視パーティクル数は
  `instanceIndex < int(intensity × count)` でリスポーン抑止（バッファ再確保なし・
  uniform 駆動で再コンパイルなし）。rainSpeed / 風強度 / スプラッシュ量も intensity
  から導出。
- **視程低下（霧）**: postfx 既定オフのため `scene.fogNode` に距離 + 高さフォグの
  TSL Fn（`src/tsl/heightFog.js` 新規、`fogDensity` uniform 駆動）。ジオラマなので
  薄めの高さフォグが tilt-shift 感と相性が良い。
- **増水/浸水**: **新レイヤーは作らず WaterOceanLayer の水位（Y 位置）uniform 上昇**。
  DEM メッシュは不動なので水面が上がるだけで海岸線が自動で内陸に食い込む。
  追加は (a) `floodLevel` uniform (b) 濁り色 mix（青→土色） (c) opacity 微増の 3 点。
- 変更: `RainLayer.jsx` / `runRainCompute.js` / `WaterOceanLayer.jsx` /
  `src/tsl/heightFog.js`（新規）。

### D2. 雪　規模: S（最小差分・最初に着手推奨）

- `src/compute/runSnowCompute.js` + `src/layers/SnowLayer.jsx`（rain コピーベース）。
  差分: 落下速度 1/8〜1/10、windField の水平影響倍率↑（横流され）、スプラッシュ無効
  （着地でフェード消滅）。フレーク回転は compute 不要 — 描画側 vertex で
  `time × idPhase` の billboard 回転。
- **堆積連動**: 着地イベントを GPU から返す必要はない。`snowIntensity > 0` の間、
  CPU 側で `accUniforms.amount` の目標値を時間積分で上げる（TerrainLayer の wet
  時定数追従パターン流用、rise 遅め / fall 非常に遅め）。物理的整合より lookdev 的
  説得力を優先。既存の堆積表現（雪線・北斜面）と自然に噛み合う。

### D3. 雷　規模: M

- `src/layers/LightningLayer.jsx`（新規）。**ボルト生成は CPU で十分**（発生頻度が
  低く毎フレーム compute する意味がない）。ミッドポイント変位（再帰 2 分割 + 横ずれ、
  深さ 6〜7）+ 確率分岐で主幹 1 本 + 枝 3〜5 本 → 太さ減衰付き Tube か加算リボン。
- マテリアル: `MeshBasicNodeMaterial` + 高輝度 emissive（postfx オン時は Bloom が
  拾う。オフ時も加算ブレンド + コア白飛びで自立）。
- **フラッシュ**: LightingRig の directional intensity を 1〜2 フレームスパイク +
  CloudLayer に `flash` uniform（marched 内 ambient 項に加算 = 雲の内部発光）。
  雲内放電（フラッシュのみ）を 7:3 で混ぜると安い割に効く。
- **タイミング**: ポアソン過程（`lightningRate` 回/分）、
  「リーダー伸長 0.1s → 本閃光 0.05s → 残光減衰 0.3s」の 3 段エンベロープ
  （useFrame 内の小さなステートマシン）。落雷点は高標高セルの重み付き抽選も可（任意）。

### D4. 竜巻　規模: L

- **渦風場**: R4 の windField に vortex 項（中心 vec2 / 半径 / 接線速度 / 吸引 /
  上昇気流の uniform）。接線 + 吸引 + 上昇の合成で自然な螺旋になる。
- **デブリ/塵**: `src/compute/runVortexCompute.js`（rain 派生）。重力弱・寿命制、
  地表近くの中心近傍でスポーン → 螺旋上昇 → 上空で消滅・リスポーン。1〜2 万粒。
- **漏斗雲**: raymarch 円錐は CloudLayer と steps 予算を食い合うため、
  **メッシュ案を推奨**: Lathe 円錐に vertex で「半径 = 高さのべき乗カーブ +
  valueFbm3 揺らぎ + ねじれ回転」、fragment で scrolling ノイズ alpha
  （valueNoise.js 流用）。根本は塵ビルボード群で接地感。uniform 駆動・予算内。
  raymarch 版は「竜巻中は CloudLayer steps を 6 に落とす」条件付きの将来オプション。
- **移動**: 中心位置を時間パラメトリックな緩い経路で移動（シナリオから駆動）。
  中心 uniform は風場・漏斗メッシュ・スポーン域で共有。
- 新規: `src/layers/TornadoLayer.jsx`, `src/compute/runVortexCompute.js`。

### D5. 山火事　規模: L（最大。3 サブフェーズに分割）

- **5a. 延焼マスク + 焼け跡**: 最初のコミットは**解析近似版**で lookdev する:
  発火点からの距離場 `dist(worldXZ, ignition) − spreadSpeed × age` + coverageMask
  ノイズで「燃焼前線リング（burning 帯）/ 内側 burnt / 外側 unburnt」を Fn 一発で
  構成（compute 不要、age uniform を進めるだけで延焼が動く）。TerrainLayer に
  `burnMask` 入力を追加し albedo 焦げ + roughness↑（wet/acc と同じパターン）。
  本命の **256×256 storage texture ping-pong CA**（fuel/burning/burnt、風向 uniform で
  異方性延焼、elevationAt で上り坂加速）は同じ「worldXZ → burn 状態」インターフェースの
  差し替えとして後日。`src/tsl/burnField.js`（新規）。
- **5b. 炎 + 火の粉**: 炎は burning 帯からスポーンするビルボードパーティクル
  （上昇 + 揺らぎ + 短寿命、加算ブレンド、valueFbm3 で形状浸食）。火の粉は
  `src/compute/runEmberCompute.js`（rain 派生: 浮力 + windField 強め + 寿命フェード）。
  5000〜8000 粒で十分。`src/layers/FireLayer.jsx`（新規）。
- **5c. 煙**: CloudLayer 派生 preset（暗色・吸収強・phaseG 低）を追加し、
  `sampleBase` の密度を延焼マスクで XZ ゲート。**予算**: 山火事シナリオ中は通常雲の
  coverage を下げるか非表示にし、raymarch 合計 steps 12〜16 に収める（シナリオの
  derive で制御）。

---

## Phase 3: シナリオ/演出システム

`src/scenario/scenarios.js` + `ScenarioPlayer`（plain JS クラス）+ `useScenario.js`
（React 接着）。

```js
// scenarios.js — 天候キーフレーム列。1 選択で複数レイヤーが連動する単位
export const SCENARIOS = {
  thunderstorm: {
    label: '雷雨',
    duration: 120, // 秒。0..1 を leva スライダーでスクラブ可能に
    keyframes: [
      { t: 0.0, weather: { cloudCoverage: 0.4, rainIntensity: 0 } },
      { t: 0.2, weather: { cloudCoverage: 0.9, rainIntensity: 0.3, fogDensity: 0.2 } },
      { t: 0.5, weather: { rainIntensity: 1.0, lightningRate: 6, floodLevel: 0.05 } }, // ピーク
      { t: 1.0, weather: { rainIntensity: 0, cloudCoverage: 0.5, lightningRate: 0 } }, // 終息
    ],
  },
  blizzard: {...}, tornado: {...}, wildfire: {...},
}
```

- **ScenarioPlayer**: useFrame で t を進め、キーフレーム間を smoothstep 補間 →
  `deriveLayerInputs()`（R3）→ 各 uniform / 目標値へ直書き。React 再レンダーは
  発生させない（既存の uniform 駆動哲学と同型）。発生→ピーク→終息はキーフレームで
  表現し、専用の状態機械は作らない。雷の離散イベントだけ rate を受けて Player 内の
  ポアソン発火で処理。
- **leva との住み分け**:
  1. `シナリオ` フォルダ = シナリオ選択 dropdown + 再生/停止 + 進行スクラブ
  2. `天候 (override)` フォルダ = 既存スライダー群。手動で触った項目はシナリオ値より
     優先（dirty フラグ方式、リセットボタン付き）
  3. 各レイヤーの lookdev フォルダ（草・堆積・雲品質等）は現状維持
  = 「シナリオは何が起こるか、leva はどう見えるか」

---

## Phase 4: 推奨実装順序（1 タスク = 1 コミット、各コミット後に動作確認）

| # | タスク | 根拠 | 状態 |
|---|---|---|---|
| 1 | R5 raymarchUtils 切り出し + R6 掃除 | 無リスク・即完了。以後の diff が読みやすくなる | ✅ 完了 |
| 2 | R1 地域プリセット化（hormuz + taiwan） | taiwan.tif が既にあり即検証可能。汎用基盤性の核 | ✅ 完了 |
| 3 | R2 HeightFieldContext + sampleHeightField | 以後の全災害の足場。雨の衝突も bilinear 化 | ✅ 完了 |
| 4 | R4 particleBuffers + windField 切り出し | 雪の直前にやると差分が最小 | ✅ 完了 |
| 5 | **D2 雪** | 既存資産再利用率が最高（rain 派生 + 堆積既存）。最小コストで「災害が 2 つある」状態になり抽象の妥当性を検証できる | ✅ 完了 |
| 6 | **D1 豪雨強化**（intensity・fog・浸水） | 既存 3 レイヤーの uniform 追加が主で薄く広い | ✅ 完了（霧は手動のみ・0 で無効の方針に変更） |
| 7 | R3 + Phase 3 最小版（雷雨=豪雨のみ / 吹雪の 2 本） | 災害が 2 つ揃った時点でシナリオ化。以後は「シナリオ 1 個追加」で済む | ✅ 完了（override dirty フラグは未実装 = シナリオ選択中はシナリオ優先） |
| 8 | **D3 雷** | thunderstorm シナリオが完成形になる。演出効果対コスト比が最良 | ✅ 完了 |
| 9 | **D4 竜巻** | windField 拡張 + メッシュ漏斗。ここまでの部品が全部効く | ✅ 完了 |
| 10 | **D5 山火事**（5a → 5b → 5c） | 最大規模なので最後。5a 解析版だけ先行して見た目を確定 | ✅ 完了（延焼は解析近似版。CA 版は将来課題） |

**将来課題（未着手）**
- 延焼マスクの 256² ping-pong CA 化（風向異方性・上り坂加速。burnField と同一インターフェースで差し替え）
- シナリオ手動 override の dirty フラグ方式（現状はシナリオ選択中は常にシナリオ優先）
- 竜巻の raymarch 漏斗（CloudLayer steps を絞る条件付きオプション）

---

## 対象ファイル早見表

**中心となる既存ファイル**
- `src/Scene.jsx` — 地域・天候・連動ルールの集約解消の中心
- `src/compute/runRainCompute.js` — 雪・火の粉・デブリのテンプレート。windField / 高さサンプラの切り出し元
- `src/layers/TerrainLayer.jsx` — wet / acc / burn の表面表現ハブ、heightInfo の供給源
- `src/layers/CloudLayer.jsx` — raymarch 部品の切り出し元、煙・フラッシュの派生元
- `src/gis/views.js` — regions.js への統合元（footprint 計算式のコメントが移設対象）

**新規予定ファイル**
- `src/gis/regions.js`, `src/gis/HeightFieldContext.jsx`
- `src/tsl/sampleHeightField.js`, `src/tsl/windField.js`, `src/tsl/raymarchUtils.js`, `src/tsl/heightFog.js`, `src/tsl/burnField.js`
- `src/compute/particleBuffers.js`, `src/compute/runSnowCompute.js`, `src/compute/runVortexCompute.js`, `src/compute/runEmberCompute.js`
- `src/layers/SnowLayer.jsx`, `src/layers/LightningLayer.jsx`, `src/layers/TornadoLayer.jsx`, `src/layers/FireLayer.jsx`
- `src/scenario/weather.js`, `src/scenario/scenarios.js`, `src/scenario/ScenarioPlayer.js`, `src/scenario/useScenario.js`
