/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute } from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, PointsNodeMaterial } from 'three/webgpu'
import { positionLocal } from 'three/tsl'
import earcut from 'earcut'

import { useProjection } from '../gis/CoordinateContext'
import { clipAndSplitRings, normalizeLon, normalizeRing, projectLonLatGPU } from '../gis/projectionGPU'

// 定数定義: 描画スタイルやサンプリング設定
const DEFAULT_SAMPLE_STEP = 0.2
const Z_OFFSET = 0.025
const LINE_STYLE = { color: '#6dcff6', opacity: 0.5 }
const POINT_STYLE = { color: '#ffffff', size: 0.12 }

// ポリゴンの塗りつぶし色（LABELRANK に基づく）
const FILL_COLORS = {
  2: '#2d6a4f',
  3: '#40916c',
  4: '#52b788',
  5: '#74c69d',
  6: '#95d5b2',
  7: '#b7e4c7',
}
const FILL_DEFAULT_COLOR = '#52b788'
const FILL_OPACITY = 0.6

/**
 * GeoJSON の geometry から座標データを収集します。
 */
function collectCoordinates(geometry, collector) {
  if (!geometry) return

  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach((ring) => collector(ring))
    return
  }

  if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => {
      polygon.forEach((ring) => collector(ring))
    })
    return
  }

  if (geometry.type === 'LineString') {
    collector(geometry.coordinates)
    return
  }

  if (geometry.type === 'MultiLineString') {
    geometry.coordinates.forEach((line) => collector(line))
  }
}

/**
 * 2点間の線分を地理座標系でサンプリングし、頂点配列に追加します。
 * 直線が図法によって曲線になるため、細かく割る必要があります。
 */
function appendSampledSegment(linePositions, pointPositions, previous, current, view) {
  const centerLon = view.centerLon ?? 0
  const prevLon = normalizeLon(previous[0], centerLon)
  const currLon = normalizeLon(current[0], centerLon)

  // 日付変更線をまたぐ巨大な移動は描画の乱れの原因になるためスキップ
  if (Math.abs(currLon - prevLon) > 180) return

  const lonDelta = currLon - prevLon
  const latDelta = current[1] - previous[1]
  const steps = Math.max(
    1,
    Math.ceil(
      Math.max(
        Math.abs(lonDelta) / (view.sampleLonStep ?? DEFAULT_SAMPLE_STEP),
        Math.abs(latDelta) / (view.sampleLatStep ?? DEFAULT_SAMPLE_STEP)
      )
    )
  )
  const sampledPoints = []

  // 線分を分割してサンプリング
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const lon = prevLon + lonDelta * t
    const lat = previous[1] + latDelta * t
    sampledPoints.push([lon, lat])
  }

  // ライン用（線分リスト）
  for (let index = 1; index < sampledPoints.length; index += 1) {
    const prev = sampledPoints[index - 1]
    const curr = sampledPoints[index]
    linePositions.push(prev[0], prev[1], 0)
    linePositions.push(curr[0], curr[1], 0)
  }

  // ポイント用（頂点リスト）
  sampledPoints.forEach((point) => {
    pointPositions.push(point[0], point[1], 0)
  })
}

/**
 * クリップ済みのリングを三角形分割（Triangulation）します。
 */
function triangulateClippedRings(clippedRings) {
  const flatCoords = []
  const holeIndices = []

  clippedRings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) {
      holeIndices.push(flatCoords.length / 2) // 穴の開始インデックス
    }
    ring.forEach((coord) => {
      flatCoords.push(coord[0], coord[1])
    })
  })

  // earcut ライブラリで三角形のインデックスを生成
  const indices = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null, 2)

  const positions = []
  for (let i = 0; i < indices.length; i += 1) {
    const idx = indices[i]
    positions.push(flatCoords[idx * 2], flatCoords[idx * 2 + 1], 0)
  }
  return positions
}

/**
 * ポリゴンを正規化・クリップし、三角形の頂点配列に変換します。
 */
function triangulatePolygon(rings, view) {
  const centerLon = view.centerLon ?? 0

  // 1. 経度の連続化
  const normalizedRings = rings.map((ring) => normalizeRing(ring, centerLon))

  // 2. 日付変更線でのクリップと複製
  const polygonGroups = clipAndSplitRings(normalizedRings, centerLon)

  // 3. 各グループを三角形に分割
  const positions = []
  polygonGroups.forEach((clippedRings) => {
    positions.push(...triangulateClippedRings(clippedRings))
  })

  return positions
}

/**
 * 全フィーチャからポリゴン塗りつぶし用の Geometry を構築します。
 */
function buildFillGeometry(geojson, view) {
  const fillPositions = []
  const fillColors = []

  geojson.features.forEach((feature) => {
    const geometry = feature.geometry
    if (!geometry) return

    const labelRank = feature.properties?.LABELRANK
    const fillColor = new Color(FILL_COLORS[labelRank] ?? FILL_DEFAULT_COLOR)

    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : []

    polygons.forEach((polygon) => {
      const positions = triangulatePolygon(polygon, view)
      fillPositions.push(...positions)
      for (let i = 0; i < positions.length; i += 3) {
        fillColors.push(fillColor.r, fillColor.g, fillColor.b)
      }
    })
  })

  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(fillPositions, 3))
  geo.setAttribute('color', new Float32BufferAttribute(fillColors, 3))
  return geo
}

/**
 * GeoJSON データを読み込み、地理座標として描画するレイヤー。
 * 
 * 仕組み:
 * 1. GeoJSON をフェッチし、CPU 側で頂点の正規化・クリップ・三角形分割を行う。
 * 2. 生成された頂点（lon/lat/0）を BufferGeometry に格納。
 * 3. 描画時に GPU (TSL) で lon/lat を指定の図法（等距円筒図法など）へ変換する。
 */
function GeojsonLayer({ url }) {
  const { view, projUniforms, projectionType } = useProjection()
  const [geojson, setGeojson] = useState(null)

  // データのフェッチ
  useEffect(() => {
    let ignore = false

    async function loadGeojson() {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`GeoJSON の読み込みに失敗しました: ${response.status}`)
      const nextGeojson = await response.json()
      if (!ignore) setGeojson(nextGeojson)
    }

    loadGeojson().catch((error) => {
      console.error(error instanceof Error ? error.message : 'GeoJSON の読み込みに失敗しました')
    })

    return () => { ignore = true }
  }, [url])

  // Geometry の生成（CPU 処理）
  const { lineGeometry, pointGeometry, fillGeometry } = useMemo(() => {
    if (!geojson?.features) return { lineGeometry: null, pointGeometry: null, fillGeometry: null }

    const linePositions = []
    const pointPositions = []

    geojson.features.forEach((feature) => {
      collectCoordinates(feature.geometry, (ring) => {
        for (let index = 1; index < ring.length; index += 1) {
          const previous = ring[index - 1]
          const current = ring[index]
          if (!previous || !current) continue
          appendSampledSegment(linePositions, pointPositions, previous, current, view)
        }
      })
    })

    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new Float32BufferAttribute(linePositions, 3))

    const pointGeometry = new BufferGeometry()
    pointGeometry.setAttribute('position', new Float32BufferAttribute(pointPositions, 3))

    const fillGeometry = buildFillGeometry(geojson, view)

    return { lineGeometry, pointGeometry, fillGeometry }
  }, [geojson, view])

  // GPU 投影用マテリアルの生成 (WebGPU/TSL)
  const { fillMaterial, lineMaterial, pointMaterial } = useMemo(() => {
    // 頂点シェーダー側で実行される投影ノード
    const projectedPos = projectLonLatGPU(positionLocal.x, positionLocal.y, projUniforms, projectionType)

    const fillMaterial = new MeshBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      opacity: FILL_OPACITY,
    })
    fillMaterial.positionNode = projectedPos

    const lineMaterial = new LineBasicNodeMaterial({
      color: LINE_STYLE.color,
      transparent: true,
      opacity: LINE_STYLE.opacity,
    })
    lineMaterial.positionNode = projectedPos

    const pointMaterial = new PointsNodeMaterial({
      color: POINT_STYLE.color,
      size: POINT_STYLE.size,
      sizeAttenuation: true,
    })
    pointMaterial.positionNode = projectedPos

    return { fillMaterial, lineMaterial, pointMaterial }
  }, [projUniforms, projectionType])

  // リソースの破棄
  useEffect(() => {
    return () => {
      lineGeometry?.dispose()
      pointGeometry?.dispose()
      fillGeometry?.dispose()
      fillMaterial?.dispose()
      lineMaterial?.dispose()
      pointMaterial?.dispose()
    }
  }, [lineGeometry, pointGeometry, fillGeometry, fillMaterial, lineMaterial, pointMaterial])

  if (!lineGeometry || !pointGeometry || !fillGeometry) {
    return null
  }

  return (
    <group position={[0, 0, Z_OFFSET]}>
      <mesh geometry={fillGeometry} material={fillMaterial} />
      <lineSegments geometry={lineGeometry} material={lineMaterial} />
      <points geometry={pointGeometry} material={pointMaterial} />
    </group>
  )
}

export default GeojsonLayer
