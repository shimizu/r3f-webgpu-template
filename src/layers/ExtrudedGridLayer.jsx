import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, Matrix4, Quaternion, Vector3 } from 'three'

const GRID_COLUMNS = 18
const GRID_ROWS = 12
const INSTANCE_COUNT = GRID_COLUMNS * GRID_ROWS
const CELL_SIZE = 1.25
const BASE_HEIGHT = 0.06
const HEIGHT_SCALE = 4.6

function hash01(value) {
  const x = Math.sin(value * 127.1) * 43758.5453123
  return x - Math.floor(x)
}

function createInstanceData() {
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  const matrix = new Matrix4()
  const warmColor = new Color('#ffd08a')
  const hotColor = new Color('#ff6f2f')

  return Array.from({ length: INSTANCE_COUNT }, (_, index) => {
    const column = index % GRID_COLUMNS
    const row = Math.floor(index / GRID_COLUMNS)
    const centeredColumn = column - (GRID_COLUMNS - 1) * 0.5
    const centeredRow = row - (GRID_ROWS - 1) * 0.5
    const radial =
      1 -
      Math.min(
        1,
        Math.sqrt(centeredColumn ** 2 + centeredRow ** 2) /
          Math.sqrt((GRID_COLUMNS * 0.5) ** 2 + (GRID_ROWS * 0.5) ** 2)
      )
    const noise = hash01(column * 0.91 + row * 1.73)
    const ridge = Math.max(
      0,
      Math.sin((column + 1) * 0.52) * Math.cos((row + 2) * 0.43)
    )
    const height =
      BASE_HEIGHT + (radial * 0.55 + noise * 0.2 + ridge * 0.25) * HEIGHT_SCALE

    position.set(
      centeredColumn * CELL_SIZE,
      centeredRow * CELL_SIZE,
      height * 0.5 + 0.08
    )
    scale.set(0.82, 0.82, height)
    matrix.compose(position, quaternion, scale)

    return {
      matrix: matrix.clone(),
      color: warmColor.clone().lerp(hotColor, Math.min(1, height / HEIGHT_SCALE)),
    }
  })
}

function ExtrudedGridLayer() {
  const meshRef = useRef(null)
  const instances = useMemo(() => createInstanceData(), [])

  useLayoutEffect(() => {
    const mesh = meshRef.current

    if (!mesh) {
      return
    }

    for (let index = 0; index < instances.length; index += 1) {
      mesh.setMatrixAt(index, instances[index].matrix)
      mesh.setColorAt(index, instances[index].color)
    }

    mesh.instanceMatrix.needsUpdate = true

    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
    }
  }, [instances])

  return (
    <instancedMesh ref={meshRef} args={[null, null, INSTANCE_COUNT]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        vertexColors
        color='#ffb761'
        roughness={0.36}
        metalness={0.16}
        emissive='#8f3b12'
        emissiveIntensity={0.22}
      />
    </instancedMesh>
  )
}

export default ExtrudedGridLayer
