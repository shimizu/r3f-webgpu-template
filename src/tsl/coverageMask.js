import { Fn, float, vec3, clamp, mix, smoothstep, mx_fractal_noise_float } from 'three/tsl'

/**
 * カバレッジマスク共通イディオム（task.md T3）
 *
 * world XZ の fBM でパッチ状の被覆域を作る。草・苔・湿り・色ムラなど
 * 「どこに◯◯があるか」の全レイヤーで同じパラメータ 3 点セットを使う:
 *   - coverage: 0 = なし .. 1 = 全面
 *   - edge:     パッチ境界の柔らかさ
 *   - seed:     vec2。ランダマイズはパンするだけ（再生成不要）
 *
 * 閾値リマップ threshold = mix(1 + edge, -edge, coverage) が肝で、
 * coverage 0/1 の端でも smoothstep の幅が潰れずスライダー全域が滑らかに効く。
 */
export const coverageMask = /*@__PURE__*/ Fn(([worldXZ, scale, seed, coverage, edge]) => {
  // mx_fractal_noise はオクターブ合成で ±1 を超えうるので正規化後に clamp 必須
  const n = clamp(
    mx_fractal_noise_float(vec3(worldXZ.mul(scale).add(seed), 0), 5).mul(0.5).add(0.5),
    0,
    1
  )
  const threshold = mix(float(1).add(edge), edge.negate(), coverage)
  return smoothstep(threshold.sub(edge), threshold.add(edge), n)
})
