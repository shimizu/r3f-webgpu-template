import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { DataTexture, NearestFilter, NoColorSpace, RedFormat, UnsignedByteType } from 'three/webgpu'

import { loadLandCover, createClassAtWorld, createWorldToLonLat, LC_CLASS_COUNT } from './landcover'

/*
  土地被覆（Dynamic World）の共有コンテキスト。HeightFieldContext と同型。

  region.landcoverUrl を Provider 自身が読み込み、CPU 生データと GPU リソース
  （DataTexture）をここで 1 個だけ生成して全消費者（地形配色・草木の散布
  rejection・今後の建物配置）に配布する。

  - url なし（hormuz/taiwan 等）は status:'idle' のまま何もロードせず、
    消費者は既存分岐（標高 stops 配色 / 無条件散布）を通る = 挙動・コスト変化ゼロ
  - DataTexture はカテゴリカル値なので NearestFilter + mipmap なし。
    行を反転してアップロードし「v=1 が北」（TerrainLayer の topUvs 規約
    [col/(cols-1), 1-row/(rows-1)] と同じ）に揃える
  - classAtWorld は world XZ → クラス値の CPU nearest サンプラ
    （equirectangular 専用。landcover.js 参照）
  - texture 差し替え・アンマウント時に dispose は Provider が担う
*/

const LandCoverContext = createContext(null)

export function LandCoverProvider({ url = null, view = null, children }) {
  const [state, setState] = useState({ status: 'idle', info: null })

  useEffect(() => {
    if (!url) {
      setState({ status: 'idle', info: null })
      return undefined
    }
    let ignore = false
    setState({ status: 'loading', info: null })
    loadLandCover(url)
      .then((info) => {
        if (ignore) return
        if (import.meta.env.DEV) debugHistogram(url, info)
        setState({ status: 'ready', info })
      })
      .catch((error) => {
        console.error('土地被覆データの読み込みに失敗しました:', error)
        // 失敗時は idle に戻し、土地被覆なしの従来動作で続行する
        if (!ignore) setState({ status: 'idle', info: null })
      })
    return () => {
      ignore = true
    }
  }, [url])

  // DataTexture（R8・nearest・行反転済み）。生成は info 差し替え時のみ
  const texture = useMemo(() => {
    const info = state.info
    if (!info) return null
    const { data, width, height } = info
    // geotiff は行 0 = 北。DataTexture は v=0 が先頭行なので行反転して v=1 を北にする
    const flipped = new Uint8Array(data.length)
    for (let row = 0; row < height; row += 1) {
      flipped.set(data.subarray(row * width, (row + 1) * width), (height - 1 - row) * width)
    }
    const tex = new DataTexture(flipped, width, height, RedFormat, UnsignedByteType)
    tex.magFilter = NearestFilter
    tex.minFilter = NearestFilter
    tex.generateMipmaps = false
    tex.colorSpace = NoColorSpace
    tex.needsUpdate = true
    return tex
  }, [state.info])

  useEffect(() => {
    if (!texture) return undefined
    return () => texture.dispose()
  }, [texture])

  const value = useMemo(() => {
    const info = state.info
    return {
      status: state.status,
      info,
      texture,
      classAtWorld: info && view ? createClassAtWorld(info, view) : null,
      worldToLonLat: view ? createWorldToLonLat(view) : null,
    }
  }, [state, texture, view])

  return <LandCoverContext.Provider value={value}>{children}</LandCoverContext.Provider>
}

// 開発時のみ: クラスヒストグラムを出して既知の分布と照合できるようにする
function debugHistogram(url, { data, width, height }) {
  const counts = new Array(LC_CLASS_COUNT).fill(0)
  for (let i = 0; i < data.length; i += 1) counts[data[i]] += 1
  const pct = counts.map((c, i) => `${i}: ${((100 * c) / data.length).toFixed(1)}%`)
  console.debug(`landcover ${url} (${width}x${height})`, pct.join('  '))
}

const EMPTY = { status: 'idle', info: null, texture: null, classAtWorld: null, worldToLonLat: null }

// Provider 外では空値を返す（レイヤーを単体マウントしても壊れない）
export function useLandCover() {
  return useContext(LandCoverContext) ?? EMPTY
}
