/* eslint-disable react/no-unknown-property, react/prop-types */
/*
  WebGPU ネイティブのポストプロセッシングパイプライン。

  PostProcessing で ScenePass → DoF を構築し、
  R3F のデフォルト描画を置き換える。
  将来 Bloom 等を追加する際もここに集約する。
*/
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PostProcessing } from 'three/webgpu'
import { pass } from 'three/tsl'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'

// ============================================================
// 調整用パラメータ
// ============================================================
const DOF_DEFAULTS = {
  focusDistance: 15,    // ピント距離（ワールド単位）
  focalLength: 10,     // ボケが始まるまでの距離幅
  bokehScale: 1.0,     // ボケの強さ
}

function SceneEffects({
  focusDistance = DOF_DEFAULTS.focusDistance,
  focalLength = DOF_DEFAULTS.focalLength,
  bokehScale = DOF_DEFAULTS.bokehScale,
}) {
  const { gl: renderer, scene, camera } = useThree()

  const pipeline = useMemo(() => {
    const postProcessing = new PostProcessing(renderer)

    const scenePass = pass(scene, camera)
    const scenePassColor = scenePass.getTextureNode()
    const viewZ = scenePass.getViewZNode()

    const dofPass = dof(scenePassColor, viewZ, focusDistance, focalLength, bokehScale)

    postProcessing.outputNode = dofPass

    return { postProcessing, scenePass }
  }, [renderer, scene, camera])

  // レンダリング: PostProcessing で描画
  useFrame(() => {
    pipeline.postProcessing.render()
  }, 1)

  // クリーンアップ
  useEffect(() => {
    return () => {
      pipeline.postProcessing.dispose()
    }
  }, [pipeline])

  return null
}

export default SceneEffects
