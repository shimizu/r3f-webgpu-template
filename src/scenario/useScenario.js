import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useControls } from 'leva'

import { SCENARIOS, SCENARIO_OPTIONS, sampleScenario } from './scenarios'

/*
  シナリオ再生フック（plan.md Phase 3 最小版）。

  leva「シナリオ」フォルダ（選択 / 再生 / 進行スクラブ）を持ち、
  再生中は useFrame で時刻を進めてキーフレームを補間した weather を返す。
  シナリオ未選択（none）では null を返し、Scene は手動（天候フォルダ）に
  フォールバックする。

  更新スロットリング:
  weather は React state なので毎フレーム更新すると全レイヤーが毎フレーム
  再レンダーされる。UPDATE_INTERVAL 秒ごとに間引いて更新する
  （濡れ・堆積は TerrainLayer 側の時定数追従が滑らかにするので段差は見えない）
*/

const UPDATE_INTERVAL = 0.25 // 秒。weather state と進行スライダーの更新間隔

export function useScenario() {
  const [{ scenarioId, playing, progress, speed }, set] = useControls('シナリオ', () => ({
    scenarioId: { value: 'none', options: SCENARIO_OPTIONS, label: 'シナリオ' },
    playing: { value: false, label: '再生' },
    progress: { value: 0, min: 0, max: 1, step: 0.001, label: '進行' },
    speed: { value: 1, min: 0.25, max: 8, step: 0.25, label: '再生速度' },
  }))

  const [weather, setWeather] = useState(null)
  const tRef = useRef(0)
  const accRef = useRef(0)
  const lastKeyRef = useRef('')

  // スクラブ（手動操作）と再生ループの set() を同じ経路で同期する
  useEffect(() => {
    tRef.current = progress
  }, [progress])

  // シナリオ切替時は先頭に巻き戻す
  useEffect(() => {
    tRef.current = 0
    accRef.current = 0
    lastKeyRef.current = ''
    set({ progress: 0 })
    if (scenarioId === 'none') setWeather(null)
  }, [scenarioId, set])

  useFrame((_, delta) => {
    const scenario = SCENARIOS[scenarioId]
    if (!scenario) return

    if (playing) {
      // 再生速度は倍率（duration は基準値として温存）。scenarios.js は非破壊
      tRef.current = Math.min(1, tRef.current + (delta * speed) / scenario.duration)
      if (tRef.current >= 1) set({ playing: false }) // 終端で自動停止
    }

    // スロットリング更新（再生中でなくてもスクラブ反映のため回す）
    accRef.current += delta
    if (accRef.current < UPDATE_INTERVAL) return
    accRef.current = 0

    const key = `${scenarioId}:${tRef.current.toFixed(3)}`
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key

    if (playing) set({ progress: tRef.current })
    setWeather(sampleScenario(scenario, tRef.current))
  })

  return weather // null = 手動モード
}
