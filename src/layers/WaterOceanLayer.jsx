import { useEffect, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { TextureLoader, RepeatWrapping, PlaneGeometry, Vector3 } from 'three'
import { WaterMesh } from 'three/addons/objects/WaterMesh.js'

const WATER_CONFIG = {
  textureWidth: 512,
  textureHeight: 512,
  waterColor: 0x001e0f,
  sunColor: 0xffffff,
  sunDirection: new Vector3(0.70707, 0.70707, 0.0),
  distortionScale: 3.7,
  size: 1.0,
  alpha: 1.0,
  resolutionScale: 0.5,
}

function WaterOceanLayer({
  width = 200,
  height = 200,
  position = [0, 0, 0],
  rotation = [-Math.PI / 2, 0, 0],
  sunDirection,
  sunColor,
  waterColor,
  distortionScale,
  size,
  alpha,
}) {
  const waterRef = useRef()
  const waterNormals = useLoader(TextureLoader, '/textures/waternormals.jpg')

  useEffect(() => {
    waterNormals.wrapS = RepeatWrapping
    waterNormals.wrapT = RepeatWrapping
  }, [waterNormals])

  useEffect(() => {
    if (!waterRef.current) return

    const geometry = new PlaneGeometry(width, height)
    const water = new WaterMesh(geometry, {
      waterNormals,
      sunDirection: sunDirection || WATER_CONFIG.sunDirection,
      sunColor: sunColor ?? WATER_CONFIG.sunColor,
      waterColor: waterColor ?? WATER_CONFIG.waterColor,
      distortionScale: distortionScale ?? WATER_CONFIG.distortionScale,
      size: size ?? WATER_CONFIG.size,
      alpha: alpha ?? WATER_CONFIG.alpha,
      resolutionScale: WATER_CONFIG.resolutionScale,
    })

    water.position.set(...position)
    water.rotation.set(...rotation)

    const parent = waterRef.current
    parent.add(water)

    // waterRef に WaterMesh インスタンスを保持（useFrame で参照）
    parent.userData.water = water

    return () => {
      parent.remove(water)
      geometry.dispose()
      water.material.dispose()
      parent.userData.water = null
    }
  }, [waterNormals, width, height, position, rotation, sunDirection, sunColor, waterColor, distortionScale, size, alpha])

  // WaterMesh は time uniform を自動更新しないので毎フレーム不要
  // （WaterMesh 内で TSL の time ノードを使っているため自動更新される）

  return <group ref={waterRef} />
}

export default WaterOceanLayer
