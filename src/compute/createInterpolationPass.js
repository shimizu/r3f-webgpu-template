/*
  このファイルの処理の流れ

  1. createInterpolationPass(rawObservationBuffer, options)
     現在値と 1 つ前の値を持つ観測バッファを受け取り、
     GPU 補間と GPU 投影をまとめて行う Pass を組み立てる。

  2. 入力バッファと出力バッファを用意する
     rawObservationBuffer から prevLon / prevLat / lon / lat / timestamp を読み、
     補間後の描画位置を書き込むバッファを作る。

  3. playback 用の uniform を作る
     loopDuration と playbackTime を CPU から受け取り、
     「観測区間の何割地点を表示するか」を GPU 側で決められるようにする。

  4. compute shader 内で補間してから投影する
     prev 値と current 値の間を blend で線形補間し、
     その補間結果を Projection Pass と同じ考え方で world 座標へ変換する。

  5. init / update
     初回と毎フレームで renderer.compute(...) を呼び、
     再生時刻や view に応じて補間済み位置を更新する。

  6. destroy
     compute ノードを破棄して GPU リソースを片付ける。

  つまりこのファイルは、
  「移動体の前回位置と現在位置のあいだを GPU で補間する」
  「補間結果をそのまま GPU で投影する」
  「CPU が個体ごとの毎フレーム座標更新を持たないようにする」
  ための中核 Pass を担当している。
*/
import { StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  clamp,
  float,
  instanceIndex,
  int,
  mix,
  storage,
  uniform,
} from 'three/tsl'

import { projectLonLatGPU } from '../gis/projectionGPU'
import { createProjectionUniforms } from '../gis/projectionUniforms'
import { OBSERVATION_OFFSET, OBSERVATION_STRIDE } from './observationLayout'

const WORKGROUP_SIZE = 64
const DEG2RAD = Math.PI / 180

export function createInterpolationPass(rawObservationBuffer, options = {}) {
  // 補間も compute shader で回すので、WebGPU 前提。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const entityCount = rawObservationBuffer.length / OBSERVATION_STRIDE
  const projUniforms = createProjectionUniforms(options)

  // 入力は「現在観測値と 1 つ前の観測値が一緒に入ったバッファ」。
  // 出力は「今この瞬間に描画すべき補間済み位置」。
  const rawObservationAttribute = new StorageBufferAttribute(rawObservationBuffer, 1)
  const projectedPositionAttribute = new StorageBufferAttribute(
    new Float32Array(entityCount * 3),
    3
  )
  const headingAttribute = new StorageBufferAttribute(
    new Float32Array(entityCount),
    1
  )

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
  const headingNode = storage(
    headingAttribute,
    'float',
    entityCount
  )

  const playbackTimeNode = uniform(0)
  const loopDurationNode = uniform(options.loopDuration ?? 12)

  // 毎フレームの compute で、前回観測値 -> 現在観測値の間を補間してから投影する。
  // これにより CPU が各個体の座標更新を持たなくても動きが出せる。
  const computeNode = Fn(() => {
    const projectedPosition = projectedPositionNode.element(instanceIndex)
    const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()

    const prevLon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevLon)))
      .toVar()
    const prevLat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevLat)))
      .toVar()
    const lon = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lon)))
      .toVar()
    const lat = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.lat)))
      .toVar()
    const prevTimestamp = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.prevTimestamp)))
      .toVar()
    const timestamp = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.timestamp)))
      .toVar()

    // playbackTime は 0..loopDuration の実時間。
    // それを観測 timestamp の区間へ写して、何割進んだかを blend にする。
    const normalizedPlayback = playbackTimeNode.div(loopDurationNode).toVar()
    const playbackTimestamp = mix(prevTimestamp, timestamp, normalizedPlayback).toVar()
    const timestampSpan = timestamp.sub(prevTimestamp).toVar()
    const blend = clamp(
      playbackTimestamp.sub(prevTimestamp).div(timestampSpan),
      float(0),
      float(1)
    ).toVar()

    const currentLon = mix(prevLon, lon, blend).toVar()
    const currentLat = mix(prevLat, lat, blend).toVar()
    const projected = projectLonLatGPU(currentLon, currentLat, projUniforms, projUniforms.projectionType).toVar()

    projectedPosition.assign(projected)

    // heading をバッファから読み取って出力する（度→ラジアン変換）
    const headingOut = headingNode.element(instanceIndex)
    const headingDeg = rawObservationNode
      .element(baseIndex.add(int(OBSERVATION_OFFSET.heading)))
      .toVar()
    headingOut.assign(headingDeg.mul(DEG2RAD))
  })().compute(entityCount, [WORKGROUP_SIZE])

  return {
    entityCount,
    positionAttribute: projectedPositionAttribute,
    positionNode: projectedPositionNode,
    headingAttribute,
    headingNode,

    init(renderer) {
      // 初回描画前に 1 回計算して、position バッファを空のまま使わないようにする。
      renderer.compute(computeNode)
    },

    update(renderer, playbackTime, nextOptions = {}) {
      // CPU 側は「今ループのどの時刻か」と view 変更だけを渡す。
      // 個体ごとの補間計算そのものは GPU 側に任せる。
      playbackTimeNode.value = playbackTime
      projUniforms.update(nextOptions)

      if (typeof nextOptions.loopDuration === 'number') {
        loopDurationNode.value = nextOptions.loopDuration
      }

      renderer.compute(computeNode)
    },

    destroy() {
      computeNode.dispose()
    },
  }
}
