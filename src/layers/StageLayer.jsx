import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Matrix4 } from 'three'

function createTileData(columns, rows, tileSize) {
  const bright = new Color('#8f8f8f')
  const dark = new Color('#7b7b7b')

  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)

    return {
      position: [
        (column - (columns - 1) * 0.5) * tileSize,
        0.005,
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
    <group>
      <mesh receiveShadow position={[0, -0.65, 0]}>
        <boxGeometry args={[floorWidth + 0.8, 1.3, floorHeight + 0.8]} />
        <meshStandardMaterial color='#757575' roughness={0.86} metalness={0.02} />
      </mesh>

      <instancedMesh
        ref={tileMeshRef}
        args={[null, null, columns * rows]}
        receiveShadow
      >
        <boxGeometry args={[tileSize, 0.02, tileSize]} />
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
    </group>
  )
}

export default StageLayer
