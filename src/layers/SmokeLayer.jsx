import { useEffect, useMemo } from 'react'
import { Vector2 } from 'three'
import { Fn, clamp, uniform } from 'three/tsl'

import CloudLayer from './CloudLayer'
import { createBurnField } from '../tsl/burnField'

/*
  山火事の煙レイヤー（plan.md D5-5c）。

  CloudLayer の 'smoke' プリセット（暗色・吸収強）を、burnField と同じ
  ignition / radius uniform で作った XZ ゲートで絞る薄いラッパー。
  燃焼前線（強）と焼け跡（くすぶり）からだけ煙が立ち上る。

  GPU 予算: 独自の raymarch を持つため、山火事中は通常雲の coverage を
  絞って合計 steps を予算内に収める（deriveLayerInputs 側で制御）。
*/

const SMOKE_DEFAULTS = {
  thickness: 3,
  steps: 8, // 通常雲 12 と合わせて予算内（山火事中は通常雲の coverage を絞る）
  coverage: 0.85,
  band: 0.5,
}

function SmokeLayer({
  position = [0, 2.2, 0],
  width = 24,
  depth = 15,
  thickness = SMOKE_DEFAULTS.thickness,
  ignition = null, // 発火点 [x, z]（TerrainLayer の burnField と同じ値）
  radius = 0, // 延焼半径（uniform 駆動）
  band = SMOKE_DEFAULTS.band,
  steps = SMOKE_DEFAULTS.steps,
  coverage = SMOKE_DEFAULTS.coverage,
}) {
  // burnField と同じ前線 uniform（生成一度きり、値は .value 更新）
  const fire = useMemo(
    () => ({
      ignition: uniform(new Vector2(0, 0)),
      radius: uniform(0),
      band: uniform(SMOKE_DEFAULTS.band),
      noiseScale: uniform(0.7),
      noiseAmount: uniform(0.5),
      seed: uniform(new Vector2(7.3, 2.9)),
    }),
    []
  )

  useEffect(() => {
    fire.radius.value = radius
    fire.band.value = band
    if (ignition) fire.ignition.value.set(ignition[0], ignition[1])
  }, [fire, radius, band, ignition])

  // XZ ゲート: 前線帯から濃く、焼け跡からはくすぶり程度に立ち上る。
  // 安定参照必須（CloudLayer のシェーダ再構築を避ける）
  const gateAt = useMemo(() => {
    const { burnAt } = createBurnField(fire)
    return Fn(([worldXZ]) => {
      const state = burnAt(worldXZ)
      return clamp(state.x.mul(0.45).add(state.y.mul(1.3)), 0, 1)
    })
  }, [fire])

  return (
    <CloudLayer
      type='smoke'
      quality='low'
      width={width}
      depth={depth}
      thickness={thickness}
      coverage={coverage}
      steps={steps}
      position={position}
      gateAt={gateAt}
    />
  )
}

export default SmokeLayer
