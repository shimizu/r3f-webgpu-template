import { Fn, exp, length, smoothstep, vec2, vec3 } from 'three/tsl'

import { valueFbm3 } from './valueNoise'

/*
  延焼マスク（plan.md D5-5a、解析近似版）。

  「worldXZ → 燃焼状態」を発火点からの距離場で近似する:
    edge = |worldXZ - ignition| + fBM 凸凹 - radius
    burnt   = 前線より内側（焼け跡）
    burning = 前線帯（燃焼中。ガウシアンリング）

  radius（延焼半径）を CPU 側で進めるだけで延焼が動く。compute 不要で
  uniform 駆動のみ（再コンパイルなし）。

  将来 256² ping-pong CA（風向異方性・上り坂加速）に差し替える場合も、
  この「worldXZ → vec2(burnt, burning)」インターフェースを維持すること。
  消費者: TerrainLayer（焦げ albedo + 前線 emissive）、
  炎/火の粉のスポーン域（5b）、煙の XZ ゲート（5c）。

  @param {object} o
  @param {Node} o.ignition    発火点 vec2 uniform（world XZ）
  @param {Node} o.radius      延焼半径 uniform（world units。0 で無効）
  @param {Node} o.band        前線帯の幅 uniform
  @param {Node} o.noiseScale  前線凸凹の空間周波数 uniform
  @param {Node} o.noiseAmount 前線凸凹の振幅 uniform（world units）
  @param {Node} o.seed        ノイズシード vec2 uniform
  @returns {{ burnAt: Fn }} burnAt([worldXZ]) → vec2(burnt 0..1, burning 0..1)
*/
export function createBurnField({ ignition, radius, band, noiseScale, noiseAmount, seed }) {
  const burnAt = Fn(([worldXZ]) => {
    const rel = worldXZ.sub(ignition)
    // 前線を fBM で凸凹にする（同じ worldXZ なら時間不変 = 焼け跡が安定）
    const wobble = valueFbm3(
      vec3(worldXZ.mul(noiseScale).add(seed), 3.7),
      3
    ).sub(0.5).mul(noiseAmount)
    const edge = length(rel).add(wobble).sub(radius)

    // 内側で 1 に飽和する焼け跡（前線から band かけて遷移）
    const burnt = smoothstep(0, 1, edge.div(band)).oneMinus()
    // 前線帯: edge=0 を中心にしたガウシアンリング
    const burning = exp(edge.div(band).pow(2).negate())
    // radius ≈ 0（未発火）では発火点近傍の burning を抑止する
    const armed = smoothstep(0.0, 0.05, radius)

    return vec2(burnt.mul(armed), burning.mul(armed))
  })

  return { burnAt }
}
