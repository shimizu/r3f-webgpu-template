import {
  Fn,
  convertToTexture,
  dot,
  float,
  hash,
  length,
  mix,
  screenUV,
  smoothstep,
  time,
  vec3,
} from 'three/tsl'

// ============================================================
// 調整用パラメータ
// ============================================================
export const FILMGRADE_DEFAULTS = {
  chroma: 0.002, // 放射状の色収差（0 = なし）
  contrast: 1.05, // 中間グレー 0.5 を軸にしたコントラスト
  saturation: 1.1, // 彩度（1 = 変化なし）
  vignette: 0.35, // 周辺減光の強さ
  vignetteSize: 0.5, // 減光が始まる中心からの半径（大きいほど明るい領域が広い）
  grain: 0.04, // フィルム粒状ノイズの量
}

// number でも uniform ノードでも受けられるようにするヘルパー
const asNode = (v) => (v && v.isNode ? v : float(v))

/**
 * フィルムグレード（最終仕上げ）ノードを生成する。
 * 表示段で 色収差 → コントラスト/彩度 → ビネット → グレイン を一括適用し、
 * CG のクリーンな出力に「フィルム撮影」感を足す。パイプラインの最終段に置く。
 *
 * 注: 当プロジェクトの RenderPipeline はトーンマップを出力時に適用するため、
 * このパスは厳密には表示前（working space）で走る。既存の Bloom / Tilt-Shift と
 * 同じノード空間なので整合しており、各パラメータは knob として機能する。
 *
 * @param {Node} inputNode - 入力カラーノード（Bloom / Tilt-Shift 適用後）
 * @param {object} options - パラメータ（FILMGRADE_DEFAULTS 参照。number / uniform ノード可）
 * @returns {Node} フィルムグレード適用済みノード
 */
export function createFilmGradePass(inputNode, options = {}) {
  const chroma = asNode(options.chroma ?? FILMGRADE_DEFAULTS.chroma)
  const contrast = asNode(options.contrast ?? FILMGRADE_DEFAULTS.contrast)
  const saturation = asNode(options.saturation ?? FILMGRADE_DEFAULTS.saturation)
  const vignette = asNode(options.vignette ?? FILMGRADE_DEFAULTS.vignette)
  const vignetteSize = asNode(options.vignetteSize ?? FILMGRADE_DEFAULTS.vignetteSize)
  const grain = asNode(options.grain ?? FILMGRADE_DEFAULTS.grain)

  // 色収差はオフセット UV で再サンプルするのでテクスチャ化しておく
  const tex = convertToTexture(inputNode)

  return Fn(() => {
    const dir = screenUV.sub(0.5).toVar()

    // 放射状の色収差 — 中心はシャープ、端ほど RGB がずれる
    const ca = chroma.mul(dot(dir, dir)).mul(4)
    const col = vec3(
      tex.sample(screenUV.sub(dir.mul(ca))).r,
      tex.sample(screenUV).g,
      tex.sample(screenUV.add(dir.mul(ca))).b
    ).toVar()

    // コントラスト（中間 0.5 を軸に）
    col.assign(col.sub(0.5).mul(contrast).add(0.5))

    // 彩度（輝度との mix）
    const luma = dot(col, vec3(0.299, 0.587, 0.114))
    col.assign(mix(vec3(luma), col, saturation))

    // ビネット（中心から離れるほど暗く。length(dir) は四隅で約 0.707）
    const vig = smoothstep(vignetteSize, float(0.9), length(dir))
    col.mulAssign(float(1).sub(vig.mul(vignette)))

    // アニメーショングレイン（time.fract() で精度劣化を防ぎつつ毎フレーム変化）
    const seed = screenUV.x.mul(1000).add(screenUV.y.mul(913.719)).add(time.fract())
    col.addAssign(hash(seed).sub(0.5).mul(grain))

    return col
  })()
}
