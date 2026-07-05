import { StorageBufferAttribute } from 'three/webgpu'
import { storage } from 'three/tsl'

import { disposeStorageAttributes } from './disposeStorageAttributes'

/*
  パーティクル用 StorageBuffer 群の生成/破棄の定型（plan.md R4）。

  runXxxCompute（雨・雪・火の粉など）が共通で必要とする
  「フィールド定義 → StorageBufferAttribute + storage ノード生成 → まとめて解放」
  をまとめる。update Fn の中身は災害ごとに本質的に異なるため抽象化しない
  （runRainCompute をテンプレートにコピーベースで派生させる）。

  fields の各値は以下のいずれか:
  - number                     … itemSize。ゼロ初期化の Float32Array を確保
  - { itemSize, data }         … CPU で初期化済みの Float32Array を使う

  例:
    const buffers = createParticleBuffers(count, {
      pos: { itemSize: 3, data: initialPositions },
      vel: { itemSize: 3, data: initialVelocities },
      life: 1,
    })
    buffers.nodes.pos.element(instanceIndex) // compute / vertex から参照
    buffers.dispose(renderer)                // destroy 時にまとめて解放
*/

const TYPE_BY_ITEM_SIZE = { 1: 'float', 2: 'vec2', 3: 'vec3', 4: 'vec4' }

export function createParticleBuffers(count, fields) {
  const attributes = {}
  const nodes = {}

  for (const [name, spec] of Object.entries(fields)) {
    const itemSize = typeof spec === 'number' ? spec : spec.itemSize
    const type = TYPE_BY_ITEM_SIZE[itemSize]
    if (!type) throw new Error(`particleBuffers: 未対応の itemSize ${itemSize} (${name})`)
    const data =
      typeof spec === 'number' ? new Float32Array(count * itemSize) : spec.data
    const attribute = new StorageBufferAttribute(data, itemSize)
    attributes[name] = attribute
    nodes[name] = storage(attribute, type, count)
  }

  return {
    attributes,
    nodes,
    // standalone な StorageBufferAttribute はジオメトリ非経由なので明示解放が必要
    dispose(renderer) {
      disposeStorageAttributes(renderer, Object.values(attributes))
    },
  }
}
