import { Fn, float, vec2, vec3, clamp, smoothstep, mx_fractal_noise_float } from 'three/tsl'

/**
 * 共有ハイトフィールド（task.md T4）
 *
 * 「worldXZ(vec2) → 高さ(float)」の単一関数を、地面の頂点変位・解析法線・
 * 草の接地など全消費者で共有するためのファクトリ。高さの真実の源を
 * 1 つにすることで、パラメータを動かしてもシルエット・陰影・配置が
 * 同時に追従する。
 *
 * ここでは手続き的なマウンド（fBM）版を提供する。DEM 版に差し替える場合も
 * 同じ { heightAt, normalAt } インターフェースを返すこと。
 *
 * @param {object} o
 * @param {number|Node} o.moundScale  マウンドの空間周波数（小さいほど広い起伏）
 * @param {number|Node} o.moundDepth  マウンドの高さ（world 単位）
 * @param {Node}        o.seed        vec2 ノイズシード（uniform 可。パンでランダマイズ）
 * @param {number}      o.rim         この半径でフィールド端を 0 に絞る（浮いた崖を作らない）
 */
export function createGroundField({ moundScale, moundDepth, seed, rim = 20 }) {
  const heightAt = Fn(([worldXZ]) => {
    const p = vec3(worldXZ.mul(moundScale).add(seed), 0)
    const base = clamp(mx_fractal_noise_float(p, 5).mul(0.5).add(0.5), 0, 1)
    // 減少側の smoothstep(edge0 > edge1) は仕様未定義なので oneMinus 形で書く
    const edge = smoothstep(float(rim * 0.8), float(rim), worldXZ.abs()).oneMinus()
    return base.mul(moundDepth).mul(edge.x).mul(edge.y)
  })

  // 有限差分の解析法線（fragment での陰影用）
  const normalAt = Fn(([worldXZ]) => {
    const e = float(0.08)
    const h0 = heightAt(worldXZ)
    const hx = heightAt(worldXZ.add(vec2(e, 0)))
    const hz = heightAt(worldXZ.add(vec2(0, e)))
    return vec3(h0.sub(hx).div(e), 1, h0.sub(hz).div(e)).normalize()
  })

  return { heightAt, normalAt }
}
