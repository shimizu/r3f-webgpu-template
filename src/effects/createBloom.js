import { bloom } from 'three/addons/tsl/display/BloomNode.js'

// ============================================================
// 調整用パラメータ
// ============================================================
export const BLOOM_DEFAULTS = {
  strength: 0.8,          // ブルームの強さ
  radius: 0.5,            // ブルームの広がり
  threshold: 0.5,         // この輝度以上にブルームを適用
}

/**
 * Bloom エフェクトノードを生成する。
 * @param {Node} scenePassColor - シーンカラーテクスチャノード
 * @param {object} options - パラメータ（BLOOM_DEFAULTS 参照）
 * @returns {Node} bloom ノード（加算合成用）
 */
export function createBloomPass(scenePassColor, options = {}) {
  const {
    strength = BLOOM_DEFAULTS.strength,
    radius = BLOOM_DEFAULTS.radius,
    threshold = BLOOM_DEFAULTS.threshold,
  } = options

  return bloom(scenePassColor, strength, radius, threshold)
}
