import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferGeometry, Color, Float32BufferAttribute, SRGBColorSpace, TextureLoader, Uint32BufferAttribute, Vector2 } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  attribute,
  clamp,
  color,
  float,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { fromArrayBuffer } from 'geotiff'

import { useProjectionMaybe } from '../gis/CoordinateContext'
import { useLandCover } from '../gis/LandCoverContext'
import { demUvToLcUvCoeffs, DEFAULT_LC_PALETTE } from '../gis/landcover'
import { projectLonLatCPU } from '../gis/projectionCPU'
import { coverageMask } from '../tsl/coverageMask'
import { createBurnField } from '../tsl/burnField'
import { valueFbm3 } from '../tsl/valueNoise'

const DEFAULT_SIZE = 16            // 基準幅（奥行は DEM アスペクト比から自動算出）
const DEFAULT_HEIGHT_RANGE = 4     // 標高レンジ
const MAX_DEM_SIZE = 512          // これを超える場合は縮小読み込み
const DEFAULT_NODATA = -9999

const TERRAIN_MATERIAL = { roughness: 0.85, metalness: 0.0 }

const ELEVATION_STOPS = [0.0, 0.3, 0.4, 0.5, 0.7, 0.85, 1.0]

const DEFAULT_COLORS = {
  deepOcean: '#0a1a3a',
  shallowOcean: '#1a6a8a',
  shore: '#a0835e',
  lowland: '#d4c4a0',
  highland: '#c2a46e',
  mountain: '#a08050',
  peak: '#030202',
  side: '#3a2a1a',
}

// wet は濡れ表現の uniform セット（coverage/darken/rough/scale/edge/seed）。
// acc は堆積（雪/苔）の uniform セット（amount/snowLine/band/aspect/flatThreshold/
// patchScale/edge/seed/color/roughness/flatten）。
// burn は延焼の uniform セット（ignition/radius/band/noiseScale/noiseAmount/seed/
// scorchColor/glowColor/glowStrength。burnField.js の解析近似）。
// landCover は土地被覆配色セット（texture: nearest DataTexture、su/ou/sv/ov:
// DEM uv → 土地被覆 uv の affine 係数、uniforms: palette 9 色 + 陰影変調）。
// いずれも呼び出し側が保持して .value 更新するので、スライダー操作で再コンパイルは走らない
function createTerrainMaterial(colors, texMap, seaLevel = 0, stops = ELEVATION_STOPS, wet = null, acc = null, burn = null, landCover = null) {
  const material = new MeshPhysicalNodeMaterial({
    roughness: TERRAIN_MATERIAL.roughness,
    metalness: TERRAIN_MATERIAL.metalness,
    flatShading: false,
  })

  const sideMask = attribute('aSideMask', 'float')
  const sideColor = color(colors.side)
  const elevation = attribute('aElevation', 'float')

  // roughness は濡れ・堆積を順に積むので変数で持つ
  let roughNode = float(TERRAIN_MATERIAL.roughness)

  // 濡れ表現: fBM パッチで albedo を暗く・roughness を下げる（task.md T2）。
  // 陸地（海面標高より上）の上面のみに効かせ、海色と側面には影響させない
  let wetMask = null
  if (wet) {
    const land = smoothstep(float(seaLevel).add(0.005), float(seaLevel).add(0.04), elevation)
    wetMask = coverageMask(positionWorld.xz, wet.scale, wet.seed, wet.coverage, wet.edge)
      .mul(land)
      .mul(sideMask.oneMinus())
    roughNode = mix(roughNode, wet.rough, wetMask)
  }
  const applyWet = (c) => (wetMask ? c.mul(mix(float(1), wet.darken, wetMask)) : c)

  // 堆積（雪/苔）: 法線の向き（平らな上面 + 北斜面）× 標高（雪線）× パッチで
  // 積もり量を決め、albedo を堆積色へ・roughness を雪側へ・法線を上方向へ寄せる。
  // 北方向 = ワールド -Z（TerrainLayer の投影規約: 北 = -Z = 画面奥）
  let accMask = null
  if (acc) {
    const up = clamp(normalWorld.y, 0, 1)
    const settle = smoothstep(acc.flatThreshold, 1, up) // 平らな面ほど積もる
    const north = clamp(normalWorld.z.negate(), 0, 1) // 北向き度
    const effElev = elevation.add(north.mul(acc.aspect)) // 北斜面は実効標高↑ = 雪線↓
    const altitude = smoothstep(acc.snowLine, acc.snowLine.add(acc.band), effElev)
    const patch = coverageMask(positionWorld.xz, acc.patchScale, acc.seed, acc.amount, acc.edge)
    accMask = altitude.mul(settle).mul(patch).mul(sideMask.oneMinus())
    roughNode = mix(roughNode, acc.roughness, accMask)
    // 堆積域は法線を上方向へ寄せて柔らかい被膜に見せる
    const upView = transformNormalToView(vec3(0, 1, 0))
    material.normalNode = mix(transformNormalToView(normalWorld), upView, accMask.mul(acc.flatten))
  }
  const applyAcc = (c) => (accMask ? mix(c, acc.color, accMask) : c)

  // 延焼（山火事）: 発火点距離場の解析近似（burnField.js）。
  // 焼け跡は albedo を焦がし roughness を上げ、前線帯はちらつく残火 emissive
  let burntMask = null
  if (burn) {
    const { burnAt } = createBurnField(burn)
    const burnState = burnAt(positionWorld.xz)
    const land = smoothstep(float(seaLevel).add(0.005), float(seaLevel).add(0.04), elevation)
    const topLand = land.mul(sideMask.oneMinus())
    burntMask = burnState.x.mul(topLand)
    const burningMask = burnState.y.mul(topLand)
    roughNode = mix(roughNode, float(0.95), burntMask)
    // 残火のちらつき（空間 + 時間の安いノイズ）
    const flicker = valueFbm3(vec3(positionWorld.xz.mul(2.5), time.mul(1.4)), 2)
      .mul(0.5)
      .add(0.55)
    material.emissiveNode = burn.glowColor
      .mul(burningMask)
      .mul(burn.glowStrength)
      .mul(flicker)
  }
  const applyBurn = (c) => (burntMask ? mix(c, burn.scorchColor, burntMask.mul(0.92)) : c)

  material.roughnessNode = roughNode

  if (texMap) {
    const texNode = texture(texMap)
    const texColor = texNode.sample(uv())
    material.colorNode = mix(applyBurn(applyAcc(applyWet(texColor))), sideColor, sideMask)
  } else if (landCover) {
    // 土地被覆配色: DEM uv → 土地被覆 uv（bbox 間 affine、両者とも v=1 が北）で
    // nearest サンプルし、クラス値 (0..8) をパレット LUT で色に変換する。
    // r8unorm + nearest なので mul(255).round() でクラス値が厳密に復元できる
    const lcU = landCover.uniforms
    const lcUv = uv().mul(vec2(landCover.su, landCover.sv)).add(vec2(landCover.ou, landCover.ov))
    const classIdx = texture(landCover.texture).sample(lcUv).r.mul(255).round()

    // water (0) のみ既存の水深 mix を使い、湖・海の深浅感を維持する
    const waterColor = mix(color(colors.deepOcean), color(colors.shallowOcean),
      smoothstep(float(stops[0]).add(float(seaLevel)), float(stops[1]).add(float(seaLevel)), elevation))

    // クラス一致で 1、それ以外で 0 の窓関数の総和（クラス値は整数なので排他的）
    const weightFor = (i) => float(1).sub(clamp(classIdx.sub(float(i)).abs(), 0, 1))
    let lcColor = waterColor.mul(weightFor(0))
    for (let i = 1; i < lcU.palette.length; i += 1) {
      lcColor = lcColor.add(lcU.palette[i].mul(weightFor(i)))
    }

    // フラットな塗り絵回避: 標高で明度を変調 + 低振幅 fBM の色ムラ（いずれも uniform 駆動）
    const shade = mix(lcU.shadeDark, lcU.shadeBright, elevation)
    const mottle = valueFbm3(vec3(positionWorld.xz.mul(lcU.mottleScale), 7.7), 3)
      .mul(lcU.mottleAmount)
    const lcShaded = lcColor.mul(shade).mul(float(1).add(mottle))

    material.colorNode = mix(applyBurn(applyAcc(applyWet(lcShaded))), sideColor, sideMask)
  } else {
    const s = float(seaLevel)
    const c1 = mix(color(colors.deepOcean), color(colors.shallowOcean),
      smoothstep(float(stops[0]).add(s), float(stops[1]).add(s), elevation))
    const c2 = mix(c1, color(colors.shore),
      smoothstep(float(stops[1]).add(s), float(stops[2]).add(s), elevation))
    const c3 = mix(c2, color(colors.lowland),
      smoothstep(float(stops[2]).add(s), float(stops[3]).add(s), elevation))
    const c4 = mix(c3, color(colors.highland),
      smoothstep(float(stops[3]).add(s), float(stops[4]).add(s), elevation))
    const c5 = mix(c4, color(colors.mountain),
      smoothstep(float(stops[4]).add(s), float(stops[5]).add(s), elevation))
    const finalColor = mix(c5, color(colors.peak),
      smoothstep(float(stops[5]).add(s), float(stops[6]).add(s), elevation))

    material.colorNode = mix(applyBurn(applyAcc(applyWet(finalColor))), sideColor, sideMask)
  }

  return material
}

// 2D ガウシアンブラー (分離カーネル: 水平→垂直)
function gaussianBlur(data, width, height, radius) {
  if (radius <= 0) return data

  // 小数部を補間係数として使い、整数カーネルでブラーした結果と元データをブレンド
  const intRadius = Math.ceil(radius)
  const blend = radius / intRadius // 1.0 なら完全ブラー、0.5 なら半分ブレンド

  // σ = intRadius / 2 でカーネル生成
  const sigma = intRadius / 2
  const kernelSize = intRadius * 2 + 1
  const kernel = new Float32Array(kernelSize)
  let sum = 0
  for (let i = 0; i < kernelSize; i++) {
    const x = i - intRadius
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
      for (let k = -intRadius; k <= intRadius; k++) {
        const sc = Math.min(Math.max(col + k, 0), width - 1)
        val += data[row * width + sc] * kernel[k + intRadius]
      }
      temp[row * width + col] = val
    }
  }

  // 垂直パス
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let val = 0
      for (let k = -intRadius; k <= intRadius; k++) {
        const sr = Math.min(Math.max(row + k, 0), height - 1)
        val += temp[sr * width + col] * kernel[k + intRadius]
      }
      out[row * width + col] = val
    }
  }

  // 元データとブラー結果を blend 比率で補間
  if (blend < 1.0) {
    for (let i = 0; i < out.length; i++) {
      out[i] = data[i] * (1 - blend) + out[i] * blend
    }
  }

  return out
}

// 上面・側面・底面を持つ地形ジオメトリを構築
// projection ({centerLon, centerLat, worldScale, projectionType}) を渡すと投影モード:
// bbox から頂点ごとに lon/lat を CPU 投影して焼き込み、GPU 投影レイヤー（GeojsonLayer 等）と整合する
function buildTerrainGeometry(demData, { terrainWidth, targetHeight, smooth, heightScale: hScale, baseHeight, projection }) {
  const { values, width, height, nodata, bbox } = demData
  const cols = width
  const rows = height
  const projected = !!(projection && bbox)

  // DEM のアスペクト比を保持: 基準幅から奥行を自動算出（legacy モード用）
  const terrainDepth = terrainWidth * (rows / cols)
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

  // ブラー済み DEM の配列インデックス。
  // projected: bbox から lon/lat を直接割り当てるため反転しない（GeoTIFF 行0=北）
  // legacy: 行・列とも反転（=180°回転。旧 Scene の rotation.z=-π と対で成立していた歴史的配置）
  const demIndex = projected
    ? (col, row) => row * cols + col
    : (col, row) => (rows - 1 - row) * cols + (cols - 1 - col)

  function getElev(col, row) {
    return blurred[demIndex(col, row)] * elevToWorld
  }

  function getNormElev(col, row) {
    return (blurred[demIndex(col, row)] - minElev) / elevRange
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

  // 頂点の水平座標 (X, Z)。col↑→X↑, row↑→Z↑ の単調性は両モード共通なので
  // 上面インデックス・側面ワインディングはそのまま流用できる。
  // projected: 投影 XY 平面（y=北+）を Y-up に読み替えるため Z = -投影y（北=-Z=画面奥）
  let posAt
  if (projected) {
    const [minLon, minLat, maxLon, maxLat] = bbox
    const lonAt = (col) => minLon + (col / (cols - 1)) * (maxLon - minLon)
    const latAt = (row) => maxLat - (row / (rows - 1)) * (maxLat - minLat) // 行0=北
    posAt = (col, row) => {
      const [px, py] = projectLonLatCPU(lonAt(col), latAt(row), projection)
      return [px, -py]
    }
  } else {
    posAt = (col, row) => [col * stepX - halfW, row * stepZ - halfD]
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const vi = row * cols + col
      const [x, z] = posAt(col, row)
      topPositions[vi * 3] = x
      topPositions[vi * 3 + 1] = getElev(col, row)
      topPositions[vi * 3 + 2] = z
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      topNormElevs[vi] = getNormElev(col, row)
      if (projected) {
        // flipY=true 前提: 画像先頭行（北）= v1
        topUvs[vi * 2] = col / (cols - 1)
        topUvs[vi * 2 + 1] = 1 - row / (rows - 1)
      } else {
        topUvs[vi * 2] = 1 - col / (cols - 1)
        topUvs[vi * 2 + 1] = row / (rows - 1)
      }
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
    const [x, z] = posAt(col, row)
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
  // 上面 XZ 範囲の4隅矩形（legacy では ±halfW/±halfD と一致）。
  // cylindrical 系図法ではグリッド外縁と厳密一致。natural-earth のみ外縁が
  // 湾曲するため僅かに不一致だが、baseY 下で実質不可視
  const bottomPositions = new Float32Array([
    minX, baseY, minZ,
    maxX, baseY, minZ,
    maxX, baseY, maxZ,
    minX, baseY, maxZ,
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

  // terrainWidth/Depth は実際の XZ スパンを返す（projected では投影後サイズ）。
  // 注意: mercator / natural-earth では格子が非等間隔になるため、
  // 規則格子前提の衝突ルックアップ（RainLayer）は近似になる
  return {
    geometry,
    heightInfo: {
      heights: heightBuffer,
      cols,
      rows,
      terrainWidth: maxX - minX,
      terrainDepth: maxZ - minZ,
      // 正規化標高 0..1 ↔ ローカル Y の変換係数（localY = minY + norm * rangeY）。
      // seaLevel（正規化値）を高さバッファと突き合わせる消費者（草の海面マスク等）が使う
      minY: minElev * elevToWorld,
      rangeY: elevRange * elevToWorld,
    },
  }
}

function TerrainLayer({
  url,
  texture: texturePath = null,
  size,
  heightRange = DEFAULT_HEIGHT_RANGE,
  elevationStops = ELEVATION_STOPS,
  colors = DEFAULT_COLORS,
  smooth = 0,
  heightScale = 1.0,
  baseHeight = 2.0,
  seaLevel = 0,
  position = [0, 0, 0],
  onHeightData,
  wetness = 0, // 濡れカバレッジの目標値 0..1（0 = 乾燥、1 = 全面濡れ）
  wetDarken = 0.55, // 濡れ部の albedo 減衰率
  wetRoughness = 0.35, // 濡れ部の roughness（艶）
  wetScale = 0.35, // 濡れパッチの空間周波数
  wetRiseTime = 1.5, // 濡れの立ち上がり時定数（秒。降り始めは速め）
  wetFallTime = 8, // 乾きの時定数（秒。止んだ後はゆっくり乾く）
  // --- 堆積（雪/苔）: 既定は雪プリセット、amount 0 で OFF ---
  snowAmount = 0, // 手動のマスター量 0..1（leva スライダー。即時反映）
  snowing = false, // 降雪中フラグ。ON の間は時定数でゆっくり積もり、OFF 後はゆっくり融ける
  snowLine = 0.55, // 堆積が始まる正規化標高
  snowBand = 0.15, // 雪線の遷移幅
  snowAspect = 0.15, // 北斜面が実効的に雪線を下げる量
  snowFlatThreshold = 0.3, // 積もる面の傾き閾値（normalWorld.y）
  snowColor = '#eef4ff', // 堆積色（白=雪 / 緑にすれば苔）
  snowRoughness = 0.9, // 堆積面の roughness（雪はマット）
  snowNormalFlatten = 0.5, // 法線を上方向へ寄せる強さ
  snowPatchScale = 0.4, // 堆積パッチの空間周波数
  snowRiseTime = 40, // 積雪の立ち上がり時定数（秒。降雪中にゆっくり積もる）
  snowFallTime = 240, // 融雪の時定数（秒。降り止んだ後は非常にゆっくり消える）
  snowDriveMax = 0.9, // 降雪駆動が到達する堆積量の上限
  // --- 延焼（山火事 5a）: radius 0 で OFF ---
  fireIgnition = null, // 発火点 [x, z]（レイヤーローカル XZ）
  fireRadius = 0, // 延焼半径（world units。CPU 側で進める）
}) {
  const [demData, setDemData] = useState(null)
  const [texMap, setTexMap] = useState(null)

  // 土地被覆（LandCoverContext から共有取得）。region に landcoverUrl が無ければ
  // texture=null のままで従来の標高 stops 配色にフォールバックする
  const { texture: lcTexture, info: lcInfo } = useLandCover()

  // 濡れ uniform セット。生成は一度きりで、値の変更は .value 更新のみ
  // （マテリアル再コンパイルを走らせない）
  const wetUniforms = useMemo(
    () => ({
      coverage: uniform(0),
      darken: uniform(0.55),
      rough: uniform(0.35),
      scale: uniform(0.35),
      edge: uniform(0.12),
      seed: uniform(new Vector2(5, 5)),
    }),
    []
  )

  // 堆積 uniform セット（生成一度きり、値は .value 更新のみ）
  const accUniforms = useMemo(
    () => ({
      amount: uniform(0),
      snowLine: uniform(0.55),
      band: uniform(0.15),
      aspect: uniform(0.15),
      flatThreshold: uniform(0.3),
      patchScale: uniform(0.4),
      edge: uniform(0.14),
      seed: uniform(new Vector2(12, 4)),
      color: uniform(new Color('#eef4ff')),
      roughness: uniform(0.9),
      flatten: uniform(0.5),
    }),
    []
  )

  // 土地被覆配色 uniform セット（生成一度きり、値は .value 更新のみ）。
  // palette はクラス値 0..8 → albedo（0 water は水深 mix で置換されるプレースホルダ）
  const lcUniforms = useMemo(
    () => ({
      palette: DEFAULT_LC_PALETTE.map((hex) => uniform(new Color(hex))),
      shadeDark: uniform(0.85), // 低標高の明度係数
      shadeBright: uniform(1.18), // 高標高の明度係数
      mottleScale: uniform(1.6), // 色ムラ fBM の空間周波数
      mottleAmount: uniform(0.08), // 色ムラの振幅（±）
    }),
    []
  )

  // 延焼 uniform セット（生成一度きり、値は .value 更新のみ）
  const burnUniforms = useMemo(
    () => ({
      ignition: uniform(new Vector2(0, 0)),
      radius: uniform(0),
      band: uniform(0.35),
      noiseScale: uniform(0.9),
      noiseAmount: uniform(0.5),
      seed: uniform(new Vector2(7.3, 2.9)),
      scorchColor: uniform(new Color('#221a14')),
      glowColor: uniform(new Color('#ff6a1f')),
      glowStrength: uniform(1.6),
    }),
    []
  )

  // 延焼パラメータ（radius は CPU 側=Scene が進めるので即時反映）
  useEffect(() => {
    burnUniforms.radius.value = fireRadius
    if (fireIgnition) burnUniforms.ignition.value.set(fireIgnition[0], fireIgnition[1])
  }, [burnUniforms, fireRadius, fireIgnition])

  // darken/rough/scale は見た目パラメータなので即時反映
  useEffect(() => {
    wetUniforms.darken.value = wetDarken
    wetUniforms.rough.value = wetRoughness
    wetUniforms.scale.value = wetScale
  }, [wetUniforms, wetDarken, wetRoughness, wetScale])

  // 堆積パラメータ（amount 以外は見た目パラメータなので即時反映。
  // amount は下の useFrame で時定数追従する）
  useEffect(() => {
    accUniforms.snowLine.value = snowLine
    accUniforms.band.value = snowBand
    accUniforms.aspect.value = snowAspect
    accUniforms.flatThreshold.value = snowFlatThreshold
    accUniforms.patchScale.value = snowPatchScale
    accUniforms.roughness.value = snowRoughness
    accUniforms.flatten.value = snowNormalFlatten
    accUniforms.color.value.set(snowColor)
  }, [
    accUniforms,
    snowLine,
    snowBand,
    snowAspect,
    snowFlatThreshold,
    snowPatchScale,
    snowRoughness,
    snowNormalFlatten,
    snowColor,
  ])

  // coverage（濡れ量）は wetness を目標に非対称の時定数で追従させる。
  // 降雨 ON/OFF に対して「降り始めは速く濡れ、止んだ後はゆっくり乾く」挙動になる。
  // 毎フレーム uniform の .value を更新するだけなので React 再レンダーは起こさない
  const wetTargetRef = useRef(wetness)
  wetTargetRef.current = wetness
  // 積雪の降雪駆動分。snowing 中は snowDriveMax へゆっくり積もり、
  // 止んだ後は非常にゆっくり融ける。手動 snowAmount（leva）は即時反映で、
  // 最終的な堆積量は max(手動, 降雪駆動)
  const snowDriveRef = useRef(0)
  const snowingRef = useRef(snowing)
  snowingRef.current = snowing
  const snowAmountRef = useRef(snowAmount)
  snowAmountRef.current = snowAmount
  useFrame((_, delta) => {
    const dt = Math.min(delta || 1 / 60, 0.1) // タブ復帰後の巨大 dt をクランプ
    const cur = wetUniforms.coverage.value
    const target = wetTargetRef.current
    if (Math.abs(target - cur) >= 1e-4) {
      const tau = target > cur ? wetRiseTime : wetFallTime
      const k = 1 - Math.exp(-dt / Math.max(tau, 1e-3)) // フレームレート非依存
      wetUniforms.coverage.value = cur + (target - cur) * k
    }

    const driveTarget = snowingRef.current ? snowDriveMax : 0
    const drive = snowDriveRef.current
    if (Math.abs(driveTarget - drive) >= 1e-4) {
      const tau = driveTarget > drive ? snowRiseTime : snowFallTime
      const k = 1 - Math.exp(-dt / Math.max(tau, 1e-3))
      snowDriveRef.current = drive + (driveTarget - drive) * k
    }
    accUniforms.amount.value = Math.max(snowAmountRef.current, snowDriveRef.current)
  })

  // <Coordinate> 配下なら投影モード（bbox + view から位置・スケールを自動決定）
  const proj = useProjectionMaybe()
  const projected = !!(proj && demData?.bbox)

  useEffect(() => {
    if (proj && demData && !demData.bbox) {
      console.warn('TerrainLayer: GeoTIFF に地理参照がないため legacy グリッドで描画します')
    }
    if (proj && size != null) {
      console.warn('TerrainLayer: 投影モードでは size は無視されます（view.worldScale がサイズを決定）')
    }
  }, [proj, demData, size])

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

      let bbox = null
      try {
        bbox = image.getBoundingBox() // [minLon, minLat, maxLon, maxLat]
      } catch {
        // 地理参照のない TIFF は bbox なし（legacy モード扱い）
      }

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
        } else {
          // 非 COG: image.readRasters の resample で縮小
          const ratio = Math.max(fullWidth, fullHeight) / MAX_DEM_SIZE
          const targetW = Math.round(fullWidth / ratio)
          const targetH = Math.round(fullHeight / ratio)
          rasters = await image.readRasters({ width: targetW, height: targetH })
          width = rasters.width
          height = rasters.height
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
          nodata: nodata ?? DEFAULT_NODATA,
          bbox,
        })
      }
    }

    loadDEM().catch((err) => console.error('DEM load failed:', err))
    return () => { ignore = true }
  }, [url])

  // 投影は CPU 焼き込みのため projUniforms.update() による動的 view 変更には追従しない
  // （view オブジェクトの差し替えなら再ビルドされる）
  const { geometry, heightInfo } = useMemo(() => {
    if (!demData) return { geometry: null, heightInfo: null }
    return buildTerrainGeometry(demData, {
      terrainWidth: size ?? DEFAULT_SIZE,
      targetHeight: heightRange,
      smooth,
      heightScale,
      baseHeight,
      projection: proj && demData.bbox ? proj.view : null,
    })
  }, [demData, size, heightRange, smooth, heightScale, baseHeight, proj])

  useEffect(() => {
    if (heightInfo && onHeightData) onHeightData(heightInfo)
  }, [heightInfo, onHeightData])

  // 土地被覆配色セット。DEM が地理参照付き（bbox あり）のときのみ uv affine が
  // 成立する。BASE 色の優先順位は texMap > landCover > 標高 stops（createTerrainMaterial）。
  // texture 到着で 1 回だけ再コンパイルが走る（region 切替と同スケールの一度きりイベント）
  const landCover = useMemo(() => {
    if (!lcTexture || !lcInfo || !demData?.bbox) return null
    return {
      texture: lcTexture,
      uniforms: lcUniforms,
      ...demUvToLcUvCoeffs(demData.bbox, lcInfo.bbox),
    }
  }, [lcTexture, lcInfo, demData, lcUniforms])

  const material = useMemo(() => createTerrainMaterial(mergedColors, texMap, seaLevel, elevationStops, wetUniforms, accUniforms, burnUniforms, landCover), [mergedColors, texMap, seaLevel, elevationStops, wetUniforms, accUniforms, burnUniforms, landCover])

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

  if (projected) {
    // ジオメトリは Y-up・world 向きで焼き込み済みなので、
    // Coordinate のデフォルト回転（X=-π/2）を counter-rotation で相殺する
    return (
      <group rotation={[Math.PI / 2, 0, 0]}>
        <mesh
          geometry={geometry}
          material={material}
          position={position}
          receiveShadow
          castShadow
        />
      </group>
    )
  }

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
