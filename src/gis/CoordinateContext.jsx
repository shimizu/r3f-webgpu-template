/* eslint-disable react/no-unknown-property, react/prop-types */
import { createContext, useContext, useMemo } from 'react'
import { createProjectionUniforms } from './projectionUniforms'

const CoordinateContext = createContext(null)

/**
 * 投影コンテキストを子レイヤーに提供するコンポーネント。
 * view と projection を一元管理し、各レイヤーは useProjection() で参照する。
 */
function Coordinate({ projection, view, children, ...groupProps }) {
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
    <group {...groupProps}>
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

export default Coordinate
