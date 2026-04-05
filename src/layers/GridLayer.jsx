/* eslint-disable react/no-unknown-property, react/prop-types */
import { useMemo } from 'react'
import { PlaneGeometry } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  abs,
  color,
  float,
  fract,
  max,
  min,
  mix,
  positionWorld,
  smoothstep,
} from 'three/tsl'

// ============================================================
// 調整用パラメータ
// ============================================================
const GRID_DEFAULTS = {
  size: 200,              // 平面のサイズ
  gridScale: 1.0,         // メイングリッド間隔（ワールド単位）
  subGridScale: 0.2,      // サブグリッド間隔
  lineWidth: 0.02,        // メインライン幅
  subLineWidth: 0.01,     // サブライン幅
  baseColor: '#2a6e3f',   // 工作シートの緑
  lineColor: '#ffffff',   // グリッド線の色
  lineOpacity: 0.3,       // メインラインの不透明度
  subLineOpacity: 0.15,   // サブラインの不透明度
}

function createGridMaterial(options = {}) {
  const {
    gridScale = GRID_DEFAULTS.gridScale,
    subGridScale = GRID_DEFAULTS.subGridScale,
    lineWidth = GRID_DEFAULTS.lineWidth,
    subLineWidth = GRID_DEFAULTS.subLineWidth,
    baseColor = GRID_DEFAULTS.baseColor,
    lineColor = GRID_DEFAULTS.lineColor,
    lineOpacity = GRID_DEFAULTS.lineOpacity,
    subLineOpacity = GRID_DEFAULTS.subLineOpacity,
  } = options

  const material = new MeshPhysicalNodeMaterial({
    roughness: 0.95,
    metalness: 0,
  })

  // ワールド座標の XZ を使ってグリッド線を生成
  const wx = positionWorld.x
  const wz = positionWorld.z

  // サブグリッド: fract → 中心からの距離 → smoothstep で線
  const subFracX = abs(fract(wx.div(subGridScale)).sub(0.5))
  const subFracZ = abs(fract(wz.div(subGridScale)).sub(0.5))
  const subHalfWidth = float(subLineWidth / subGridScale / 2)
  const subLineX = smoothstep(subHalfWidth.add(0.01), subHalfWidth, subFracX)
  const subLineZ = smoothstep(subHalfWidth.add(0.01), subHalfWidth, subFracZ)
  const subLine = max(subLineX, subLineZ).mul(subLineOpacity)

  // メイングリッド: 同様のパターン
  const mainFracX = abs(fract(wx.div(gridScale)).sub(0.5))
  const mainFracZ = abs(fract(wz.div(gridScale)).sub(0.5))
  const mainHalfWidth = float(lineWidth / gridScale / 2)
  const mainLineX = smoothstep(mainHalfWidth.add(0.01), mainHalfWidth, mainFracX)
  const mainLineZ = smoothstep(mainHalfWidth.add(0.01), mainHalfWidth, mainFracZ)
  const mainLine = max(mainLineX, mainLineZ).mul(lineOpacity)

  // 合成: サブとメインの強い方を採用
  const lineMask = max(subLine, mainLine)

  // ベースカラーにライン色を混合
  material.colorNode = mix(color(baseColor), color(lineColor), lineMask)

  return material
}

function GridLayer({
  size = GRID_DEFAULTS.size,
  position = [0, 0, 0],
  ...materialOptions
}) {
  const geometry = useMemo(() => {
    const geo = new PlaneGeometry(size, size)
    geo.rotateX(-Math.PI / 2) // XZ 平面に寝かせる
    return geo
  }, [size])

  const material = useMemo(() => createGridMaterial(materialOptions), [])

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={position}
      receiveShadow
    />
  )
}

export default GridLayer
