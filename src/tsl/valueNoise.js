import { Fn, float, floor, fract, mat3, mix, vec3 } from 'three/tsl'

/**
 * hash ベースの 3D value noise（軽量ノイズ）。
 *
 * MaterialX 系（mx_fractal_noise = Perlin 勾配ノイズ、mx_worley = 27 セル走査）の
 * 数分の一の ALU で評価できる。雲の「軽量品質モード」など、サンプル単価を
 * 下げたい raymarch 用途向け。品質は Perlin より低い（勾配がなく、やや
 * ブロック感のある補間）ので、単価より見た目を優先する場面では mx_* を使う。
 *
 * 参照: referencejs/GrassSystemThreeJS clouds.js の vnoise3/fbm3 の TSL 移植
 * （アルゴリズムは task.md に固定化済み）。
 */

// 3D → 1D の安価なハッシュ（0..1）
export const hash13 = /*@__PURE__*/ Fn(([p3]) => {
  const p = fract(p3.mul(0.3183099).add(0.1)).mul(17).toVar()
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)))
})

// 3D value noise（0..1）。格子 8 頂点のハッシュをトライリニア補間
export const valueNoise3 = /*@__PURE__*/ Fn(([x]) => {
  const i = floor(x).toVar()
  const f = fract(x).toVar()
  const u = f.mul(f).mul(float(3).sub(f.mul(2))).toVar() // smoothstep フェード
  return mix(
    mix(
      mix(hash13(i), hash13(i.add(vec3(1, 0, 0))), u.x),
      mix(hash13(i.add(vec3(0, 1, 0))), hash13(i.add(vec3(1, 1, 0))), u.x),
      u.y
    ),
    mix(
      mix(hash13(i.add(vec3(0, 0, 1))), hash13(i.add(vec3(1, 0, 1))), u.x),
      mix(hash13(i.add(vec3(0, 1, 1))), hash13(i.add(vec3(1, 1, 1))), u.x),
      u.y
    ),
    u.z
  )
})

// オクターブ間の回転行列（軸整列アーティファクトを散らす）
const ROT = /*@__PURE__*/ mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64)

/**
 * value noise の fBm（およそ 0..1）。
 * octaves は JS 定数なのでループは JS 側で展開する（TSL Loop 不要）。
 */
export function valueFbm3(p, octaves = 4) {
  let v = float(0)
  let amp = 0.5
  let q = p
  for (let i = 0; i < octaves; i += 1) {
    v = v.add(valueNoise3(q).mul(amp))
    q = ROT.mul(q).mul(2.02)
    amp *= 0.5
  }
  return v
}
