import { exp, positionView, positionWorld } from 'three/tsl'

/*
  距離 + 高さの指数フォグ（plan.md D1: 豪雨の視程低下）。

  postfx（SceneEffects）に依存せず scene.fogNode で機能する。
  ジオラマ向けに「低いところほど濃く、上空ほど薄い」高さ減衰を持たせ、
  薄めに使うと tilt-shift 的なミニチュア感とも相性が良い。

  fogFactor = 1 - exp(-density · exp(-falloff·(y - baseY)) · dist)

  - density: uniform 推奨（0 で無効。leva から再コンパイルなしで駆動）
  - falloff: 高さ減衰係数（大きいほど地表付近に張り付く）
  - baseY:   フォグの基準高さ（ステージ床〜海面あたり）
*/
export function createHeightFogFactor({ density, falloff = 0.35, baseY = 0 }) {
  const dist = positionView.length()
  const h = positionWorld.y.sub(baseY).max(0)
  const localDensity = density.mul(exp(h.mul(-falloff)))
  return localDensity.mul(dist).negate().exp().oneMinus().clamp(0, 1)
}
