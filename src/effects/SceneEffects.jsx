
/*
  WebGPU ネイティブのポストプロセッシングパイプライン。

  RenderPipeline で scenePass を作成し、
  各エフェクト（createBloom, createTiltShift, createFilmGrade）を
  チェーンして合成する。

  個々のエフェクトのロジックは create*.js に分離。
*/
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { RenderPipeline } from 'three/webgpu'
import { pass, uniform } from 'three/tsl'

import { createBloomPass } from './createBloom'
import { createTiltShiftPass } from './createTiltShift'
import { createFilmGradePass, FILMGRADE_DEFAULTS } from './createFilmGrade'
// import { createGodraysPass } from './createGodrays'
// import { createDofPass } from './createDof'

function SceneEffects() {
  const { gl: renderer, scene, camera } = useThree()

  // フィルムグレードの調整（uniform 経由なのでスライダー操作で再構築は走らない）
  const film = useControls('フィルムグレード', {
    grain: { value: FILMGRADE_DEFAULTS.grain, min: 0, max: 0.2, step: 0.005, label: 'グレイン' },
    vignette: { value: FILMGRADE_DEFAULTS.vignette, min: 0, max: 1.5, step: 0.01, label: 'ビネット' },
    chroma: { value: FILMGRADE_DEFAULTS.chroma, min: 0, max: 0.01, step: 0.0002, label: '色収差' },
    contrast: { value: FILMGRADE_DEFAULTS.contrast, min: 0.7, max: 1.6, step: 0.01, label: 'コントラスト' },
    saturation: { value: FILMGRADE_DEFAULTS.saturation, min: 0, max: 2, step: 0.01, label: '彩度' },
  })

  const filmUniforms = useMemo(
    () => ({
      grain: uniform(FILMGRADE_DEFAULTS.grain),
      vignette: uniform(FILMGRADE_DEFAULTS.vignette),
      chroma: uniform(FILMGRADE_DEFAULTS.chroma),
      contrast: uniform(FILMGRADE_DEFAULTS.contrast),
      saturation: uniform(FILMGRADE_DEFAULTS.saturation),
    }),
    []
  )

  // leva → uniform（ref 安定なオブジェクトの .value 更新のみ）
  filmUniforms.grain.value = film.grain
  filmUniforms.vignette.value = film.vignette
  filmUniforms.chroma.value = film.chroma
  filmUniforms.contrast.value = film.contrast
  filmUniforms.saturation.value = film.saturation

  const pipeline = useMemo(() => {
    const rp = new RenderPipeline(renderer)

    const scenePass = pass(scene, camera)
    const scenePassColor = scenePass.getTextureNode()

    // Bloom: シーンカラーに加算
    let outputNode = scenePassColor.add(createBloomPass(scenePassColor))

    // Tilt-Shift: スクリーン Y バンドベースのミニチュア風ぼかし
    outputNode = createTiltShiftPass(outputNode)

    // Film Grade: 色収差 / コントラスト / 彩度 / ビネット / グレイン（最終段）
    outputNode = createFilmGradePass(outputNode, filmUniforms)

    // Godrays: 一時無効化
    // const scenePassDepth = scenePass.getTextureNode('depth')
    // outputNode = outputNode.add(createGodraysPass(scenePassDepth, camera, light))

    // DoF: 一時無効化
    // const viewZ = scenePass.getViewZNode()
    // outputNode = createDofPass(outputNode, viewZ)

    rp.outputNode = outputNode

    return { rp, scenePass }
  }, [renderer, scene, camera, filmUniforms])

  // レンダリング
  useFrame(() => {
    pipeline.rp.render()
  }, 1)

  // クリーンアップ
  useEffect(() => {
    return () => {
      pipeline.rp.dispose()
    }
  }, [pipeline])

  return null
}

export default SceneEffects
