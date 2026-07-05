# 災害ジオラマ可視化アーキテクチャ

本ドキュメントは、DEM 地形上に自然災害（豪雨・雪・雷・竜巻・山火事）を
ジオラマ風に再現する仕組みの設計を解説する。汎用 3D 可視化基盤としての性格は
維持しつつ、その上に「災害シナリオ層」を薄く載せる二層構造を採る。

関連ドキュメント:
- `rain-terrain-collision.md` — 地形衝突と共有ハイトフィールドの詳細
- `r3f-computeshader_llm.md` §13, §18〜§20 — パーティクル骨格と共有部品
- `webgpu-quality-enhancement.md` — ポスト処理と GPU 予算

---

## 0. 設計方針

- **二層構造**: 汎用基盤（投影・レイヤー・compute・effects）の上に
  災害シナリオ層（`src/scenario/`）を載せる。災害固有のロジックを既存レイヤーに
  埋め込まず、レイヤーは uniform 駆動のパラメータだけを受け取る
- **やり過ぎないリファクタ**: 「災害を 2 つ以上追加したとき確実に重複する箇所」だけ
  共有化する。共有するのは (a) 地域プリセット (b) 高さ場サンプラ (c) 風場 Fn
  (d) raymarch 部品 (e) パーティクルバッファ定型 の 5 点。フルジェネリックな
  パーティクル基盤は作らない
- **uniform 駆動の徹底**: 毎フレーム変わる値は React を通さず uniform に直書きする。
  スライダー操作でシェーダ再コンパイルを起こさない（`useMemo([])` で uniform を
  一度だけ生成し `.value` を更新）
- **GPU 予算**: raymarch 合計 steps ≈ 12〜16、パーティクル合計 ≈ 3〜4 万粒を上限目安。
  重い raymarch を同時に 2 つ焚かない（山火事中は通常雲の coverage を絞る）

---

## 1. 地域プリセット（`src/gis/regions.js`）

「どの地域をジオラマ化するか」に紐づく設定を 1 オブジェクトに集約する。
DEM url・bbox・投影ビュー・海面標高・地形パラメータ・ラベル・移動体生成域を含む。

```js
REGIONS.hormuz = {
  id, label, demUrl, bbox, view, seaLevel, terrain, cloudHeight, labels, entityRegion,
}
```

- `regionFootprint({ bbox, view })` で投影後のフットプリント（XZ スパン）を
  bbox + view から算出する。海面・雲は heightInfo（DEM ロード完了）を待たずに
  マウントするため、この事前計算値でサイズを決める
- Scene は leva「地域」セレクタで REGIONS から 1 つ選び、各レイヤーへ配線するだけ。
  TerrainLayer は `key={region.id}` で DEM 再ロードのたびに再マウント
- 現状 `hormuz`（ホルムズ海峡）と `taiwan`（台湾）を登録

---

## 2. 共有ハイトフィールド（`src/gis/HeightFieldContext.jsx`）

TerrainLayer が `onHeightData` で発行する `heightInfo` を Provider が保持し、
DEM の `StorageBufferAttribute` を **1 個だけ**生成して配布する。
`useHeightField()` で `{ heightInfo, gpu: { attribute, node, sampler }, setHeightInfo }`
を取得。sampler は `src/tsl/sampleHeightField.js` の `{ heightAt, normalAt, elevationAt }`。

詳細は `rain-terrain-collision.md` を参照。全災害・草・地形表面がこの高さ場を共有する。

---

## 3. 共有部品（`src/tsl/`, `src/compute/`）

| 部品 | 役割 | 主な消費者 |
|---|---|---|
| `compute/particleBuffers.js` | storage バッファ群の確保/破棄の定型 | 全パーティクルランナー |
| `tsl/windField.js` | FBM 風場 + 突風（+ 竜巻用 vortex 項） | 雨/雪/火の粉/竜巻 |
| `tsl/sampleHeightField.js` | worldXZ → 高さ/法線/正規化標高（CPU 版 `cpuHeightAt` も） | 全災害・草・地形 |
| `tsl/coverageMask.js` | fBM パッチ被覆マスク | 濡れ・堆積・草 |
| `tsl/burnField.js` | 発火点距離場の解析近似 → vec2(burnt, burning) | 山火事（地形・炎・煙） |
| `tsl/raymarchUtils.js` | hitBox / remapClamped / hgPhase | 雲・煙 |
| `tsl/valueNoise.js` | 軽量 value fBM | 雲・竜巻漏斗・炎 |
| `tsl/heightFog.js` | 距離+高さ指数フォグ | HeightFogLayer |

パーティクルランナー（`runXxxCompute.js`）は `runRainCompute.js` をテンプレートに
**コピーベースで派生**する。update Fn の物理は災害ごとに違うため抽象化せず、
上記の共有部品だけを再利用する。

---

## 4. 各災害の実装

### 豪雨（`RainLayer` + `runRainCompute.js`）
- `intensity` uniform で活性粒数を変える（`instanceIndex < intensity×count`。非活性は
  画面外へ退避）。粒数・風の強さが連動、再確保/再コンパイルなし
- 視程低下は `HeightFogLayer`（`scene.fogNode`）。浸水は `WaterOceanLayer` の
  `floodLevel`（水位上昇）+ `murkiness`（泥水の濁り）。新レイヤーは作らない

### 雪（`SnowLayer` + `runSnowCompute.js`）
- rain 派生。落下速度 約 1/7、windField の横流れを強める。スプラッシュなし、
  `rest` バッファで着地静止 → フェード → リスポーン。回転は vertex 側で time × 位相
- 堆積は TerrainLayer の acc を `snowing` フラグで時定数駆動（積雪はゆっくり増え、
  止んでも長く残る）

### 雷（`LightningLayer`）
- ボルトは **CPU 生成**（ミッドポイント変位 + 確率分岐）。接線×視線で billboard する
  加算リボン。ポアソン過程（rate 回/分）+ 3 段エンベロープ（リーダー→本閃光→残光）
- フラッシュはポイントライト（地形を照らす）+ `flashNode` uniform（CloudLayer の
  雲内発光と共有）の 2 系統。落雷点は heightInfo の高標高候補から抽選

### 竜巻（`TornadoLayer` + `runVortexCompute.js`）
- windField の vortex 項（Rankine 渦近似）で螺旋上昇するデブリ（`windAt` を目標風速と
  して時定数緩和で追従 → 安定した螺旋）
- 漏斗雲は **LatheGeometry のメッシュ**（vertex で fBM 半径揺らぎ + 蛇行、fragment で
  スクロールノイズ opacity）。raymarch を使わず CloudLayer と steps 予算を食い合わない
- 中心はリサージュ軌道で移動し、`vortex.center` uniform と漏斗メッシュ位置を同期

### 山火事（`FireLayer` / `SmokeLayer` + `runEmberCompute.js` + `burnField.js`）
- **延焼マスク**は `burnField.js` の解析近似（発火点距離場 + fBM 凸凹 → burnt/burning）。
  radius uniform を CPU で進めるだけで延焼が動く。将来 256² CA に差し替える場合も
  同じ `worldXZ → vec2(burnt, burning)` インターフェースを維持する
- TerrainLayer は同マスクで焼け跡 albedo + 前線残火 emissive（wet/acc と同パターン）
- 炎 + 火の粉は `runEmberCompute.js`（前線リングからスポーン、パラメータ差で 2 役）
- 煙は CloudLayer の `smoke` プリセット + 延焼マスクの XZ ゲート（`gateAt` prop）

---

## 5. シナリオ / 天候システム（`src/scenario/`）

### weather.js — 連動ルールの一元化
`DEFAULT_WEATHER`（rainIntensity / snowIntensity / fogDensity / floodLevel /
cloudCoverage / lightningRate / tornadoStrength / fireProgress 等）と
`deriveLayerInputs(weather)`。「雨→濡れ」「浸水→濁り」「山火事中は通常雲を絞る」
といった連動ルールはここだけに書く（Scene に直書きしない）。
霧・雲量は明示値のみで自動連動しない（手動時の予測可能性を優先）。

### scenarios.js — 天候キーフレーム列
`SCENARIOS` に災害シナリオ（雷雨・吹雪・竜巻・山火事）を定義。各シナリオは
キーフレーム列（発生 → ピーク → 終息）を持ち、`sampleScenario(scenario, t)` で
smoothstep 補間する。cloudType はシナリオ固定（変更が再コンパイルを伴うため）。

### useScenario.js — 再生フック
leva「シナリオ」フォルダ（選択 / 再生 / 進行スクラブ）+ useFrame 進行。
weather state は 0.25 秒間隔にスロットリング（毎フレーム再レンダー回避。濡れ・堆積は
TerrainLayer 側の時定数追従が段差を均す）。`none` 選択時は null を返し、Scene は
手動（天候フォルダのスライダー）にフォールバックする。

### Scene での合成
```
scenarioWeather = useScenario()          // null なら手動
manualWeather   = { ...天候フォルダのスライダー }
inputs = deriveLayerInputs(scenarioWeather ?? manualWeather)
// inputs.rainActive / rainIntensity / snowing / fogDensity / floodLevel /
//   murkiness / wetnessTarget / cloudCoverage / lightningRate /
//   tornadoActive / fireActive / fireProgress … を各レイヤーへ配線
```

leva の住み分け:
1. `シナリオ` フォルダ = シナリオ選択 + 再生 + 進行スクラブ
2. `天候` フォルダ = 手動 override（シナリオ未選択時に有効）
3. 各レイヤーの lookdev フォルダ（草・堆積・雲品質等）は常時有効

---

## 6. GPU 予算の考え方

- パーティクル: 雨 15k / 雪 12k / 火の粉+炎 7k / 竜巻デブリ 8k 程度。同時に焚くのは
  シナリオ 1 本ぶんが目安
- raymarch: 通常雲 steps≈12 + 煙 steps≈8。山火事中は `deriveLayerInputs` が通常雲の
  coverage を延焼進行に応じて絞り、合計 steps を予算内に収める
- 竜巻の漏斗はメッシュで実装し raymarch を増やさない
- ポストFX（SceneEffects）は既定オフ。重い構成と併用時は TDR に注意

---

## 7. 将来課題

- 延焼マスクの 256² ping-pong CA 化（風向異方性・上り坂加速。`burnField` と同一
  インターフェースで差し替え）
- シナリオ手動 override の dirty フラグ方式（現状はシナリオ選択中は常にシナリオ優先）
- 竜巻の raymarch 漏斗（CloudLayer steps を絞る条件付きオプション）
