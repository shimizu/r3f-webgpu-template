import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { AdditiveBlending, DoubleSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  uniform,
  vec4,
} from 'three/tsl'

import { useHeightField } from '../gis/HeightFieldContext'
import { cpuHeightAt } from '../tsl/sampleHeightField'

/*
  稲妻レイヤー（plan.md D3）。

  ボルト生成は CPU（発生頻度が低く毎フレーム compute する意味がない）:
  - ミッドポイント変位（再帰 2 分割 + 横ずれ）で主幹を作り、途中から
    確率分岐で枝ボルトを生やす
  - ジオメトリは view 向きに vertex シェーダーで billboard するリボン
    （aDir 接線 + aSide ±1 + aWidth 幅を CPU で焼き込み）
  - 加算ブレンド + 白飛びコアで postfx（Bloom）なしでも自立する

  タイミングはポアソン過程（rate 回/分）+ 3 段エンベロープ
  （リーダー伸長 → 本閃光 → 残光減衰）。フラッシュは
  - 落雷点のポイントライト（地形を照らす）
  - flashUniform（Scene 経由で CloudLayer の雲内発光に接続）
  の 2 系統を同じエンベロープで駆動する。

  落雷点は heightInfo（CPU 側）から標高の高い候補を重み付き抽選する。
*/

// ============================================================
// 調整用パラメータ
// ============================================================

const BOLT = {
  depth: 7,             // ミッドポイント変位の再帰深さ（2^depth セグメント）
  jitter: 0.16,         // 変位量（セグメント長比）
  width: 0.035,         // 主幹の根元幅（world units）
  taper: 0.75,          // 先端に向けた幅の減衰率
  branchCount: [2, 4],  // 枝の本数range
  branchDepth: 5,       // 枝の再帰深さ
  branchWidth: 0.45,    // 枝の幅（主幹比）
  branchLen: [0.25, 0.5], // 枝の長さ（残り高さ比）
}

const ENVELOPE = {
  leaderTime: 0.08,     // リーダー伸長（薄く見え始める）
  flashTime: 0.06,      // 本閃光
  decayTau: 0.09,       // 残光の指数減衰 時定数
  total: 0.5,           // 全体寿命（秒）
  leaderLevel: 0.25,    // リーダー段階の明るさ
}

const LIGHT_INTENSITY = 60   // フラッシュ時のポイントライト強度
const LIGHT_COLOR = '#cfe0ff'
const BOLT_COLOR = '#e8f2ff'
const HIGH_GROUND_CANDIDATES = 6 // 落雷点候補数（最も高い地点を選ぶ）

// ============================================================
// CPU 側ヘルパー
// ============================================================

// ミッドポイント変位でジグザグのポリラインを作る
function displacePath(start, end, depth, jitter) {
  let pts = [start, end]
  for (let d = 0; d < depth; d++) {
    const next = []
    const scale = jitter * Math.pow(0.62, d)
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      next.push(a)
      const seg = new THREE.Vector3().subVectors(b, a)
      const len = seg.length()
      // セグメントに直交するランダム方向へ変位
      const rand = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      const perp = new THREE.Vector3().crossVectors(seg, rand).normalize()
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
      mid.addScaledVector(perp, (Math.random() - 0.5) * 2 * len * scale)
      next.push(mid)
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  return pts
}

// 主幹 + 枝のポリライン群を生成
function buildBoltPolylines(start, end) {
  const polylines = []
  const trunk = displacePath(start, end, BOLT.depth, BOLT.jitter)
  polylines.push({ points: trunk, width: BOLT.width })

  const [bMin, bMax] = BOLT.branchCount
  const count = bMin + Math.floor(Math.random() * (bMax - bMin + 1))
  for (let b = 0; b < count; b++) {
    // 主幹の上側 15%〜70% の位置から分岐
    const idx = Math.floor(trunk.length * (0.15 + Math.random() * 0.55))
    const origin = trunk[idx]
    const [lMin, lMax] = BOLT.branchLen
    const frac = lMin + Math.random() * (lMax - lMin)
    const drop = (origin.y - end.y) * frac
    const target = new THREE.Vector3(
      origin.x + (Math.random() - 0.5) * drop * 1.6,
      origin.y - drop,
      origin.z + (Math.random() - 0.5) * drop * 1.6
    )
    const pts = displacePath(origin.clone(), target, BOLT.branchDepth, BOLT.jitter * 1.2)
    polylines.push({ points: pts, width: BOLT.width * BOLT.branchWidth })
  }
  return polylines
}

// ポリライン群 → billboard リボンの BufferGeometry
// 頂点属性: position（芯の位置）/ aDir（接線）/ aSide（±1）/ aWidth（半幅）
function buildBoltGeometry(polylines) {
  const positions = []
  const dirs = []
  const sides = []
  const widths = []
  const indices = []

  for (const { points, width } of polylines) {
    const base = positions.length / 3
    const n = points.length
    for (let i = 0; i < n; i++) {
      const p = points[i]
      const prev = points[Math.max(i - 1, 0)]
      const next = points[Math.min(i + 1, n - 1)]
      const dir = new THREE.Vector3().subVectors(next, prev).normalize()
      const w = width * (1 - (i / (n - 1)) * BOLT.taper)
      for (const side of [-1, 1]) {
        positions.push(p.x, p.y, p.z)
        dirs.push(dir.x, dir.y, dir.z)
        sides.push(side)
        widths.push(w)
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 3))
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1))
  geometry.setAttribute('aWidth', new THREE.Float32BufferAttribute(widths, 1))
  geometry.setIndex(indices)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5) // カリング無効相当
  return geometry
}

// 3 段エンベロープ: リーダー → 本閃光 → 残光減衰
function envelopeAt(age) {
  if (age < ENVELOPE.leaderTime) {
    return ENVELOPE.leaderLevel * (age / ENVELOPE.leaderTime)
  }
  if (age < ENVELOPE.leaderTime + ENVELOPE.flashTime) {
    return 1
  }
  const t = age - ENVELOPE.leaderTime - ENVELOPE.flashTime
  return Math.exp(-t / ENVELOPE.decayTau)
}

// ============================================================

function LightningLayer({
  position = [0, 0, 0],
  rate = 0, // 落雷頻度（回/分）。0 で完全 idle
  topY = 4.5, // ボルト始点の高さ（雲底。レイヤーローカル）
  flashUniform = null, // Scene 経由で CloudLayer の雲内発光と共有する uniform
}) {
  const { heightInfo } = useHeightField()

  const opacityUniform = useMemo(() => uniform(0), [])

  const material = useMemo(() => {
    const mat = new MeshBasicNodeMaterial({
      color: BOLT_COLOR,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      fog: false,
    })
    // 芯の位置を接線×視線の right 方向へ押し出す billboard リボン
    mat.vertexNode = Fn(() => {
      const dir = attribute('aDir', 'vec3')
      const side = attribute('aSide', 'float')
      const width = attribute('aWidth', 'float')
      const worldPos = modelWorldMatrix.mul(vec4(positionGeometry, 1))
      const viewDir = normalize(cameraPosition.sub(worldPos.xyz))
      const right = normalize(cross(dir, viewDir))
      const finalWorld = worldPos.xyz.add(right.mul(width).mul(side))
      return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(finalWorld, 1)))
    })()
    mat.opacityNode = opacityUniform
    return mat
  }, [opacityUniform])

  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), material)
    m.frustumCulled = false
    m.visible = false
    return m
  }, [material])

  const lightRef = useRef(null)
  const strikeRef = useRef({ active: false, age: 0 })

  useEffect(() => {
    return () => {
      mesh.geometry.dispose()
      material.dispose()
    }
  }, [mesh, material])

  useFrame((_, delta) => {
    const dt = Math.min(delta || 1 / 60, 0.1)
    const state = strikeRef.current

    if (!state.active) {
      // ポアソン過程: このフレームで落雷が発生する確率 = rate/60 × dt
      if (rate > 0 && heightInfo && Math.random() < (rate / 60) * dt) {
        // 落雷点: 候補から最も標高が高い地点を選ぶ（稜線に落ちやすい）
        const halfW = heightInfo.terrainWidth / 2
        const halfD = heightInfo.terrainDepth / 2
        let best = null
        for (let i = 0; i < HIGH_GROUND_CANDIDATES; i++) {
          const x = (Math.random() - 0.5) * 2 * halfW * 0.9
          const z = (Math.random() - 0.5) * 2 * halfD * 0.9
          const y = cpuHeightAt(heightInfo, x, z)
          if (!best || y > best.y) best = { x, y, z }
        }
        const start = new THREE.Vector3(
          best.x + (Math.random() - 0.5) * 1.5,
          topY,
          best.z + (Math.random() - 0.5) * 1.5
        )
        const end = new THREE.Vector3(best.x, best.y, best.z)

        mesh.geometry.dispose()
        mesh.geometry = buildBoltGeometry(buildBoltPolylines(start, end))
        mesh.visible = true
        state.active = true
        state.age = 0
        if (lightRef.current) {
          lightRef.current.position.set(best.x, (topY + best.y) / 2, best.z)
        }
      }
      return
    }

    state.age += dt
    if (state.age >= ENVELOPE.total) {
      state.active = false
      mesh.visible = false
      opacityUniform.value = 0
      if (flashUniform) flashUniform.value = 0
      if (lightRef.current) lightRef.current.intensity = 0
      return
    }

    // 残光段階はランダムフリッカーを重ねる
    const env = envelopeAt(state.age)
    const flicker = state.age > ENVELOPE.leaderTime + ENVELOPE.flashTime
      ? 0.7 + Math.random() * 0.3
      : 1
    const level = env * flicker
    opacityUniform.value = level
    if (flashUniform) flashUniform.value = level
    if (lightRef.current) lightRef.current.intensity = level * LIGHT_INTENSITY
  })

  return (
    <group position={position}>
      <primitive object={mesh} />
      {/* 落雷点を照らすフラッシュライト（シャドウなし・減衰あり） */}
      <pointLight ref={lightRef} color={LIGHT_COLOR} intensity={0} decay={1.6} />
    </group>
  )
}

export default LightningLayer
