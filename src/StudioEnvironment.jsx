import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { PMREMGenerator } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

function StudioEnvironment() {
  const renderer = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)

  useEffect(() => {
    const pmremGenerator = new PMREMGenerator(renderer)
    const environmentScene = new RoomEnvironment()
    const environmentRenderTarget = pmremGenerator.fromScene(environmentScene, 0.05)
    const previousEnvironment = scene.environment

    scene.environment = environmentRenderTarget.texture

    return () => {
      scene.environment = previousEnvironment
      environmentRenderTarget.dispose()
      pmremGenerator.dispose()
    }
  }, [renderer, scene])

  return null
}

export default StudioEnvironment
