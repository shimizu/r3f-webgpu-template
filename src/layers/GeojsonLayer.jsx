/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute } from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, PointsNodeMaterial } from 'three/webgpu'
import { positionLocal } from 'three/tsl'
import earcut from 'earcut'

import { useProjection } from '../gis/CoordinateContext'
import { clipAndSplitRings, normalizeLon, normalizeRing, projectLonLatGPU } from '../gis/projectionGPU'

const DEFAULT_SAMPLE_STEP = 0.2
const Z_OFFSET = 0.025
const LINE_STYLE = { color: '#6dcff6', opacity: 0.5 }
const POINT_STYLE = { color: '#ffffff', size: 0.12 }

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

function collectCoordinates(geometry, collector) {
  if (!geometry) {
    return
  }

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

function appendSampledSegment(linePositions, pointPositions, previous, current, view) {
  const centerLon = view.centerLon ?? 0
  const prevLon = normalizeLon(previous[0], centerLon)
  const currLon = normalizeLon(current[0], centerLon)

  // 正規化後に経度差が大きいセグメントは反経線またぎなのでスキップ
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

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const lon = prevLon + lonDelta * t
    const lat = previous[1] + latDelta * t
    sampledPoints.push([lon, lat])
  }

  for (let index = 1; index < sampledPoints.length; index += 1) {
    const prev = sampledPoints[index - 1]
    const curr = sampledPoints[index]
    linePositions.push(prev[0], prev[1], 0)
    linePositions.push(curr[0], curr[1], 0)
  }

  sampledPoints.forEach((point) => {
    pointPositions.push(point[0], point[1], 0)
  })
}

function triangulateClippedRings(clippedRings) {
  const flatCoords = []
  const holeIndices = []

  clippedRings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) {
      holeIndices.push(flatCoords.length / 2)
    }
    ring.forEach((coord) => {
      flatCoords.push(coord[0], coord[1])
    })
  })

  const indices = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : null, 2)

  const positions = []
  for (let i = 0; i < indices.length; i += 1) {
    const idx = indices[i]
    positions.push(flatCoords[idx * 2], flatCoords[idx * 2 + 1], 0)
  }
  return positions
}

function triangulatePolygon(rings, view) {
  const centerLon = view.centerLon ?? 0

  // 1. normalizeRing でリングを連続化
  const normalizedRings = rings.map((ring) => normalizeRing(ring, centerLon))

  // 2. [centerLon-180, centerLon+180] でクリップし、はみ出し部分をシフト
  const polygonGroups = clipAndSplitRings(normalizedRings, centerLon)

  // 3. 各クリップ結果を三角形分割
  const positions = []
  polygonGroups.forEach((clippedRings) => {
    positions.push(...triangulateClippedRings(clippedRings))
  })

  return positions
}

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

function GeojsonLayer({ url }) {
  const { view, projUniforms, projectionType } = useProjection()
  const [geojson, setGeojson] = useState(null)

  useEffect(() => {
    let ignore = false

    async function loadGeojson() {
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`GeoJSON の読み込みに失敗しました: ${response.status}`)
      }

      const nextGeojson = await response.json()

      if (!ignore) {
        setGeojson(nextGeojson)
      }
    }

    loadGeojson().catch((error) => {
      console.error(error instanceof Error ? error.message : 'GeoJSON の読み込みに失敗しました')
    })

    return () => {
      ignore = true
    }
  }, [url])

  const { lineGeometry, pointGeometry, fillGeometry } = useMemo(() => {
    if (!geojson?.features) {
      return {
        lineGeometry: null,
        pointGeometry: null,
        fillGeometry: null,
      }
    }

    const linePositions = []
    const pointPositions = []

    geojson.features.forEach((feature) => {
      collectCoordinates(feature.geometry, (ring) => {
        for (let index = 1; index < ring.length; index += 1) {
          const previous = ring[index - 1]
          const current = ring[index]

          if (!previous || !current) {
            continue
          }

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

  // GPU 投影用マテリアル: position 属性の lon/lat を positionNode で投影する
  // centerLon 変更時は view が変わり useMemo([geojson, view]) で geometry が再生成される
  const { fillMaterial, lineMaterial, pointMaterial } = useMemo(() => {
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
