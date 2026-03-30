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
import { Fn, float, instanceIndex, int, select, storage, uniform, vec3 } from 'three/tsl'

import { resolveProjectionOptions } from '../gis/projectionOptions'
import { OBSERVATION_OFFSET, OBSERVATION_STRIDE } from './observationLayout'

const WORKGROUP_SIZE = 64
const DEG2RAD = Math.PI / 180
const PI = Math.PI
const TAU = Math.PI * 2

export function createProjectionPass(rawObservationBuffer, options = {}) {
  // compute shader は WebGPU が前提。
  // 非対応環境では、ここで明示的に止めて原因を分かりやすくする。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const projectionOptions = resolveProjectionOptions(options)
  const entityCount = rawObservationBuffer.length / OBSERVATION_STRIDE

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

  const centerLonNode = uniform(projectionOptions.centerLon)
  const centerLatNode = uniform(projectionOptions.centerLat)
  const worldScaleNode = uniform(projectionOptions.worldScale)
  const altitudeScaleNode = uniform(projectionOptions.altitudeScale)
  const cosCenterLatNode = uniform(
    Math.cos(projectionOptions.centerLat * DEG2RAD)
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

    // view の中心経度・緯度からの差分をラジアンへ変換する。
    // GIS の投影式は通常ラジアン前提なので、ここで度数法を変換している。
    const lambda = lon.sub(centerLonNode).mul(DEG2RAD).toVar()
    const phi = lat.sub(centerLatNode).mul(DEG2RAD).toVar()

    // 経度は 180 度境界で飛ぶので、-PI..PI に折り返して
    // 日付変更線付近でも近い側へ投影できるようにする。
    const wrappedPositive = select(
      lambda.greaterThan(float(PI)),
      lambda.sub(float(TAU)),
      lambda
    ).toVar()
    const wrappedLambda = select(
      wrappedPositive.lessThan(float(-PI)),
      wrappedPositive.add(float(TAU)),
      wrappedPositive
    ).toVar()

    // 初期段階は局所 equirectangular で十分。
    const worldX = wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode)
    const worldY = phi.mul(worldScaleNode)
    const worldZ = float(0)

    projectedPosition.assign(vec3(worldX, worldY, worldZ))
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
      if (typeof nextOptions.centerLon === 'number') {
        centerLonNode.value = nextOptions.centerLon
      }

      if (typeof nextOptions.centerLat === 'number') {
        centerLatNode.value = nextOptions.centerLat
        cosCenterLatNode.value = Math.cos(nextOptions.centerLat * DEG2RAD)
      }

      if (typeof nextOptions.worldScale === 'number') {
        worldScaleNode.value = nextOptions.worldScale
      }

      if (typeof nextOptions.altitudeScale === 'number') {
        altitudeScaleNode.value = nextOptions.altitudeScale
      }

      renderer.compute(computeNode)
    },

    destroy() {
      // TSL の compute ノードも GPU リソースを持つので破棄しておく。
      computeNode.dispose()
    },
  }
}
