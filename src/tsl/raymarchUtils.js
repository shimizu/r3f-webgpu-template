import { Fn, clamp, float, max, min, vec2, vec3 } from 'three/tsl'

/*
  raymarch 系レイヤーの共有部品。

  CloudLayer（体積雲）から切り出したもので、煙・漏斗雲・砂嵐など
  今後の体積表現レイヤーで再利用する。挙動は CloudLayer 内実装と同一。
*/

// 単位ボックス (-0.5..0.5) とレイの交差区間 [t0, t1] を返す
// （three/examples/jsm/tsl/utils/Raymarching.js の hitBox と同一）
export const hitBox = /*@__PURE__*/ Fn(({ orig, dir }) => {
  const boxMin = vec3(-0.5)
  const boxMax = vec3(0.5)

  const invDir = dir.reciprocal()

  const tminTmp = boxMin.sub(orig).mul(invDir)
  const tmaxTmp = boxMax.sub(orig).mul(invDir)

  const tmin = min(tminTmp, tmaxTmp)
  const tmax = max(tminTmp, tmaxTmp)

  const t0 = max(tmin.x, max(tmin.y, tmin.z))
  const t1 = min(tmax.x, min(tmax.y, tmax.z))

  return vec2(t0, t1)
})

// x を [low, high] → [0, 1] へ再マップして clamp（密度の侵食などに使う）
export const remapClamped = /*@__PURE__*/ Fn(([x, low, high]) => {
  return clamp(x.sub(low).div(max(high.sub(low), 1e-4)), 0, 1)
})

// Henyey-Greenstein 位相関数。g は JS 数値なので係数を前計算する
export function hgPhase(cosTheta, g) {
  const g2 = g * g
  return float((1 - g2) / (4 * Math.PI))
    .div(cosTheta.mul(-2 * g).add(1 + g2).pow(1.5))
}
