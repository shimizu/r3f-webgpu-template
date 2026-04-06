import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Float32BufferAttribute, SRGBColorSpace, TextureLoader, Uint32BufferAttribute } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  attribute,
  color,
  float,
  mix,
  smoothstep,
  texture,
  uv,
} from 'three/tsl'
import { fromArrayBuffer } from 'geotiff'

const DEFAULT_SCALE = [16, 4, 16] // [幅, 標高レンジ, 奥行]
const MAX_DEM_SIZE = 512          // これを超える場合は縮小読み込み

const DEFAULT_COLORS = {
  deepOcean: '#0a1a3a',
  shallowOcean: '#1a6a8a',
  shore: '#c2b280',
  lowland: '#4a8a3a',
  highland: '#2a5a1a',
  mountain: '#8a7a6a',
  peak: '#f0f0f0',
  side: '#3a2a1a',
}

function createTerrainMaterial(colors, texMap, seaLevel = 0) {
  const material = new MeshPhysicalNodeMaterial({
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false,
  })

  const sideMask = attribute('aSideMask', 'float')
  const sideColor = color(colors.side)

  if (texMap) {
    const texNode = texture(texMap)
    const texColor = texNode.sample(uv())
    material.colorNode = mix(texColor, sideColor, sideMask)
  } else {
    const elevation = attribute('aElevation', 'float')

    const s = float(seaLevel)
    const c1 = mix(color(colors.deepOcean), color(colors.shallowOcean),
      smoothstep(float(0.0).add(s), float(0.3).add(s), elevation))
    const c2 = mix(c1, color(colors.shore),
      smoothstep(float(0.3).add(s), float(0.4).add(s), elevation))
    const c3 = mix(c2, color(colors.lowland),
      smoothstep(float(0.4).add(s), float(0.5).add(s), elevation))
    const c4 = mix(c3, color(colors.highland),
      smoothstep(float(0.5).add(s), float(0.7).add(s), elevation))
    const c5 = mix(c4, color(colors.mountain),
      smoothstep(float(0.7).add(s), float(0.85).add(s), elevation))
    const finalColor = mix(c5, color(colors.peak),
      smoothstep(float(0.85).add(s), float(1.0).add(s), elevation))

    material.colorNode = mix(finalColor, sideColor, sideMask)
  }

  return material
}

// 2D ガウシアンブラー (分離カーネル: 水平→垂直)
function gaussianBlur(data, width, height, radius) {
  if (radius <= 0) return data

  // σ = radius / 2 でカーネル生成
  const sigma = radius / 2
  const kernelSize = radius * 2 + 1
  const kernel = new Float32Array(kernelSize)
  let sum = 0
  for (let i = 0; i < kernelSize; i++) {
    const x = i - radius
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma))
    sum += kernel[i]
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum

  const temp = new Float32Array(data.length)
  const out = new Float32Array(data.length)

  // 水平パス
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let val = 0
      for (let k = -radius; k <= radius; k++) {
        const sc = Math.min(Math.max(col + k, 0), width - 1)
        val += data[row * width + sc] * kernel[k + radius]
      }
      temp[row * width + col] = val
    }
  }

  // 垂直パス
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let val = 0
      for (let k = -radius; k <= radius; k++) {
        const sr = Math.min(Math.max(row + k, 0), height - 1)
        val += temp[sr * width + col] * kernel[k + radius]
      }
      out[row * width + col] = val
    }
  }

  return out
}

// 上面・側面・底面を持つ地形ジオメトリを構築
function buildTerrainGeometry(demData, { terrainWidth, targetHeight, terrainDepth, smooth, heightScale: hScale, baseHeight }) {
  const { values, width, height, nodata } = demData
  const cols = width
  const rows = height
  const baseY = -baseHeight

  // NODATA を 0 に置換した作業用配列
  const raw = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    raw[i] = values[i] === nodata ? 0 : values[i]
  }

  // ガウシアンブラー適用
  const blurred = gaussianBlur(raw, cols, rows, smooth)

  // 標高の min/max 算出
  let minElev = Infinity
  let maxElev = -Infinity
  for (let i = 0; i < blurred.length; i++) {
    const v = blurred[i]
    if (v < minElev) minElev = v
    if (v > maxElev) maxElev = v
  }
  const elevRange = maxElev - minElev || 1
  const elevToWorld = (targetHeight / elevRange) * hScale

  // ブラー済み DEM から標高値を取得 (行反転: GeoTIFF は北→南)
  function getElev(col, row) {
    const demRow = rows - 1 - row
    const demCol = cols - 1 - col
    return blurred[demRow * cols + demCol] * elevToWorld
  }

  function getNormElev(col, row) {
    const demRow = rows - 1 - row
    const demCol = cols - 1 - col
    return (blurred[demRow * cols + demCol] - minElev) / elevRange
  }

  // --- 上面 ---
  const topVertCount = cols * rows
  const topPositions = new Float32Array(topVertCount * 3)
  const topNormElevs = new Float32Array(topVertCount)
  const topSideMask = new Float32Array(topVertCount) // 全て 0
  const topUvs = new Float32Array(topVertCount * 2)

  const stepX = terrainWidth / (cols - 1)
  const stepZ = terrainDepth / (rows - 1)
  const halfW = terrainWidth / 2
  const halfD = terrainDepth / 2

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const vi = row * cols + col
      topPositions[vi * 3] = col * stepX - halfW
      topPositions[vi * 3 + 1] = getElev(col, row)
      topPositions[vi * 3 + 2] = row * stepZ - halfD
      topNormElevs[vi] = getNormElev(col, row)
      topUvs[vi * 2] = 1 - col / (cols - 1)
      topUvs[vi * 2 + 1] = row / (rows - 1)
    }
  }

  // 上面インデックス
  const topTriCount = (cols - 1) * (rows - 1) * 2
  const topIndices = new Uint32Array(topTriCount * 3)
  let ti = 0
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col
      const b = a + 1
      const c = (row + 1) * cols + col
      const d = c + 1
      topIndices[ti++] = a
      topIndices[ti++] = c
      topIndices[ti++] = b
      topIndices[ti++] = b
      topIndices[ti++] = c
      topIndices[ti++] = d
    }
  }

  // --- 側面 ---
  // 外周: 上辺(row=rows-1), 下辺(row=0), 左辺(col=0), 右辺(col=cols-1)
  const perimeterLength = 2 * (cols + rows - 2)
  const sideVertCount = perimeterLength * 2 // 上端 + 下端
  const sidePositions = new Float32Array(sideVertCount * 3)
  const sideNormElevs = new Float32Array(sideVertCount) // 0 for sides
  const sideSideMask = new Float32Array(sideVertCount)
  const sideUvs = new Float32Array(sideVertCount * 2) // 側面は (0,0)

  // 外周頂点を収集 (時計回り: 上辺→右辺→下辺→左辺)
  const perimeterPoints = []

  // 上辺 (row = rows-1, col 0→cols-1)
  for (let col = 0; col < cols; col++) {
    perimeterPoints.push({ col, row: rows - 1 })
  }
  // 右辺 (col = cols-1, row rows-2→0)
  for (let row = rows - 2; row >= 0; row--) {
    perimeterPoints.push({ col: cols - 1, row })
  }
  // 下辺 (row = 0, col cols-2→0)
  for (let col = cols - 2; col >= 0; col--) {
    perimeterPoints.push({ col, row: 0 })
  }
  // 左辺 (col = 0, row 1→rows-2)
  for (let row = 1; row < rows - 1; row++) {
    perimeterPoints.push({ col: 0, row })
  }

  for (let i = 0; i < perimeterPoints.length; i++) {
    const { col, row } = perimeterPoints[i]
    const x = col * stepX - halfW
    const z = row * stepZ - halfD
    const elev = getElev(col, row)

    // 上端頂点
    const ui = i * 2
    sidePositions[ui * 3] = x
    sidePositions[ui * 3 + 1] = elev
    sidePositions[ui * 3 + 2] = z

    // 下端頂点
    const li = i * 2 + 1
    sidePositions[li * 3] = x
    sidePositions[li * 3 + 1] = baseY
    sidePositions[li * 3 + 2] = z

    sideNormElevs[ui] = getNormElev(col, row)
    sideNormElevs[li] = 0
    sideSideMask[ui] = 1.0
    sideSideMask[li] = 1.0
  }

  // 側面インデックス (クワッドストリップ)
  const sideTriCount = perimeterLength * 2
  const sideIndices = new Uint32Array(sideTriCount * 3)
  let si = 0
  for (let i = 0; i < perimeterLength; i++) {
    const next = (i + 1) % perimeterLength
    const a = i * 2       // 現在の上端
    const b = i * 2 + 1   // 現在の下端
    const c = next * 2     // 次の上端
    const d = next * 2 + 1 // 次の下端

    // 外向きの面 (反時計回りで表面)
    sideIndices[si++] = a
    sideIndices[si++] = b
    sideIndices[si++] = d
    sideIndices[si++] = a
    sideIndices[si++] = d
    sideIndices[si++] = c
  }

  // --- 底面 ---
  // 4頂点の単純な平面
  const bottomPositions = new Float32Array([
    -halfW, baseY, -halfD,
    halfW, baseY, -halfD,
    halfW, baseY, halfD,
    -halfW, baseY, halfD,
  ])
  const bottomNormElevs = new Float32Array(4)
  const bottomSideMask = new Float32Array([1, 1, 1, 1])
  const bottomUvs = new Float32Array(8) // 底面は (0,0)
  const bottomIndices = new Uint32Array([
    0, 1, 2,
    0, 2, 3,
  ])

  // --- 結合 ---
  const totalVerts = topVertCount + sideVertCount + 4
  const positions = new Float32Array(totalVerts * 3)
  const normElevs = new Float32Array(totalVerts)
  const sideMasks = new Float32Array(totalVerts)
  const uvs = new Float32Array(totalVerts * 2)

  // 上面
  positions.set(topPositions, 0)
  normElevs.set(topNormElevs, 0)
  sideMasks.set(topSideMask, 0)
  uvs.set(topUvs, 0)

  // 側面
  const sideOffset = topVertCount
  positions.set(sidePositions, sideOffset * 3)
  normElevs.set(sideNormElevs, sideOffset)
  sideMasks.set(sideSideMask, sideOffset)
  uvs.set(sideUvs, sideOffset * 2)

  // 底面
  const bottomOffset = topVertCount + sideVertCount
  positions.set(bottomPositions, bottomOffset * 3)
  normElevs.set(bottomNormElevs, bottomOffset)
  sideMasks.set(bottomSideMask, bottomOffset)
  uvs.set(bottomUvs, bottomOffset * 2)

  // インデックス結合
  const totalIndices = topIndices.length + sideIndices.length + bottomIndices.length
  const indices = new Uint32Array(totalIndices)
  indices.set(topIndices, 0)

  // 側面インデックスにオフセットを加算
  for (let i = 0; i < sideIndices.length; i++) {
    indices[topIndices.length + i] = sideIndices[i] + sideOffset
  }

  // 底面インデックスにオフセットを加算
  for (let i = 0; i < bottomIndices.length; i++) {
    indices[topIndices.length + sideIndices.length + i] = bottomIndices[i] + bottomOffset
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('aElevation', new Float32BufferAttribute(normElevs, 1))
  geometry.setAttribute('aSideMask', new Float32BufferAttribute(sideMasks, 1))
  geometry.setIndex(new Uint32BufferAttribute(indices, 1))
  geometry.computeVertexNormals()

  // ワールド座標系の高さバッファを生成（雨などの衝突判定用）
  // getElev と同じロジックで生成し、上面ジオメトリとの一致を保証する
  const heightBuffer = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      heightBuffer[row * cols + col] = getElev(col, row)
    }
  }

  return {
    geometry,
    heightInfo: { heights: heightBuffer, cols, rows, terrainWidth, terrainDepth },
  }
}

function TerrainLayer({
  url,
  texture: texturePath = null,
  scale = DEFAULT_SCALE,
  colors = DEFAULT_COLORS,
  smooth = 0,
  heightScale = 1.0,
  baseHeight = 2.0,
  seaLevel = 0,
  position = [0, 0, 0],
  onHeightData,
}) {
  const [demData, setDemData] = useState(null)
  const [texMap, setTexMap] = useState(null)

  useEffect(() => {
    if (!texturePath) { setTexMap(null); return }
    const loader = new TextureLoader()
    loader.load(texturePath, (tex) => {
      tex.colorSpace = SRGBColorSpace
      setTexMap(tex)
    })
    return () => {
      setTexMap((prev) => { prev?.dispose(); return null })
    }
  }, [texturePath])

  const mergedColors = useMemo(
    () => colors === DEFAULT_COLORS ? DEFAULT_COLORS : { ...DEFAULT_COLORS, ...colors },
    [colors]
  )

  useEffect(() => {
    if (!url) return
    let ignore = false

    async function loadDEM() {
      const response = await fetch(url)
      const arrayBuffer = await response.arrayBuffer()
      const tiff = await fromArrayBuffer(arrayBuffer)
      const image = await tiff.getImage()
      const fullWidth = image.getWidth()
      const fullHeight = image.getHeight()
      const nodata = image.getGDALNoData()

      let rasters, width, height

      if (fullWidth > MAX_DEM_SIZE || fullHeight > MAX_DEM_SIZE) {
        const imageCount = await tiff.getImageCount()

        if (imageCount > 1) {
          // COG: tiff.readRasters で最適な overview を自動選択
          const ratio = Math.max(fullWidth, fullHeight) / MAX_DEM_SIZE
          const targetW = Math.round(fullWidth / ratio)
          const targetH = Math.round(fullHeight / ratio)
          rasters = await tiff.readRasters({ width: targetW, height: targetH })
          width = rasters.width
          height = rasters.height
          console.log(
            `TerrainLayer: COG detected (${imageCount} images). ` +
            `Downsampled ${fullWidth}x${fullHeight} → ${width}x${height}`
          )
        } else {
          // 非 COG: image.readRasters の resample で縮小
          const ratio = Math.max(fullWidth, fullHeight) / MAX_DEM_SIZE
          const targetW = Math.round(fullWidth / ratio)
          const targetH = Math.round(fullHeight / ratio)
          rasters = await image.readRasters({ width: targetW, height: targetH })
          width = rasters.width
          height = rasters.height
          console.log(
            `TerrainLayer: Large DEM resampled ${fullWidth}x${fullHeight} → ${width}x${height}`
          )
        }
      } else {
        rasters = await image.readRasters()
        width = fullWidth
        height = fullHeight
      }

      if (!ignore) {
        setDemData({
          values: rasters[0],
          width,
          height,
          nodata: nodata ?? -9999,
        })
      }
    }

    loadDEM().catch((err) => console.error('DEM load failed:', err))
    return () => { ignore = true }
  }, [url])

  const { geometry, heightInfo } = useMemo(() => {
    if (!demData) return { geometry: null, heightInfo: null }
    return buildTerrainGeometry(demData, {
      terrainWidth: scale[0],
      targetHeight: scale[1],
      terrainDepth: scale[2],
      smooth,
      heightScale,
      baseHeight,
    })
  }, [demData, scale, smooth, heightScale, baseHeight])

  useEffect(() => {
    if (heightInfo && onHeightData) onHeightData(heightInfo)
  }, [heightInfo, onHeightData])

  const material = useMemo(() => createTerrainMaterial(mergedColors, texMap, seaLevel), [mergedColors, texMap, seaLevel])

  useEffect(() => {
    return () => {
      geometry?.dispose()
      material?.dispose()
    }
  }, [geometry, material])

  if (!url) {
    console.error('TerrainLayer: url prop is required')
    return null
  }

  if (!geometry) return null

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={position}
      receiveShadow
      castShadow
    />
  )
}

export default TerrainLayer
