/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Color, Float32BufferAttribute } from 'three'
import earcut from 'earcut'

import { projectLonLatToWorld } from '../gis/projection'

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
  const lonDelta = current[0] - previous[0]
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
    const lon = previous[0] + lonDelta * t
    const lat = previous[1] + latDelta * t
    sampledPoints.push(projectLonLatToWorld([lon, lat], view))
  }

  for (let index = 1; index < sampledPoints.length; index += 1) {
    const previousPoint = sampledPoints[index - 1]
    const currentPoint = sampledPoints[index]

    linePositions.push(previousPoint[0], previousPoint[1], previousPoint[2])
    linePositions.push(currentPoint[0], currentPoint[1], currentPoint[2])
  }

  sampledPoints.forEach((point) => {
    pointPositions.push(point[0], point[1], point[2])
  })
}

function triangulatePolygon(rings, view) {
  const projectedRings = rings.map((ring) =>
    ring.map((coord) => projectLonLatToWorld(coord, view))
  )

  const flatCoords = []
  const holeIndices = []

  projectedRings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) {
      holeIndices.push(flatCoords.length / 2)
    }
    ring.forEach((point) => {
      flatCoords.push(point[0], point[1])
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

function GeojsonLayer({ url, view }) {
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

  useEffect(() => {
    return () => {
      lineGeometry?.dispose()
      pointGeometry?.dispose()
      fillGeometry?.dispose()
    }
  }, [lineGeometry, pointGeometry, fillGeometry])

  if (!lineGeometry || !pointGeometry || !fillGeometry) {
    return null
  }

  return (
    <group position={[0, 0, Z_OFFSET]}>
      <mesh geometry={fillGeometry}>
        <meshBasicMaterial vertexColors transparent opacity={FILL_OPACITY} />
      </mesh>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color={LINE_STYLE.color} transparent opacity={LINE_STYLE.opacity} />
      </lineSegments>
      <points geometry={pointGeometry}>
        <pointsMaterial color={POINT_STYLE.color} size={POINT_STYLE.size} sizeAttenuation />
      </points>
    </group>
  )
}

export default GeojsonLayer
