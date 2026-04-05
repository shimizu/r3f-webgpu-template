import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  attribute,
  color,
  float,
  mix,
  smoothstep,
} from 'three/tsl'
import { fromUrl } from 'geotiff'

const DEM_URL = '/dem/output_GEBCOIceTopo.tif'
const TARGET_HEIGHT = 4.0   // 地形の高さがこのワールド単位に収まるようスケール
const BASE_Y = -2.0         // 側面・底面の下端 Y 座標
const TERRAIN_WIDTH = 16
const TERRAIN_DEPTH = 16

// 標高カラーランプ
const COLORS = {
  deepOcean: '#0a1a3a',
  shallowOcean: '#1a6a8a',
  shore: '#c2b280',
  lowland: '#4a8a3a',
  highland: '#2a5a1a',
  mountain: '#8a7a6a',
  peak: '#f0f0f0',
  side: '#3a2a1a',
}

function createTerrainMaterial() {
  const material = new MeshPhysicalNodeMaterial({
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false,
  })

  const elevation = attribute('aElevation', 'float')

  const c1 = mix(color(COLORS.deepOcean), color(COLORS.shallowOcean),
    smoothstep(float(0.0), float(0.3), elevation))
  const c2 = mix(c1, color(COLORS.shore),
    smoothstep(float(0.3), float(0.4), elevation))
  const c3 = mix(c2, color(COLORS.lowland),
    smoothstep(float(0.4), float(0.5), elevation))
  const c4 = mix(c3, color(COLORS.highland),
    smoothstep(float(0.5), float(0.7), elevation))
  const c5 = mix(c4, color(COLORS.mountain),
    smoothstep(float(0.7), float(0.85), elevation))
  const finalColor = mix(c5, color(COLORS.peak),
    smoothstep(float(0.85), float(1.0), elevation))

  // 側面マスク: aElevation < 0 の場合は側面色
  const sideMask = attribute('aSideMask', 'float')
  const surfaceColor = mix(finalColor, color(COLORS.side), sideMask)

  material.colorNode = surfaceColor

  return material
}

// 上面・側面・底面を持つ地形ジオメトリを構築
function buildTerrainGeometry(demData) {
  const { values, width, height, nodata } = demData
  const cols = width
  const rows = height

  // 標高の min/max 算出
  let minElev = Infinity
  let maxElev = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v !== nodata) {
      if (v < minElev) minElev = v
      if (v > maxElev) maxElev = v
    }
  }
  const elevRange = maxElev - minElev || 1
  const heightScale = TARGET_HEIGHT / elevRange

  // DEM から標高値を取得 (行反転: GeoTIFF は北→南)
  function getElev(col, row) {
    const demRow = rows - 1 - row
    const v = values[demRow * cols + col]
    return (v === nodata ? 0 : v) * heightScale
  }

  function getNormElev(col, row) {
    const demRow = rows - 1 - row
    const v = values[demRow * cols + col]
    return v === nodata ? 0 : (v - minElev) / elevRange
  }

  // --- 上面 ---
  const topVertCount = cols * rows
  const topPositions = new Float32Array(topVertCount * 3)
  const topNormElevs = new Float32Array(topVertCount)
  const topSideMask = new Float32Array(topVertCount) // 全て 0

  const stepX = TERRAIN_WIDTH / (cols - 1)
  const stepZ = TERRAIN_DEPTH / (rows - 1)
  const halfW = TERRAIN_WIDTH / 2
  const halfD = TERRAIN_DEPTH / 2

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const vi = row * cols + col
      topPositions[vi * 3] = col * stepX - halfW
      topPositions[vi * 3 + 1] = getElev(col, row)
      topPositions[vi * 3 + 2] = row * stepZ - halfD
      topNormElevs[vi] = getNormElev(col, row)
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
    sidePositions[li * 3 + 1] = BASE_Y
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
    -halfW, BASE_Y, -halfD,
    halfW, BASE_Y, -halfD,
    halfW, BASE_Y, halfD,
    -halfW, BASE_Y, halfD,
  ])
  const bottomNormElevs = new Float32Array(4)
  const bottomSideMask = new Float32Array([1, 1, 1, 1])
  const bottomIndices = new Uint32Array([
    0, 1, 2,
    0, 2, 3,
  ])

  // --- 結合 ---
  const totalVerts = topVertCount + sideVertCount + 4
  const positions = new Float32Array(totalVerts * 3)
  const normElevs = new Float32Array(totalVerts)
  const sideMasks = new Float32Array(totalVerts)

  // 上面
  positions.set(topPositions, 0)
  normElevs.set(topNormElevs, 0)
  sideMasks.set(topSideMask, 0)

  // 側面
  const sideOffset = topVertCount
  positions.set(sidePositions, sideOffset * 3)
  normElevs.set(sideNormElevs, sideOffset)
  sideMasks.set(sideSideMask, sideOffset)

  // 底面
  const bottomOffset = topVertCount + sideVertCount
  positions.set(bottomPositions, bottomOffset * 3)
  normElevs.set(bottomNormElevs, bottomOffset)
  sideMasks.set(bottomSideMask, bottomOffset)

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
  geometry.setAttribute('aElevation', new Float32BufferAttribute(normElevs, 1))
  geometry.setAttribute('aSideMask', new Float32BufferAttribute(sideMasks, 1))
  geometry.setIndex(new Uint32BufferAttribute(indices, 1))
  geometry.computeVertexNormals()

  return geometry
}

function TerrainLayer({ position = [0, 0, 0] }) {
  const [demData, setDemData] = useState(null)

  useEffect(() => {
    let ignore = false

    async function loadDEM() {
      const tiff = await fromUrl(DEM_URL)
      const image = await tiff.getImage()
      const rasters = await image.readRasters()
      const width = image.getWidth()
      const height = image.getHeight()
      const nodata = image.getGDALNoData()

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
  }, [])

  const geometry = useMemo(() => {
    if (!demData) return null
    return buildTerrainGeometry(demData)
  }, [demData])

  const material = useMemo(() => createTerrainMaterial(), [])

  useEffect(() => {
    return () => {
      geometry?.dispose()
      material?.dispose()
    }
  }, [geometry, material])

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
