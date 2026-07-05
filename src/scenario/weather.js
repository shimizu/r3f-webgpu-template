/*
  天候状態の定義と、天候 → 各レイヤー入力への導出ルール（plan.md R3）。

  「雨が降ると地面が濡れる」「増水すると水が濁る」といった天候の意味論を
  ここに一元化する。Scene.jsx は weather オブジェクトを作って
  deriveLayerInputs() に通し、結果を各レイヤーに配線するだけにする。

  weather の出所は 2 系統:
  - 手動: leva「天候」フォルダのスライダー群（Scene が組み立てる）
  - シナリオ: scenarios.js のキーフレーム補間（useScenario が返す）

  注: 霧・雲量は「明示された値のみ」を使い、雨からの自動連動はしない
  （手動時の予測可能性を優先。シナリオはキーフレームで明示的に駆動する）
*/

export const DEFAULT_WEATHER = {
  rainIntensity: 0, // 雨量 0..1（0 = 雨なし）
  snowIntensity: 0, // 雪量 0..1（0 = 雪なし）
  fogDensity: 0, // 霧 0..1（0 = 無効）
  floodLevel: 0, // 水位上昇（world units）
  wetness: 0, // 手動の地面の濡れ 0..1
  cloudCoverage: 0.65, // 雲量 0..1
  cloudType: 'stratus', // 雲タイプ（変更は再コンパイルを伴う）
  lightningRate: 0, // 落雷頻度（回/分。0 = 雷なし）
  tornadoStrength: 0, // 竜巻の強さ 0..1（0 = なし）
  fireProgress: 0, // 山火事の延焼進行 0..1（0 = なし。半径への変換は Scene 側）
}

// weather → 各レイヤーの入力値。連動ルールはここだけに書く
export function deriveLayerInputs(weather) {
  const w = { ...DEFAULT_WEATHER, ...weather }
  return {
    // 降雨（0.01 未満はマウントしない）
    rainActive: w.rainIntensity > 0.01,
    rainIntensity: w.rainIntensity,

    // 降雪
    snowActive: w.snowIntensity > 0.01,
    snowIntensity: w.snowIntensity,
    snowing: w.snowIntensity > 0.01, // TerrainLayer の堆積駆動

    // 霧（明示値のみ。0 で完全無効）
    fogDensity: w.fogDensity,

    // 浸水と濁り: 水位が上がる or 強い雨で泥水に寄る
    floodLevel: w.floodLevel,
    murkiness: Math.min(1, w.floodLevel * 2.5 + w.rainIntensity * 0.25),

    // 地面の濡れ: 手動値・雨量・浸水の最大（時定数追従は TerrainLayer 側）
    wetnessTarget: Math.max(
      w.wetness,
      w.rainIntensity * 0.9,
      w.floodLevel > 0.02 ? 0.9 : 0
    ),

    // 雲（明示値のみ）
    cloudCoverage: w.cloudCoverage,
    cloudType: w.cloudType,

    // 雷（ポアソン発火のレートとして LightningLayer が消費）
    lightningRate: w.lightningRate,

    // 竜巻（0.01 未満はマウントしない）
    tornadoActive: w.tornadoStrength > 0.01,
    tornadoStrength: w.tornadoStrength,

    // 山火事（延焼進行。0 で無効）
    fireActive: w.fireProgress > 0.001,
    fireProgress: w.fireProgress,
  }
}
