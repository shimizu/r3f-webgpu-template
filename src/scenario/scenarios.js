/*
  災害シナリオ定義（plan.md Phase 3 最小版）。

  シナリオ = 天候キーフレーム列。1 つ選ぶだけで複数レイヤー（雨・雪・霧・
  浸水・雲・濡れ・堆積）が連動し、発生 → ピーク → 終息の時間発展を再生する。

  キーフレーム規約:
  - t は 0..1 の正規化時刻（実時間は duration 秒）
  - 各キーフレームの w は「そのシナリオで動かす全フィールド」を毎回書くこと
    （欠けたフィールドは補間できず DEFAULT_WEATHER 値に落ちる）
  - cloudType はキーフレームにせずシナリオ固定（変更が再コンパイルを伴うため）
*/

import { DEFAULT_WEATHER } from './weather'

export const SCENARIOS = {
  thunderstorm: {
    id: 'thunderstorm',
    label: '雷雨（豪雨）',
    duration: 90, // 秒
    cloudType: 'cumulus',
    keyframes: [
      { t: 0.0, w: { rainIntensity: 0, fogDensity: 0, floodLevel: 0, cloudCoverage: 0.45, lightningRate: 0 } },
      { t: 0.15, w: { rainIntensity: 0.3, fogDensity: 0.08, floodLevel: 0, cloudCoverage: 0.75, lightningRate: 2 } },
      { t: 0.45, w: { rainIntensity: 1.0, fogDensity: 0.3, floodLevel: 0.1, cloudCoverage: 0.95, lightningRate: 10 } },
      { t: 0.7, w: { rainIntensity: 0.85, fogDensity: 0.25, floodLevel: 0.16, cloudCoverage: 0.9, lightningRate: 6 } },
      { t: 1.0, w: { rainIntensity: 0, fogDensity: 0.05, floodLevel: 0.06, cloudCoverage: 0.55, lightningRate: 0 } },
    ],
  },

  tornado: {
    id: 'tornado',
    label: '竜巻',
    duration: 75,
    cloudType: 'cumulus',
    keyframes: [
      { t: 0.0, w: { tornadoStrength: 0, rainIntensity: 0, fogDensity: 0, cloudCoverage: 0.55 } },
      { t: 0.18, w: { tornadoStrength: 0.5, rainIntensity: 0.15, fogDensity: 0.05, cloudCoverage: 0.85 } },
      { t: 0.5, w: { tornadoStrength: 1.0, rainIntensity: 0.35, fogDensity: 0.12, cloudCoverage: 0.95 } },
      { t: 0.8, w: { tornadoStrength: 0.6, rainIntensity: 0.2, fogDensity: 0.08, cloudCoverage: 0.8 } },
      { t: 1.0, w: { tornadoStrength: 0, rainIntensity: 0, fogDensity: 0, cloudCoverage: 0.6 } },
    ],
  },

  blizzard: {
    id: 'blizzard',
    label: '吹雪',
    duration: 90,
    cloudType: 'stratus',
    keyframes: [
      { t: 0.0, w: { snowIntensity: 0, fogDensity: 0, cloudCoverage: 0.5 } },
      { t: 0.2, w: { snowIntensity: 0.6, fogDensity: 0.2, cloudCoverage: 0.85 } },
      { t: 0.55, w: { snowIntensity: 1.0, fogDensity: 0.4, cloudCoverage: 1.0 } },
      { t: 0.85, w: { snowIntensity: 0.5, fogDensity: 0.2, cloudCoverage: 0.8 } },
      { t: 1.0, w: { snowIntensity: 0, fogDensity: 0.05, cloudCoverage: 0.6 } },
    ],
  },
}

// leva の select 用 { ラベル: id }。'none' は手動モード
export const SCENARIO_OPTIONS = {
  'なし（手動）': 'none',
  ...Object.fromEntries(Object.values(SCENARIOS).map((s) => [s.label, s.id])),
}

function smoothstep01(x) {
  const t = Math.min(Math.max(x, 0), 1)
  return t * t * (3 - 2 * t)
}

// シナリオを時刻 t (0..1) でサンプリングして weather を返す。
// キーフレーム間は smoothstep 補間（数値フィールドのみ）
export function sampleScenario(scenario, t) {
  const frames = scenario.keyframes
  const clamped = Math.min(Math.max(t, 0), 1)

  let i = 0
  while (i < frames.length - 2 && clamped > frames[i + 1].t) i++
  const a = frames[i]
  const b = frames[Math.min(i + 1, frames.length - 1)]
  const span = Math.max(b.t - a.t, 1e-6)
  const s = smoothstep01((clamped - a.t) / span)

  const weather = { ...DEFAULT_WEATHER, cloudType: scenario.cloudType }
  const keys = new Set([...Object.keys(a.w), ...Object.keys(b.w)])
  for (const key of keys) {
    const va = a.w[key] ?? DEFAULT_WEATHER[key] ?? 0
    const vb = b.w[key] ?? DEFAULT_WEATHER[key] ?? 0
    weather[key] = va + (vb - va) * s
  }
  return weather
}
