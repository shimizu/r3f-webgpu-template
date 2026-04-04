import { useEffect, useMemo } from 'react'
import { CubeCamera } from '@react-three/drei'
import { FrontSide } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  cameraPosition,
  color,
  float,
  length,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  time,
  vec2,
  vec3,
} from 'three/tsl'

const DEFAULT_SEGMENTS_X = 64
const DEFAULT_SEGMENTS_Y = 64
const DEFAULT_SEGMENTS_Z = 16

function createWaveHeightNode() {
  const flowNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(0.3).add(time.mul(0.15)),
      positionLocal.y.mul(0.25).sub(time.mul(0.1)),
      0
    )
  ).mul(0.22)
  const secondaryNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(0.5).sub(time.mul(0.12)),
      positionLocal.y.mul(0.4).add(time.mul(0.14)),
      0
    )
  ).mul(0.14)
  const detailNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(1.2).add(time.mul(0.22)),
      positionLocal.y.mul(0.9).sub(time.mul(0.18)),
      0
    )
  ).mul(0.06)

  const longWave = positionLocal.y
    .mul(1.35)
    .add(positionLocal.x.mul(0.35))
    .sub(time.mul(1.1))
    .sin()
    .mul(0.2)

  const diagonalWave = positionLocal.x
    .mul(1.05)
    .sub(positionLocal.y.mul(0.82))
    .add(time.mul(0.9))
    .sin()
    .mul(0.12)

  return flowNoise.add(secondaryNoise).add(detailNoise).add(longWave).add(diagonalWave)
}

function createWaterBodyMaterial(environmentMap, { width, height, depth }) {
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    transmission: 0.4,
    thickness: 3.5,
    roughness: 0.15,
    metalness: 0,
    ior: 1.333,
    attenuationDistance: 0.8,
    attenuationColor: '#040e14',
    clearcoat: 0.3,
    clearcoatRoughness: 0.05,
    side: FrontSide,
    depthWrite: true,
    envMap: environmentMap,
    envMapIntensity: 1.2,
  })

  const waveHeight = createWaveHeightNode()

  const depthTint = smoothstep(
    float(-depth * 0.5),
    float(depth * 0.5),
    positionLocal.z
  )
  const topMask = smoothstep(
    float(depth * 0.1),
    float(depth * 0.5),
    positionLocal.z
  )
  const edgeDistance = length(
    vec2(
      positionLocal.x.div(float(width * 0.5)),
      positionLocal.y.div(float(height * 0.5))
    )
  )
  const edgeFade = smoothstep(float(0.78), float(1.0), edgeDistance).oneMinus()

  const sideMask = normalLocal.z.abs().oneMinus().pow(3)
  const sideNoise = mx_noise_float(
    positionWorld.mul(vec3(0.42, 0.42, 0.68)).add(vec3(time.mul(0.18), time.mul(-0.12), 0))
  ).mul(0.55)
  const sideBands = positionLocal.z
    .mul(2.8)
    .add(positionLocal.y.mul(0.65))
    .sub(time.mul(1.35))
    .sin()
    .mul(0.5)
    .add(0.5)
  const sideRipple = sideNoise.add(sideBands).mul(sideMask)

  const topDisplacement = waveHeight.mul(topMask).mul(edgeFade).mul(0.85)

  const waveShade = smoothstep(float(-0.08), float(0.08), waveHeight)

  const glintNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(0.48).add(time.mul(0.16)),
      positionLocal.y.mul(0.44).sub(time.mul(0.12)),
      0
    )
  )
  const glintBandsA = positionLocal.x
    .mul(3.2)
    .add(positionLocal.y.mul(2.4))
    .sub(time.mul(2.4))
    .add(glintNoise.mul(5))
    .sin()
    .abs()
  const glintBandsB = positionLocal.x
    .mul(-2.1)
    .add(positionLocal.y.mul(2.9))
    .add(time.mul(1.8))
    .add(waveHeight.mul(6))
    .sin()
    .abs()
  const topGlint = glintBandsA
    .mul(glintBandsB)
    .smoothstep(float(0.28), float(0.78))
    .mul(topMask)
    .mul(edgeFade)

  // フェイクコースティクス: Voronoi 風のノイズ2層を交差させて集光パターンを生成
  const causticA = mx_noise_float(
    vec3(
      positionLocal.x.mul(1.8).add(time.mul(0.2)),
      positionLocal.y.mul(1.6).sub(time.mul(0.15)),
      0
    )
  ).sin().abs()
  const causticB = mx_noise_float(
    vec3(
      positionLocal.x.mul(-1.4).add(time.mul(0.12)),
      positionLocal.y.mul(2.1).add(time.mul(0.18)),
      0
    )
  ).sin().abs()
  const causticPattern = causticA.mul(causticB)
    .smoothstep(float(0.15), float(0.7))
  // コースティクスは底面〜中層で強く、上面では弱い
  const causticDepthMask = depthTint.oneMinus().smoothstep(float(0.1), float(0.6))
  const causticIntensity = causticPattern.mul(causticDepthMask).mul(0.35)

  // ホワイトウォーター: 波頭が高い部分に白い泡を乗せる
  const foamThreshold = waveHeight.smoothstep(float(0.18), float(0.35))
  const foamNoise = mx_noise_float(
    vec3(
      positionLocal.x.mul(2.5).add(time.mul(0.3)),
      positionLocal.y.mul(2.2).sub(time.mul(0.25)),
      0
    )
  ).mul(0.5).add(0.5)
  const foam = foamThreshold.mul(foamNoise).mul(topMask).mul(edgeFade)

  // 水面カラー: 落ち着いた暗めの水色
  const surfaceColor = mix(color('#85c1bf'), color('#4393a8'), waveShade.mul(0.6))
  const topColor = mix(surfaceColor, color('#03411d'), topGlint.mul(0.25))
  // 上面にホワイトウォーターを加算
  const topWithFoam = mix(topColor, color('#d8eef2'), foam.mul(0.6))

  // 側面カラー: 深度に応じた吸収（暗め）+ コースティクス
  const sideShallow = color('#4f97b6')
  const sideDeep = color('#418cbe')
  const sideColor = mix(sideDeep, sideShallow, depthTint.mul(0.85))
  const sideWithCaustic = mix(sideColor, color('#8cd4e8'), causticIntensity)
  const sideWithRipple = mix(sideWithCaustic, color('#7f5dac'), sideRipple.mul(0.08))

  const finalColor = mix(sideWithRipple, topWithFoam, topMask.mul(0.9))

  // フレネル: 浅い角度で反射、正面から透明
  const viewDirection = cameraPosition.sub(positionWorld).normalize()
  const fresnel = normalWorld
    .dot(viewDirection)
    .abs()
    .oneMinus()
    .pow(2.5)
  const topReflectivity = fresnel
    .mul(0.45)
    .add(topGlint.mul(0.2))
    .mul(topMask)
  const reflectiveColor = mix(finalColor, color('#8ecfdf'), topReflectivity)

  // 透過度: 濁った水 — 全体的に不透明寄り
  const bodyOpacity = mix(float(0.82), float(0.95), sideMask.mul(0.9))
  const topOpacity = mix(float(0.75), float(0.9), fresnel)
  const finalOpacity = mix(topOpacity, bodyOpacity, sideMask.mul(0.8).add(topMask.oneMinus().mul(0.6)))

  material.positionNode = positionLocal.add(vec3(0, 0, topDisplacement))
  material.colorNode = reflectiveColor
  material.normalNode = normalLocal.add(
    vec3(
      topDisplacement.mul(3.5),
      topDisplacement.mul(2.8),
      float(1)
    )
  ).normalize()
  material.opacityNode = finalOpacity
  material.attenuationColorNode = mix(color('#1a5a70'), color('#021828'), depthTint.mul(0.9))

  return material
}

function WaterBoxLayer({
  width = 6,
  height = 6,
  depth = 1.5,
  position = [0, 0, 0],
  segments = [DEFAULT_SEGMENTS_X, DEFAULT_SEGMENTS_Y, DEFAULT_SEGMENTS_Z],
}) {
  return (
    <CubeCamera frames={1} resolution={256} position={position}>
      {(environmentMap) => (
        <WaterBoxMesh
          environmentMap={environmentMap}
          width={width}
          height={height}
          depth={depth}
          position={position}
          segments={segments}
        />
      )}
    </CubeCamera>
  )
}

function WaterBoxMesh({ environmentMap, width, height, depth, position, segments }) {
  const bodyMaterial = useMemo(
    () => createWaterBodyMaterial(environmentMap, { width, height, depth }),
    [environmentMap, width, height, depth]
  )

  useEffect(() => {
    return () => {
      bodyMaterial.dispose()
    }
  }, [bodyMaterial])

  return (
    <mesh castShadow receiveShadow position={position}>
      <boxGeometry args={[width, height, depth, ...segments]} />
      <primitive object={bodyMaterial} attach='material' />
    </mesh>
  )
}

export default WaterBoxLayer
