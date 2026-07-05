# ScenarioSystem（天候・災害シナリオ）

天候状態の一元管理と、災害シナリオ（キーフレーム再生）のシステム。`src/scenario/` の 3 ファイル構成。

## 概要

「雨が降ると地面が濡れる」「増水すると水が濁る」といった**天候の意味論**を
`deriveLayerInputs()` に一元化し、Scene は weather オブジェクトを通すだけで
各レイヤーが連動する。weather の出所は 2 系統:

- **手動**: leva「天候」フォルダのスライダー群（シナリオ未選択時）
- **シナリオ**: キーフレーム列の補間再生（leva「シナリオ」フォルダで選択・再生・スクラブ）

現在のシナリオ: **雷雨（豪雨）/ 山火事 / 竜巻 / 吹雪** の 4 本。

## 構成ファイル

### `weather.js` — 状態定義と連動ルール

```js
DEFAULT_WEATHER = {
  rainIntensity, snowIntensity,   // 0..1
  fogDensity, floodLevel, wetness,
  cloudCoverage, cloudType,
  lightningRate,                  // 回/分
  tornadoStrength, fireProgress,  // 0..1
}

deriveLayerInputs(weather) => {
  rainActive, rainIntensity, snowActive, snowIntensity, snowing,
  fogDensity, floodLevel, murkiness, wetnessTarget,
  cloudCoverage, cloudType, lightningRate,
  tornadoActive, tornadoStrength, fireActive, fireProgress,
}
```

連動ルール（すべてここだけに書く。Scene に直書きしない）:
- 濡れ = max(手動, 雨量×0.9, 浸水>0.02 → 0.9)
- 濁り = min(1, 浸水×2.5 + 雨量×0.25)
- 山火事中は通常雲の coverage を延焼進行に応じて絞る（煙 raymarch と予算折半）
- 霧・雲量は明示値のみ（雨からの自動連動はしない = 手動時の予測可能性優先）

### `scenarios.js` — キーフレーム定義

```js
SCENARIOS.thunderstorm = {
  id, label: '雷雨（豪雨）',
  duration: 90,            // 秒
  cloudType: 'cumulus',    // シナリオ固定（変更は再コンパイルを伴うため）
  keyframes: [
    { t: 0.0, w: { rainIntensity: 0, cloudCoverage: 0.45, ... } },
    { t: 0.45, w: { rainIntensity: 1.0, lightningRate: 10, floodLevel: 0.1, ... } },
    { t: 1.0, w: { rainIntensity: 0, ... } },
  ],
}
```

- `sampleScenario(scenario, t)` がキーフレーム間を smoothstep 補間して weather を返す
- **各キーフレームは、そのシナリオで動かす全フィールドを毎回書くこと**
  （欠けたフィールドは DEFAULT_WEATHER 値に落ちる）

### `useScenario.js` — 再生フック

leva「シナリオ」フォルダ（選択 / 再生 / 進行スクラブ）を持ち、再生中は useFrame で
t を進めて weather を返す。`none` 選択時は null（→ Scene は手動にフォールバック）。

- weather state は **0.25 秒間隔にスロットリング**（毎フレーム再レンダー回避。
  濡れ・堆積は TerrainLayer 側の時定数追従が段差を均す）
- 終端（t=1）で自動停止。シナリオ切替で先頭に巻き戻し

## 使用例

```jsx
// Scene.jsx
const scenarioWeather = useScenario()          // null = 手動モード
const manualWeather = { rainIntensity: rain ? rainIntensity : 0, ... } // 天候フォルダの値
const inputs = deriveLayerInputs(scenarioWeather ?? manualWeather)

// inputs を各レイヤーへ配線
{inputs.rainActive && heightInfo && <RainLayer intensity={inputs.rainIntensity} ... />}
<TerrainLayer wetness={inputs.wetnessTarget} snowing={inputs.snowing} ... />
<CloudLayer coverage={inputs.cloudCoverage} type={inputs.cloudType} ... />
```

## 新しいシナリオ / 連動の追加手順

1. **天候フィールドの追加**: `DEFAULT_WEATHER` に初期値、`deriveLayerInputs` に
   レイヤー入力への変換を追加。手動操作が要るなら Scene の「天候」フォルダにスライダー
2. **シナリオの追加**: `SCENARIOS` にキーフレーム列を追加するだけ
   （`SCENARIO_OPTIONS` は自動生成）
3. **新しい連動ルール**は必ず `deriveLayerInputs` に書く（Scene 直書き禁止）

## 調整のポイント

- leva の住み分け: 「シナリオ」= 何が起こるか / 「天候」= 手動 override /
  各レイヤーの lookdev フォルダ（草・木・堆積・雲品質等）= どう見えるか
- シナリオ選択中は天候フォルダのスライダーは効かない（dirty フラグ方式の
  手動 override は将来課題）
- cloudType をキーフレームで動かさないこと（再コンパイルが走る）
- 雷は `lightningRate` を LightningLayer が受け、Layer 内のポアソン過程で発火する
  （シナリオは頻度だけを制御する）

## 関連

- ソース: `src/scenario/weather.js`, `src/scenario/scenarios.js`, `src/scenario/useScenario.js`
- ドキュメント: `docs/disaster-simulation-architecture.md` §5
- 消費者: Scene.jsx（配線）、全災害レイヤー・TerrainLayer・CloudLayer・WaterOceanLayer・HeightFogLayer
