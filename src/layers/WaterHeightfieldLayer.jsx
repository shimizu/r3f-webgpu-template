import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { FrontSide } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  color,
  float,
  mix,
  normalLocal,
  positionLocal,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { createWaterSimulation } from '../compute/createWaterSimulation'

// --- マテリアルパラメータ ---
const MATERIAL = {
  transmission: 0.6,
  thickness: 1.8,
  roughness: 0.12,
  ior: 1.333,
  attenuationDistance: 2.5,
  attenuationColor: '#064a3e',
  clearcoat: 0.05,
  clearcoatRoughness: 0.1,
  envMapIntensity: 0.4,
}

const COLORS = {
  shallow: '#48c9b0',
  deep: '#0c5c52',
}

function createWaterMaterial(heightTexture, depth) {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: MATERIAL.transmission,
    thickness: MATERIAL.thickness,
    roughness: MATERIAL.roughness,
    metalness: 0,
    ior: MATERIAL.ior,
    attenuationDistance: MATERIAL.attenuationDistance,
    attenuationColor: MATERIAL.attenuationColor,
    clearcoat: MATERIAL.clearcoat,
    clearcoatRoughness: MATERIAL.clearcoatRoughness,
    side: FrontSide,
    depthWrite: true,
    envMapIntensity: MATERIAL.envMapIntensity,
  })

  // BoxGeometry の上面判定: normalLocal.y が 1 に近い面 = 上面
  // smoothstep で上面のみ波を適用し、側面・底面は変位なし
  const topMask = smoothstep(float(0.5), float(0.9), normalLocal.y)

  // UV でハイトマップをサンプリング
  // BoxGeometry の上面 UV は 0~1 でそのまま使える
  // 側面は UV がずれるが topMask=0 なので影響なし
  const heightTex = texture(heightTexture)
  const info = heightTex

  // 上面のみ Y を変位
  const heightDisp = info.x.mul(2.0).mul(topMask)
  material.positionNode = vec3(
    positionLocal.x,
    positionLocal.y.add(heightDisp),
    positionLocal.z
  )

  // 法線: 上面はハイトマップから再構成、側面はデフォルト法線
  const nx = info.z.mul(8.0)
  const nz = info.w.mul(8.0)
  const ny = float(1.0).sub(nx.mul(nx).add(nz.mul(nz))).max(0.0).sqrt()
  const waveNormal = vec3(nx, ny, nz).normalize()
  // 上面は波法線、側面はローカル法線をそのまま使用
  material.normalNode = mix(normalLocal, waveNormal, topMask)

  // カラー: 上面は高さグラデ、側面は深度グラデ
  const heightFactor = info.x.mul(5.0).add(0.5).clamp(0, 1)
  const topColor = mix(color(COLORS.deep), color(COLORS.shallow), heightFactor)

  // 側面: Y座標で深度グラデーション（上が浅い色、下が深い色）
  const depthFactor = positionLocal.y.add(0.5).clamp(0, 1)
  const sideColor = mix(color(COLORS.deep), color(COLORS.shallow), depthFactor)

  material.colorNode = mix(sideColor, topColor, topMask)

  // 透過度: 側面はやや不透明に
  material.opacityNode = mix(float(0.85), float(0.7), topMask)

  return material
}

function WaterHeightfieldLayer({
  width = 20,
  height = 20,
  depth = 1.5,
  position = [0, 0, 0],
}) {
  const renderer = useThree((state) => state.gl)
  const meshRef = useRef()
  const simRef = useRef(null)
  const materialRef = useRef(null)
  const initializedRef = useRef(false)

  // シミュレーション作成
  const sim = useMemo(() => createWaterSimulation(), [])
  simRef.current = sim

  // マテリアル作成（初回テクスチャで）
  const material = useMemo(() => {
    const mat = createWaterMaterial(sim.currentTexture, depth)
    materialRef.current = mat
    return mat
  }, [sim, depth])

  // 初期化
  useEffect(() => {
    if (!initializedRef.current && renderer) {
      sim.init(renderer)
      initializedRef.current = true
    }

    return () => {
      sim.destroy()
      material.dispose()
    }
  }, [renderer, sim, material])

  // 毎フレーム更新
  useFrame(() => {
    if (!initializedRef.current) return
    sim.update(renderer)
  })

  // クリックで波紋
  const handlePointerDown = (event) => {
    if (!event.uv) return
    // UV 座標をそのままシミュレーション座標に使用 (0~1)
    sim.addDrop(event.uv.x, event.uv.y, 0.03, 0.015)
  }

  return (
    <group position={position}>
      <mesh
        ref={meshRef}
        scale={[width / 2, depth, height / 2]}
        receiveShadow
        castShadow
        onPointerDown={handlePointerDown}
      >
        <boxGeometry args={[2, 1, 2, 200, 1, 200]} />
        <primitive object={material} attach='material' />
      </mesh>
    </group>
  )
}

export default WaterHeightfieldLayer
