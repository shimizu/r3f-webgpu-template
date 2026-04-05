import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'

// ============================================================
// 調整用パラメータ
// ============================================================
export const DOF_DEFAULTS = {
  focusDistance: 15,       // ピント距離（ワールド単位）
  focalLength: 10,         // ボケが始まるまでの距離幅
  bokehScale: 1.0,         // ボケの強さ
}

/**
 * DoF（被写界深度）エフェクトノードを生成する。
 * @param {Node} inputNode - 入力カラーノード（Bloom 等適用後でも可）
 * @param {Node} viewZ - ビュー空間深度ノード（scenePass.getViewZNode()）
 * @param {object} options - パラメータ（DOF_DEFAULTS 参照）
 * @returns {Node} dof ノード
 */
export function createDofPass(inputNode, viewZ, options = {}) {
  const {
    focusDistance = DOF_DEFAULTS.focusDistance,
    focalLength = DOF_DEFAULTS.focalLength,
    bokehScale = DOF_DEFAULTS.bokehScale,
  } = options

  return dof(inputNode, viewZ, focusDistance, focalLength, bokehScale)
}
