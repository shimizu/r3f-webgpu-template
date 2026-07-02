/*
  StorageBufferAttribute の GPU バッファを明示的に解放するヘルパー。

  three r183 の WebGPURenderer が自動解放するのは geometry 経由の attribute のみ
  （Geometries.js が geometry dispose 時に attributes.delete() を呼ぶ）。
  compute パス専用の standalone な StorageBufferAttribute には解放経路がなく、
  renderer 内部の Attributes 管理（renderer._attributes）に削除を依頼すると
  backend.destroyAttribute() → GPUBuffer.destroy() まで届く。

  renderer._attributes は private API のため、存在チェック付きで呼び、
  無ければ何もしない（WeakMap 管理なので GC 任せのフォールバックになる）。
*/
export function disposeStorageAttributes(renderer, attributes) {
  const attributeManager = renderer?._attributes
  if (!attributeManager || typeof attributeManager.delete !== 'function') return

  for (const attribute of attributes) {
    if (attribute) attributeManager.delete(attribute)
  }
}
