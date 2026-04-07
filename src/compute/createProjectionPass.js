/*
  このファイルの処理の流れ

  1. createProjectionPass(rawObservationBuffer, options)
     CPU 側で用意した観測データと投影オプションを受け取り、
     WebGPU compute で使う Projection Pass を組み立てる。

  2. 入力バッファと出力バッファを用意する
     rawObservationBuffer を GPU から読める形にし、
     投影後の world position を書き込むためのバッファも別に作る。

  3. projection 用の uniform を作る
     centerLon / centerLat / worldScale など、
     view が変わったときに CPU から差し替える値をまとめる。

  4. Fn(() => { ... }).compute(...)
     各エンティティについて lon/lat を読み出し、
     view 中心からの差分をラジアンへ変換して world 座標へ投影する。

  5. init / updateProjection
     renderer.compute(...) を呼んで Projection Pass を実行する。
     updateProjection では uniform だけを更新し、同じ入力を別 view で再投影できる。

  6. destroy
     compute ノードを破棄して GPU リソースを片付ける。

  つまりこのファイルは、
  「観測データを GPU で読める形にする」
  「各観測点を地理座標から描画用 world 座標へ変換する」
  「その結果を描画レイヤーへ渡す」
  ための Projection Pass を担当している。
*/
import { StorageBufferAttribute } from 'three/webgpu'
import { Fn, instanceIndex, int, storage } from 'three/tsl'

import { projectLonLatGPU } from '../gis/projectionGPU'
import { createProjectionUniforms } from '../gis/projectionUniforms'
import { OBSERVATION_OFFSET, OBSERVATION_STRIDE } from './observationLayout'

const WORKGROUP_SIZE = 64

export function createProjectionPass(rawObservationBuffer, options = {}) {
  // compute shader は WebGPU が前提。
  // 非対応環境では、ここで明示的に止めて原因を分かりやすくする。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const entityCount = rawObservationBuffer.length / OBSERVATION_STRIDE
  const projUniforms = createProjectionUniforms(options)

  // rawObservationBuffer は CPU 側で作った Float32Array。
  // これを StorageBufferAttribute に包むと、GPU から読み取れるバッファとして扱える。
  const rawObservationAttribute = new StorageBufferAttribute(rawObservationBuffer, 1)
  const projectedPositionAttribute = new StorageBufferAttribute(
    new Float32Array(entityCount * 3),
    3
  )

  // storage(...) で TSL から参照する GPU バッファノードを作る。
  // rawObservationNode は入力、projectedPositionNode は出力という役割。
  const rawObservationNode = storage(
    rawObservationAttribute,
    'float',
    rawObservationBuffer.length
  ).toReadOnly()
  const projectedPositionNode = storage(
    projectedPositionAttribute,
    'vec3',
    entityCount
  )

  // Fn(() => { ... }) の中身が compute shader 本体になる。
  // entityCount 個の要素に対して、各スレッドが 1 エンティティずつ投影を担当する。
  const computeNode = Fn(() => {
    const projectedPosition = projectedPositionNode.element(instanceIndex)
    const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()
    const lon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lon)))
      .toVar()
    const lat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lat)))
      .toVar()

    projectedPosition.assign(projectLonLatGPU(lon, lat, projUniforms, projUniforms.projectionType))
  })().compute(entityCount, [WORKGROUP_SIZE])

  return {
    entityCount,
    positionAttribute: projectedPositionAttribute,
    positionNode: projectedPositionNode,

    init(renderer) {
      // 初回 1 回目の投影を実行して、描画前に位置バッファを埋める。
      renderer.compute(computeNode)
    },

    updateProjection(renderer, nextOptions = {}) {
      // uniform を差し替えてから再度 compute を走らせると、
      // 同じ観測データでも view だけ変えて再投影できる。
      projUniforms.update(nextOptions)
      renderer.compute(computeNode)
    },

    destroy() {
      // TSL の compute ノードも GPU リソースを持つので破棄しておく。
      computeNode.dispose()
    },
  }
}
