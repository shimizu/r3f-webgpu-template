import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { convertToTexture, float, mix, screenUV, smoothstep } from 'three/tsl'

// ============================================================
// 調整用パラメータ
// ============================================================
export const TILTSHIFT_DEFAULTS = {
  focusPosition: 0.5,     // ピント帯の中心 Y (UV 0..1)
  focusWidth: 0.5,       // シャープに保つ帯の高さ
  falloff: 0.15,          // 帯の外側でぼけきるまでの遷移幅
  blurStrength: 25,       // gaussianBlur の sigma (kernelSize ≈ 3 + 2*sigma)
}

/**
 * チルトシフト（ミニチュア風）エフェクトノードを生成する。
 * スクリーン Y 座標ベースで水平帯のみシャープに残し、上下をぼかす。
 * @param {Node} inputNode - 入力カラーノード（Bloom 等適用後でも可）
 * @param {object} options - パラメータ（TILTSHIFT_DEFAULTS 参照）
 * @returns {Node} tilt-shift 適用済みノード
 */
export function createTiltShiftPass(inputNode, options = {}) {
  const {
    focusPosition = TILTSHIFT_DEFAULTS.focusPosition,
    focusWidth = TILTSHIFT_DEFAULTS.focusWidth,
    falloff = TILTSHIFT_DEFAULTS.falloff,
    blurStrength = TILTSHIFT_DEFAULTS.blurStrength,
  } = options

  const sourceTexture = convertToTexture(inputNode)
  const blurred = gaussianBlur(sourceTexture, null, blurStrength)

  const halfW = float(focusWidth).mul(0.5)
  const distFromBand = screenUV.y.sub(float(focusPosition)).abs().sub(halfW).max(0)
  const mask = smoothstep(0, float(falloff), distFromBand)

  return mix(sourceTexture, blurred, mask)
}
