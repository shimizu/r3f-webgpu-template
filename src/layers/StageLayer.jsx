import { useMemo } from 'react'
import { BufferGeometry, Float32BufferAttribute } from 'three'

const STAGE_WIDTH = 42
const STAGE_HEIGHT = 28
const STAGE_THICKNESS = 1.8
const STAGE_TOP_Z = 0.03
const GRID_STEP = 1
const MAJOR_GRID_STEP = 5

function createGridPositions(step, width, height) {
  const positions = []
  const halfWidth = width * 0.5
  const halfHeight = height * 0.5

  for (let x = -halfWidth; x <= halfWidth + 0.001; x += step) {
    positions.push(x, -halfHeight, STAGE_TOP_Z, x, halfHeight, STAGE_TOP_Z)
  }

  for (let y = -halfHeight; y <= halfHeight + 0.001; y += step) {
    positions.push(-halfWidth, y, STAGE_TOP_Z, halfWidth, y, STAGE_TOP_Z)
  }

  return positions
}

function createTickPositions(width, height) {
  const positions = []
  const halfWidth = width * 0.5
  const halfHeight = height * 0.5

  for (let x = -halfWidth; x <= halfWidth + 0.001; x += GRID_STEP) {
    const tickLength = Math.abs(x % MAJOR_GRID_STEP) < 0.001 ? 0.7 : 0.38
    positions.push(x, -halfHeight, STAGE_TOP_Z, x, -halfHeight - tickLength, STAGE_TOP_Z)
    positions.push(x, halfHeight, STAGE_TOP_Z, x, halfHeight + tickLength, STAGE_TOP_Z)
  }

  for (let y = -halfHeight; y <= halfHeight + 0.001; y += GRID_STEP) {
    const tickLength = Math.abs(y % MAJOR_GRID_STEP) < 0.001 ? 0.7 : 0.38
    positions.push(-halfWidth, y, STAGE_TOP_Z, -halfWidth - tickLength, y, STAGE_TOP_Z)
    positions.push(halfWidth, y, STAGE_TOP_Z, halfWidth + tickLength, y, STAGE_TOP_Z)
  }

  return positions
}

function createLineGeometry(positions) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

function StageLayer() {
  const minorGridGeometry = useMemo(
    () => createLineGeometry(createGridPositions(GRID_STEP, STAGE_WIDTH, STAGE_HEIGHT)),
    []
  )
  const majorGridGeometry = useMemo(
    () =>
      createLineGeometry(createGridPositions(MAJOR_GRID_STEP, STAGE_WIDTH, STAGE_HEIGHT)),
    []
  )
  const tickGeometry = useMemo(
    () => createLineGeometry(createTickPositions(STAGE_WIDTH, STAGE_HEIGHT)),
    []
  )

  return (
    <group>
      <mesh receiveShadow position={[0, 0, -STAGE_THICKNESS * 0.5]}>
        <boxGeometry args={[STAGE_WIDTH + 2.2, STAGE_HEIGHT + 2.2, STAGE_THICKNESS]} />
        <meshStandardMaterial color='#2a3239' roughness={0.8} metalness={0.08} />
      </mesh>

      <mesh receiveShadow position={[0, 0, 0]}>
        <boxGeometry args={[STAGE_WIDTH, STAGE_HEIGHT, 0.06]} />
        <meshStandardMaterial color='#7e8f96' roughness={0.94} metalness={0.04} />
      </mesh>

      <mesh position={[0, 0, STAGE_TOP_Z * 0.5]}>
        <planeGeometry args={[STAGE_WIDTH - 0.7, STAGE_HEIGHT - 0.7]} />
        <meshStandardMaterial
          color='#75909b'
          roughness={0.96}
          metalness={0.02}
          transparent
          opacity={0.96}
        />
      </mesh>

      <lineSegments geometry={minorGridGeometry}>
        <lineBasicMaterial color='#8fb8c6' transparent opacity={0.18} />
      </lineSegments>

      <lineSegments geometry={majorGridGeometry}>
        <lineBasicMaterial color='#d7fbff' transparent opacity={0.34} />
      </lineSegments>

      <lineSegments geometry={tickGeometry}>
        <lineBasicMaterial color='#d4edf1' transparent opacity={0.52} />
      </lineSegments>

      <mesh position={[0, 0, STAGE_TOP_Z + 0.005]}>
        <ringGeometry args={[0.38, 0.48, 48]} />
        <meshBasicMaterial color='#ffffff' transparent opacity={0.4} />
      </mesh>

      <mesh position={[0, 0, STAGE_TOP_Z + 0.006]}>
        <planeGeometry args={[0.9, 0.04]} />
        <meshBasicMaterial color='#ffffff' transparent opacity={0.34} />
      </mesh>
      <mesh position={[0, 0, STAGE_TOP_Z + 0.006]} rotation={[0, 0, Math.PI * 0.5]}>
        <planeGeometry args={[0.9, 0.04]} />
        <meshBasicMaterial color='#ffffff' transparent opacity={0.34} />
      </mesh>
    </group>
  )
}

export default StageLayer
