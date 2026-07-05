import { Fn, clamp, float, int, min, mix, vec2, vec3 } from 'three/tsl'

/*
  DEM ハイトフィールドの共有サンプラ。

  TerrainLayer の heightInfo（heights storage buffer + 格子情報）から
  「worldXZ(vec2) → 高さ / 法線 / 正規化標高」の TSL Fn セットを作る。
  groundField.js（手続きマウンド版）と同じ { heightAt, normalAt } インター
  フェースを持ち、消費者は高さ源が DEM か手続き地形かを意識しない。

  消費者: GrassLayer の接地・生育マスク、runRainCompute の地形衝突、
  今後の雪・火の粉・延焼マスク等（plan.md R2）。

  等間隔格子前提のバイリニア補間。mercator / natural-earth 投影では
  近似になる（TerrainLayer 側の注記参照）。
*/

/**
 * @param {object} o
 * @param {Node}   o.node          heights の storage ノード（readOnly、cols*rows 要素）
 * @param {number} o.cols          DEM グリッド列数
 * @param {number} o.rows          DEM グリッド行数
 * @param {number} o.terrainWidth  投影後の X スパン（world units）
 * @param {number} o.terrainDepth  投影後の Z スパン（world units）
 * @param {number} o.minY          正規化標高 0 に対応するローカル Y
 * @param {number} o.rangeY        正規化標高 0..1 に対応するローカル Y レンジ
 */
export function createHeightFieldSampler({
  node,
  cols,
  rows,
  terrainWidth,
  terrainDepth,
  minY,
  rangeY,
}) {
  const halfW = terrainWidth / 2
  const halfD = terrainDepth / 2

  // バイリニア補間（旧 GrassLayer 実装を移設。旧 runRainCompute の最近傍より高精度）
  const heightAt = Fn(([worldXZ]) => {
    const fx = clamp(worldXZ.x.add(halfW).div(terrainWidth), 0, 1).mul(cols - 1)
    const fz = clamp(worldXZ.y.add(halfD).div(terrainDepth), 0, 1).mul(rows - 1)
    const x0 = int(fx) // 非負なので trunc = floor
    const z0 = int(fz)
    const x1 = min(x0.add(1), int(cols - 1))
    const z1 = min(z0.add(1), int(rows - 1))
    const tx = fx.sub(float(x0))
    const tz = fz.sub(float(z0))
    const h00 = node.element(z0.mul(int(cols)).add(x0))
    const h10 = node.element(z0.mul(int(cols)).add(x1))
    const h01 = node.element(z1.mul(int(cols)).add(x0))
    const h11 = node.element(z1.mul(int(cols)).add(x1))
    return mix(mix(h00, h10, tx), mix(h01, h11, tx), tz)
  })

  // 有限差分の解析法線（groundField.normalAt と同形）。差分幅はセル 1 個分
  const normalAt = Fn(([worldXZ]) => {
    const e = float(Math.max(terrainWidth / (cols - 1), 1e-4))
    const h0 = heightAt(worldXZ)
    const hx = heightAt(worldXZ.add(vec2(e, 0)))
    const hz = heightAt(worldXZ.add(vec2(0, e)))
    return vec3(h0.sub(hx).div(e), 1, h0.sub(hz).div(e)).normalize()
  })

  // 正規化標高 0..1（雪線・生育域・延焼マスク等の閾値判定に使う）
  const elevationAt = Fn(([worldXZ]) => {
    return heightAt(worldXZ).sub(minY).div(rangeY)
  })

  return { heightAt, normalAt, elevationAt }
}
