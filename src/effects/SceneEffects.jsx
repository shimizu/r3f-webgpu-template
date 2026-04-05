/* eslint-disable react/no-unknown-property, react/prop-types */
/*
  WebGPU ネイティブのポストプロセッシングパイプライン。

  RenderPipeline で scenePass を作成し、
  各エフェクト（createBloom, createGodrays, createDof）を
  チェーンして合成する。

  個々のエフェクトのロジックは create*.js に分離。
*/
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { RenderPipeline } from 'three/webgpu'
import { pass } from 'three/tsl'

import { createBloomPass } from './createBloom'
// import { createGodraysPass } from './createGodrays'
// import { createDofPass } from './createDof'

function SceneEffects() {
  const { gl: renderer, scene, camera } = useThree()

  const pipeline = useMemo(() => {
    const rp = new RenderPipeline(renderer)

    const scenePass = pass(scene, camera)
    const scenePassColor = scenePass.getTextureNode()

    // Bloom: シーンカラーに加算
    let outputNode = scenePassColor.add(createBloomPass(scenePassColor))

    // Godrays: 一時無効化
    // const scenePassDepth = scenePass.getTextureNode('depth')
    // outputNode = outputNode.add(createGodraysPass(scenePassDepth, camera, light))

    // DoF: 一時無効化
    // const viewZ = scenePass.getViewZNode()
    // outputNode = createDofPass(outputNode, viewZ)

    rp.outputNode = outputNode

    return { rp, scenePass }
  }, [renderer, scene, camera])

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
