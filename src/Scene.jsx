/* eslint-disable react/no-unknown-property, react/prop-types */
/*
  このファイルの処理の流れ

  1. createParticleSeed(...)
     粒子の初期座標を「正方形グリッド」として作る。

  2. ParticlesFromCompute
     gridSize から粒子配列と粒サイズを決め、
     createBarsComputeRunner(...) で WebGPU compute 用の更新システムを作る。
     描画は points ではなく、billboard 化したインスタンス quad で行う。

  3. useEffect
     three.js / WebGPU の geometry, material, compute system を初期化し、
     コンポーネント破棄時には dispose / destroy で後始末する。

  4. useFrame
     毎フレーム current time と delta time を compute に渡して、
     GPU 側で位置・速度・寿命を更新する。

  5. Scene
     背景、ライト、グリッド、カメラ操作、HUD、粒子描画をまとめて
     Canvas 内の 3D シーンとして組み立てる。

  つまりこのファイルは、
  「粒子の元データを作る」
  「GPU で毎フレーム動かす」
  「その結果をサイズ変更可能な quad パーティクルとして描画する」
  という 3 段階を React Three Fiber 上でつないでいる。
*/
import { Html, OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Color, DoubleSide, InstancedMesh, Matrix4, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { billboarding, instanceIndex, shapeCircle } from 'three/tsl'

import { createBarsComputeRunner } from './compute/runBarsCompute'

const PARTICLE_SIZE = 0.018

function hash01(value) {
  const x = Math.sin(value * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function createParticleColor(index, count) {
  const base = index / Math.max(count, 1)
  const hue = hash01(base * 97.13 + index * 0.0017)
  const saturation = 0.45 + hash01(base * 53.71 + 11.3) * 0.5
  const lightness = 0.38 + hash01(base * 71.91 + 29.8) * 0.34

  return new Color().setHSL(hue, saturation, lightness)
}

// 粒子を最初に並べるための座標配列を作る。
// 今回は x-z 平面に正方形グリッドで並べ、y は 0 にそろえている。
// 返り値は [x, y, z, x, y, z, ...] という three.js の一般的な形式。
function createParticleSeed(gridSize, spacing) {
  const particleCount = gridSize * gridSize
  const positions = new Float32Array(particleCount * 3)
  const half = (gridSize - 1) / 2

  // 2 重ループで「横方向 x」「奥行き z」を走査して、
  // 1 粒ずつ位置を書き込む。
  for (let z = 0; z < gridSize; z += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const index = z * gridSize + x
      const baseIndex = index * 3

      // グリッド全体が原点まわりに来るように half を引いて中心合わせしている。
      positions[baseIndex] = (x - half) * spacing
      positions[baseIndex + 1] = 0
      positions[baseIndex + 2] = (z - half) * spacing
    }
  }

  return positions
}

function PerformanceHud({ particleCount }) {
  const [fps, setFps] = useState(0)
  const sampleRef = useRef({
    frames: 0,
    elapsed: 0,
  })

  // useFrame は毎フレーム呼ばれる。
  // delta は「前フレームから何秒経過したか」なので、
  // 一定時間ぶん集計して FPS をざっくり計算している。
  useFrame((_, delta) => {
    sampleRef.current.frames += 1
    sampleRef.current.elapsed += delta

    // 毎フレーム setState すると無駄が増えるので、
    // 0.25 秒ごとにまとめて更新している。
    if (sampleRef.current.elapsed >= 0.25) {
      setFps(Math.round(sampleRef.current.frames / sampleRef.current.elapsed))
      sampleRef.current.frames = 0
      sampleRef.current.elapsed = 0
    }
  })

  return (
    <Html prepend>
      <div className='stats-panel'>
        <span>{particleCount.toLocaleString()} particles</span>
        <span>{fps} FPS</span>
      </div>
    </Html>
  )
}

function ParticlesFromCompute({ gridSize }) {
  // useThree で R3F 管理下の renderer を取得する。
  // このプロジェクトでは WebGPURenderer を App.jsx 側で渡している。
  const renderer = useThree((state) => state.gl)

  // systemRef には compute の実行オブジェクトを保持する。
  // 毎回再レンダーで作り直さず、フレーム更新から参照できるように ref を使う。
  const systemRef = useRef(null)
  const mountedRef = useRef(false)

  // gridSize が変わったときだけ、粒子の初期座標を再計算する。
  // useMemo にしているのは、通常の再レンダーで毎回大きな Float32Array を
  // 作り直さないため。
  const { particleSeed, particleSize } = useMemo(() => {
    // 粒子数が増えるほど見た目が詰まるので、グリッド間隔を少し自動調整する。
    const spacing = Math.max(0.045, 5 / gridSize)

    return {
      particleSeed: createParticleSeed(gridSize, spacing),
      particleSize: PARTICLE_SIZE,
    }
  }, [gridSize])

  // three.js / WebGPU のリソース生成は失敗する可能性があるので、
  // try/catch でメッセージ化して UI 全体が落ちないようにしている。
  const { resourceError, resources } = useMemo(() => {
    try {
      // createBarsComputeRunner は、粒子の位置・速度・寿命を
      // GPU 側で更新する compute システムをまとめたヘルパー。
      const system = createBarsComputeRunner(particleSeed)
      const geometry = new PlaneGeometry(particleSize, particleSize, 1, 1)
      const material = new MeshBasicNodeMaterial({
        color: '#ffffff',
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      })
      const mesh = new InstancedMesh(geometry, material, system.particleCount)
      const identityMatrix = new Matrix4()

      // InstancedMesh は instance 行列を前提にしているので、
      // 初期状態として全インスタンスを単位行列にしておく。
      for (let index = 0; index < system.particleCount; index += 1) {
        mesh.setMatrixAt(index, identityMatrix)
        mesh.setColorAt(index, createParticleColor(index, system.particleCount))
      }

      // compute が更新する位置バッファを、各インスタンスのワールド位置として参照する。
      // billboarding(...) を使うことで quad が常にカメラを向く。
      material.vertexNode = billboarding({
        position: system.positionNode.element(instanceIndex),
        horizontal: true,
        vertical: true,
      })

      // quad の UV から円形の alpha を作り、四角い板ポリ感を消す。
      material.opacityNode = shapeCircle()
      material.alphaTest = 0.5

      // 動く粒子群は GPU 側で位置が毎フレーム変わるので、
      // バウンディング依存のカリングは切っておく。
      mesh.frustumCulled = false

      return {
        resourceError: null,
        resources: { geometry, material, mesh, system },
      }
    } catch (computeError) {
      return {
        resourceError:
          computeError instanceof Error
            ? computeError.message
            : 'compute 実行中に不明なエラーが発生しました',
        resources: null,
      }
    }
  }, [particleSeed, particleSize])

  // geometry / material / compute system がそろったら初期化する。
  // ここは「React の見た目を作る処理」というより、
  // three.js の外部リソースをセットアップして破棄するライフサイクル管理。
  useEffect(() => {
    if (!resources) {
      return undefined
    }

    mountedRef.current = true

    try {
      // 初回 compute を走らせて GPU 側のバッファを準備する。
      resources.system.init(renderer)
      systemRef.current = resources.system
    } catch (computeError) {
      console.error(
        computeError instanceof Error
          ? computeError.message
          : 'compute 実行中に不明なエラーが発生しました'
      )
    }

    return () => {
      mountedRef.current = false

      // gridSize 切り替えやアンマウント時に GPU リソースを明示的に破棄する。
      // three.js では dispose を忘れるとメモリリークの原因になりやすい。
      resources.geometry.dispose()
      resources.material.dispose()
      resources.system.destroy()
      systemRef.current = null
    }
  }, [renderer, resources])

  // 毎フレーム、現在時刻と delta time を compute に渡して
  // 粒子の位置・速度・寿命を更新する。
  // ここでは React の state は使わず、GPU 計算だけを進めているので軽い。
  useFrame((state, delta) => {
    const system = systemRef.current

    if (!system) {
      return
    }

    system.update(renderer, state.clock.elapsedTime, delta)
  })

  if (resourceError) {
    console.error(resourceError)
    return null
  }

  // 描画は points ではなく、インスタンス化した quad を billboard 表示している。
  // これで compute 駆動のまま、粒子サイズや色を material 側で制御できる。
  return <primitive object={resources.mesh} />
}

function Scene({ gridSize }) {
  // UI 側では gridSize だけを持ち、
  // 実際の総粒子数は Scene 側で計算して HUD に表示している。
  const particleCount = gridSize * gridSize

  return (
    <>
      {/* 背景色と fog をそろえて、遠景が自然に消えるようにしている。 */}
      <color attach='background' args={['#04070d']} />
      <fog attach='fog' args={['#04070d', 3.5, 8]} />

      {/* 最低限の環境光と主光源。粒子は点描画だが、補助オブジェクトの見え方に効く。 */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 4]} intensity={1.5} color='#b5d8ff' />

      {/* 地面の目安としてグリッドを置き、カメラ操作は OrbitControls に任せる。 */}
      <gridHelper args={[8, 16, '#1b3a52', '#11202f']} position={[0, -0.35, 0]} />
      <OrbitControls enableDamping />

      {/* HTML ベースの HUD と、GPU compute で更新される粒子本体。 */}
      <PerformanceHud particleCount={particleCount} />
      <ParticlesFromCompute key={gridSize} gridSize={gridSize} />
    </>
  )
}

export default Scene
