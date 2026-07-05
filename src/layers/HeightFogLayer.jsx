import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Color } from 'three'
import { fog, uniform } from 'three/tsl'

import { createHeightFogFactor } from '../tsl/heightFog'

/*
  高さフォグレイヤー（plan.md D1）。

  scene.fogNode に距離 + 高さの指数フォグを設定する非描画レイヤー。
  マウントしっぱなしで density を uniform 駆動する運用にすること
  （条件マウントにすると全マテリアルの再コンパイルがトグルごとに走る。
  density=0 なら見た目・負荷とも実質ゼロ）。

  空・雲など自前の大気表現を持つレイヤーは material.fog = false で除外する。
*/

// density prop (0..1) → 実際の指数フォグ係数への変換。
// 1.0 で距離 20 units の透過率が 2 割程度になる濃さ
const FOG_DENSITY_SCALE = 0.08

function HeightFogLayer({
  density = 0, // 0..1（0 = 無効）
  fogColor = '#c8cdd3', // 雨天の灰白
  falloff = 0.35, // 高さ減衰（大きいほど地表に張り付く）
  baseY = 0.5, // 基準高さ（海面レベル）
}) {
  const scene = useThree((state) => state.scene)

  const uniforms = useMemo(
    () => ({
      density: uniform(0),
      color: uniform(new Color('#c8cdd3')),
    }),
    []
  )

  const fogNode = useMemo(
    () =>
      fog(
        uniforms.color,
        createHeightFogFactor({ density: uniforms.density, falloff, baseY })
      ),
    [uniforms, falloff, baseY]
  )

  useEffect(() => {
    uniforms.density.value = density * FOG_DENSITY_SCALE
    uniforms.color.value.set(fogColor)
  }, [uniforms, density, fogColor])

  useEffect(() => {
    scene.fogNode = fogNode
    return () => {
      if (scene.fogNode === fogNode) scene.fogNode = null
    }
  }, [scene, fogNode])

  return null
}

export default HeightFogLayer
