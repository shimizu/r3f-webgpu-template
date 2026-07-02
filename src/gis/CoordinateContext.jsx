 
import { createContext, useContext, useMemo } from 'react'
import { createProjectionUniforms } from './projectionUniforms'

const CoordinateContext = createContext(null)

// 投影 XY 平面（x=東, y=北, z=上方向オフセット）→ world XZ 水平面。
// 投影 +y → world -z（北=画面奥）、投影 +z → world +y（高さ）
const DEFAULT_ROTATION = [-Math.PI / 2, 0, 0]

/**
 * 投影コンテキストを子レイヤーに提供するコンポーネント。
 * view と projection を一元管理し、各レイヤーは useProjection() で参照する。
 * デフォルトで投影平面を床面に寝かせる回転を持つ（rotation 指定で上書き可）。
 */
function Coordinate({ projection, view, rotation = DEFAULT_ROTATION, children, ...groupProps }) {
  const viewWithProjection = useMemo(() => ({
    ...view,
    projectionType: projection ?? view.projectionType ?? 'equirectangular',
  }), [view, projection])

  const projUniforms = useMemo(
    () => createProjectionUniforms(viewWithProjection),
    [viewWithProjection]
  )

  const ctx = useMemo(() => ({
    view: viewWithProjection,
    projUniforms,
    projectionType: viewWithProjection.projectionType,
  }), [viewWithProjection, projUniforms])

  return (
    <group rotation={rotation} {...groupProps}>
      <CoordinateContext.Provider value={ctx}>
        {children}
      </CoordinateContext.Provider>
    </group>
  )
}

/**
 * 最も近い <Coordinate> から投影コンテキストを取得するフック。
 * @returns {{ view: Object, projUniforms: Object, projectionType: string }}
 */
export function useProjection() {
  const ctx = useContext(CoordinateContext)
  if (!ctx) {
    throw new Error('useProjection() は <Coordinate> の内部で使用してください')
  }
  return ctx
}

/**
 * useProjection の optional 版。<Coordinate> 外では null を返す（throw しない）。
 * Coordinate の内外どちらでも使えるレイヤー（TerrainLayer 等）のモード判定に使う。
 */
export function useProjectionMaybe() {
  return useContext(CoordinateContext)
}

export default Coordinate
