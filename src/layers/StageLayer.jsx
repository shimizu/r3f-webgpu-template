import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Matrix4 } from 'three'

const FLOOR_COLUMNS = 16
const FLOOR_ROWS = 10
const TILE_SIZE = 2.2
const FLOOR_WIDTH = FLOOR_COLUMNS * TILE_SIZE
const FLOOR_HEIGHT = FLOOR_ROWS * TILE_SIZE

function createTileData() {
  const bright = new Color('#8f8f8f')
  const dark = new Color('#7b7b7b')

  return Array.from({ length: FLOOR_COLUMNS * FLOOR_ROWS }, (_, index) => {
    const column = index % FLOOR_COLUMNS
    const row = Math.floor(index / FLOOR_COLUMNS)

    return {
      position: [
        (column - (FLOOR_COLUMNS - 1) * 0.5) * TILE_SIZE,
        (row - (FLOOR_ROWS - 1) * 0.5) * TILE_SIZE,
        0.005,
      ],
      color: (column + row) % 2 === 0 ? bright.clone() : dark.clone(),
    }
  })
}

function StageLayer() {
  const tileMeshRef = useRef(null)
  const tileData = useMemo(() => createTileData(), [])

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
    <group>
      <mesh receiveShadow position={[0, 0, -0.65]}>
        <boxGeometry args={[FLOOR_WIDTH + 0.8, FLOOR_HEIGHT + 0.8, 1.3]} />
        <meshStandardMaterial color='#757575' roughness={0.86} metalness={0.02} />
      </mesh>

      <instancedMesh
        ref={tileMeshRef}
        args={[null, null, FLOOR_COLUMNS * FLOOR_ROWS]}
        receiveShadow
      >
        <boxGeometry args={[TILE_SIZE, TILE_SIZE, 0.02]} />
        <meshPhysicalMaterial
          vertexColors
          color='#8a8a8a'
          roughness={0.3}
          metalness={0}
          clearcoat={0.44}
          clearcoatRoughness={0.12}
          reflectivity={0.8}
        />
      </instancedMesh>

      <mesh receiveShadow position={[0, 0, -0.01]}>
        <planeGeometry args={[FLOOR_WIDTH, FLOOR_HEIGHT]} />
        <shadowMaterial transparent opacity={0.28} />
      </mesh>

      <mesh position={[0, FLOOR_HEIGHT * 0.5 - 0.4, 4.6]} rotation={[Math.PI * 0.5, 0, 0]}>
        <planeGeometry args={[FLOOR_WIDTH + 16, 10]} />
        <meshStandardMaterial color='#666666' roughness={0.98} metalness={0.02} />
      </mesh>
    </group>
  )
}

export default StageLayer
