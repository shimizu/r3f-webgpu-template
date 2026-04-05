/* eslint-disable react/no-unknown-property, react/prop-types */
/*
  WebGPU ネイティブのポストプロセッシングパイプライン。

  PostProcessing で ScenePass → Bloom を構築し、
  R3F のデフォルト描画を置き換える。
*/
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PostProcessing } from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'

// ============================================================
// 調整用パラメータ
// ============================================================
const BLOOM_DEFAULTS = {
  strength: 0.8,          // ブルームの強さ
  radius: 0.5,            // ブルームの広がり
  threshold: 0.5,         // この輝度以上にブルームを適用
}

function SceneEffects({
  bloomStrength = BLOOM_DEFAULTS.strength,
  bloomRadius = BLOOM_DEFAULTS.radius,
  bloomThreshold = BLOOM_DEFAULTS.threshold,
}) {
  const { gl: renderer, scene, camera } = useThree()

  const pipeline = useMemo(() => {
    const postProcessing = new PostProcessing(renderer)

    const scenePass = pass(scene, camera)
    const scenePassColor = scenePass.getTextureNode()

    const bloomPass = bloom(scenePassColor, bloomStrength, bloomRadius, bloomThreshold)

    // シーンカラー + ブルーム で加算合成
    postProcessing.outputNode = scenePassColor.add(bloomPass)

    return { postProcessing, scenePass }
  }, [renderer, scene, camera])

  // レンダリング
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
