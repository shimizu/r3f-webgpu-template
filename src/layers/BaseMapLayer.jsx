/* eslint-disable react/no-unknown-property, react/prop-types */
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Float32BufferAttribute } from 'three'

import { projectLonLatToWorld } from '../gis/projection'

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

function isWithinViewport([lon, lat], view) {
  return (
    Math.abs(lon - view.centerLon) <= view.extentLon &&
    Math.abs(lat - view.centerLat) <= view.extentLat
  )
}

function appendSampledSegment(linePositions, pointPositions, previous, current, view) {
  const lonDelta = current[0] - previous[0]
  const latDelta = current[1] - previous[1]
  const steps = Math.max(
    1,
    Math.ceil(
      Math.max(Math.abs(lonDelta) / view.sampleLonStep, Math.abs(latDelta) / view.sampleLatStep)
    )
  )
  const sampledPoints = []

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const lon = previous[0] + lonDelta * t
    const lat = previous[1] + latDelta * t
    const sampledPoint = [lon, lat]

    if (isWithinViewport(sampledPoint, view)) {
      sampledPoints.push(projectLonLatToWorld(sampledPoint, view))
    }
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

function BaseMapLayer({ url, view }) {
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

  const { lineGeometry, pointGeometry } = useMemo(() => {
    if (!geojson?.features) {
      return {
        lineGeometry: null,
        pointGeometry: null,
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

    return { lineGeometry, pointGeometry }
  }, [geojson, view])

  useEffect(() => {
    return () => {
      lineGeometry?.dispose()
      pointGeometry?.dispose()
    }
  }, [lineGeometry, pointGeometry])

  if (!lineGeometry || !pointGeometry) {
    return null
  }

  return (
    <group position={[0, 0.025, 0]}>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color='#9fe7ff' transparent opacity={0.95} />
      </lineSegments>
      <points geometry={pointGeometry}>
        <pointsMaterial color='#ffffff' size={0.08} sizeAttenuation />
      </points>
    </group>
  )
}

export default BaseMapLayer
