import { godrays } from 'three/addons/tsl/display/GodraysNode.js'

// ============================================================
// 調整用パラメータ
// ============================================================
export const GODRAYS_DEFAULTS = {
  strength: 1.0,          // godrays の合成強度
}

/**
 * Godrays エフェクトノードを生成する。
 * ライトは castShadow が有効な DirectionalLight または PointLight が必要。
 * @param {Node} scenePassDepth - 深度テクスチャノード
 * @param {Camera} camera - シーンのカメラ
 * @param {Light} light - castShadow が有効なライト
 * @param {object} options - パラメータ（GODRAYS_DEFAULTS 参照）
 * @returns {Node} godrays ノード（加算合成用、strength 適用済み）
 */
export function createGodraysPass(scenePassDepth, camera, light, options = {}) {
  const {
    strength = GODRAYS_DEFAULTS.strength,
  } = options

  return godrays(scenePassDepth, camera, light).mul(strength)
}
