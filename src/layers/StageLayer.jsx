import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Matrix4 } from 'three'

const TILE_COLORS = { bright: '#8f8f8f', dark: '#7b7b7b' }
const TILE_Y_OFFSET = 0.005
const TILE_HEIGHT = 0.02
const TILE_MATERIAL = {
  color: '#8a8a8a',
  roughness: 0.3,
  metalness: 0,
  clearcoat: 0.44,
  clearcoatRoughness: 0.12,
  reflectivity: 0.8,
}

const BASE = { color: '#757575', yOffset: -0.65, padding: 0.8, height: 1.3 }
const BASE_MATERIAL = { roughness: 0.86, metalness: 0.02 }

function createTileData(columns, rows, tileSize) {
  const bright = new Color(TILE_COLORS.bright)
  const dark = new Color(TILE_COLORS.dark)

  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)

    return {
      position: [
        (column - (columns - 1) * 0.5) * tileSize,
        TILE_Y_OFFSET,
        (row - (rows - 1) * 0.5) * tileSize,
      ],
      color: (column + row) % 2 === 0 ? bright.clone() : dark.clone(),
    }
  })
}

function StageLayer({
  columns = 16,
  rows = 10,
  tileSize = 2.2,
  position = [0, 0, 0],
}) {
  const tileMeshRef = useRef(null)
  const floorWidth = columns * tileSize
  const floorHeight = rows * tileSize
  const tileData = useMemo(() => createTileData(columns, rows, tileSize), [columns, rows, tileSize])

  useLayoutEffect(() => {
    const mesh = tileMeshRef.current
    const matrix = new Matrix4()

    if (!mesh) {
      return
    }

    tileData.forEach((tile, index) => {
      matrix.makeTranslation(tile.position[0], tile.position[1], tile.position[2])
      mesh.setMatrixAt(index, matrix)
      mesh.setColorAt(index, tile.color)
    })

    mesh.instanceMatrix.needsUpdate = true

    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
    }
  }, [tileData])

  return (
    <group position={position}>
      <mesh receiveShadow position={[0, BASE.yOffset, 0]}>
        <boxGeometry args={[floorWidth + BASE.padding, BASE.height, floorHeight + BASE.padding]} />
        <meshStandardMaterial color={BASE.color} roughness={BASE_MATERIAL.roughness} metalness={BASE_MATERIAL.metalness} />
      </mesh>

      <instancedMesh
        ref={tileMeshRef}
        args={[null, null, columns * rows]}
        receiveShadow
      >
        <boxGeometry args={[tileSize, TILE_HEIGHT, tileSize]} />
        <meshPhysicalMaterial
          vertexColors
          color={TILE_MATERIAL.color}
          roughness={TILE_MATERIAL.roughness}
          metalness={TILE_MATERIAL.metalness}
          clearcoat={TILE_MATERIAL.clearcoat}
          clearcoatRoughness={TILE_MATERIAL.clearcoatRoughness}
          reflectivity={TILE_MATERIAL.reflectivity}
        />
      </instancedMesh>
    </group>
  )
}

export default StageLayer
