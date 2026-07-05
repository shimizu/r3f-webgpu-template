import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { StorageBufferAttribute } from 'three/webgpu'
import { storage } from 'three/tsl'

import { createHeightFieldSampler } from '../tsl/sampleHeightField'
import { disposeStorageAttributes } from '../compute/disposeStorageAttributes'

/*
  地形ハイトフィールドの共有コンテキスト（plan.md R2）。

  TerrainLayer が onHeightData で発行する heightInfo を一元保持し、
  GPU リソース（heights の StorageBufferAttribute）をここで 1 個だけ生成して
  全消費者（草・雨・今後の雪/火の粉/延焼マスク等）に配布する。
  消費者ごとに DEM の GPU コピーが増えるのを防ぎ、prop drilling を解消する。

  - TerrainLayer 自体はコンテキスト非依存のまま（onHeightData prop を維持）。
    Scene 側で setHeightInfo を渡して接続する
  - value.gpu は { attribute, node, sampler }。sampler は
    createHeightFieldSampler の { heightAt, normalAt, elevationAt }
  - heightInfo 差し替え・アンマウント時に旧バッファを disposeStorageAttributes
    で解放する（standalone storage はジオメトリ非経由なので明示解放が必要）
*/

const HeightFieldContext = createContext(null)

export function HeightFieldProvider({ children }) {
  const renderer = useThree((state) => state.gl)
  const [heightInfo, setHeightInfo] = useState(null)

  const gpu = useMemo(() => {
    if (!heightInfo) return null
    const attribute = new StorageBufferAttribute(heightInfo.heights, 1)
    const node = storage(attribute, 'float', heightInfo.cols * heightInfo.rows).toReadOnly()
    const sampler = createHeightFieldSampler({ node, ...heightInfo })
    return { attribute, node, sampler }
  }, [heightInfo])

  useEffect(() => {
    if (!gpu) return undefined
    return () => disposeStorageAttributes(renderer, [gpu.attribute])
  }, [gpu, renderer])

  const value = useMemo(
    () => ({ heightInfo, gpu, setHeightInfo }),
    [heightInfo, gpu]
  )

  return <HeightFieldContext.Provider value={value}>{children}</HeightFieldContext.Provider>
}

const EMPTY = { heightInfo: null, gpu: null, setHeightInfo: () => {} }

// Provider 外では空値を返す（レイヤーを単体マウントしても壊れない）
export function useHeightField() {
  return useContext(HeightFieldContext) ?? EMPTY
}
