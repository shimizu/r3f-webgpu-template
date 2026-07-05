import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { MeshStandardNodeMaterial, StorageBufferAttribute } from 'three/webgpu'
import {
  Fn,
  float,
  int,
  vec3,
  uniform,
  storage,
  positionGeometry,
  positionWorld,
  cameraPosition,
  transformNormalToView,
  instancedBufferAttribute,
  smoothstep,
  mix,
  clamp,
  dot,
  sin,
  cos,
  pow,
  min,
  max,
  time,
} from 'three/tsl'
import { coverageMask } from '../tsl/coverageMask'
import { createGroundField } from './groundField'
import { disposeStorageAttributes } from '../compute/disposeStorageAttributes'

/**
 * GPU インスタンス草レイヤー（task.md T1）
 *
 * 全ブレードを 1 つの InstancedBufferGeometry・1 ドローコールで描画する。
 * CPU は初期化時に per-instance 属性を詰めるだけで、以降の per-frame 更新は
 * 一切しない。形状（円弧カール・風揺れ・接地）はすべて頂点ステージの
 * positionNode で計算する。
 *
 *  - カバレッジマスク外のブレードは高さ・幅を 0 に潰して消す（GPU カリング）
 *  - 風は「風向きに沿って進行する gust 波 + ブレード個別フラッター」で
 *    野原を波が渡るコヒーレントな揺れになる
 *  - 密度は geometry.instanceCount の変更のみでスケール（再生成なし）
 *  - 接地は「worldXZ → 高さ」の heightAt 関数で抽象化:
 *      heightInfo なし → groundField の手続きマウンド（leva の起伏コントロール有効）
 *      heightInfo あり → TerrainLayer の DEM 高さバッファをバイリニア補間
 *                        （RainLayer の地形衝突と同じ storage buffer 参照方式。
 *                        散布域も terrainWidth × terrainDepth に切り替わり、
 *                        seaLevel（正規化標高）以下には生えない）
 *
 * heightInfo は TerrainLayer の onHeightData から渡す想定。毎レンダー新規
 * オブジェクトを渡すと GPU リソースが再生成されるため安定参照で渡すこと。
 */

const SEGMENTS = 5

// シード付き PRNG（mulberry32）。決定的なので render 中でも純粋で、
// リロードしても同じ草配置が再現される（lookdev の比較に都合が良い）
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default function GrassLayer({
  area = 40, // 散布する正方形の一辺（レイヤーローカル単位。heightInfo 指定時は無視）
  maxCount = 100000, // 生成ブレード数（density で間引く）
  position = [0, 0, 0],
  heightInfo = null, // TerrainLayer の onHeightData が渡す DEM 高さバッファ（安定参照必須）
  seaLevel = 0, // 正規化標高（TerrainLayer と同じ値）。leva「生育下限標高」の初期値にのみ使う
  bladeScale = 1, // 草丈・葉幅の一括倍率（leva 値に乗算。DEM 上ではスケールを合わせるのに使う）
}) {
  const {
    density,
    coverage,
    maskScale,
    maskEdge,
    bladeHeight,
    bladeWidth,
    curl,
    windStrength,
    windSpeed,
    windDirection,
    gustSize,
    flutter,
    colorBase,
    colorTip,
    colorVar,
    translucency,
    moundDepth,
    moundScale,
    elevMin,
    elevMax,
    elevFade,
  } = useControls('草', {
    density: { value: 0.15, min: 0, max: 1, step: 0.01, label: '密度' },
    coverage: { value: 0.62, min: 0, max: 1, step: 0.01, label: '被覆率' },
    maskScale: { value: 0.15, min: 0.02, max: 0.8, step: 0.001, label: 'パッチスケール' },
    maskEdge: { value: 0.25, min: 0.001, max: 0.4, step: 0.001, label: 'パッチ境界' },
    bladeHeight: { value: 0.8, min: 0.1, max: 2.5, step: 0.01, label: '草丈' },
    bladeWidth: { value: 0.035, min: 0.01, max: 0.25, step: 0.001, label: '葉幅' },
    curl: { value: 1.14, min: 0, max: 2.2, step: 0.01, label: 'カール' },
    windStrength: { value: 0.5, min: 0, max: 2, step: 0.01, label: '風の強さ' },
    windSpeed: { value: 1.8, min: 0, max: 6, step: 0.01, label: '風速' },
    windDirection: { value: 20, min: 0, max: 360, step: 1, label: '風向°' },
    gustSize: { value: 0.35, min: 0.05, max: 1.5, step: 0.01, label: '突風サイズ' },
    flutter: { value: 0.6, min: 0, max: 1.5, step: 0.01, label: 'フラッター' },
    colorBase: { value: '#33421b', label: '根元色' },
    colorTip: { value: '#9bc24a', label: '先端色' },
    colorVar: { value: 0.47, min: 0, max: 0.6, step: 0.01, label: '個体色差' },
    translucency: { value: 0.6, min: 0, max: 2, step: 0.01, label: '透過光' },
    moundDepth: { value: 0.55, min: 0, max: 2, step: 0.01, label: '起伏の高さ' },
    moundScale: { value: 0.12, min: 0.02, max: 0.8, step: 0.001, label: '起伏スケール' },
    // --- 標高による生育域（DEM モードのみ有効。正規化標高 0..1） ---
    // 初期の下限は seaLevel + 汀線マージン（従来のハードコード値と同じ挙動）
    elevMin: { value: seaLevel + 0.01, min: 0, max: 1, step: 0.005, label: '生育下限標高' },
    elevMax: { value: 1, min: 0, max: 1, step: 0.005, label: '生育上限標高' },
    elevFade: { value: 0.04, min: 0.005, max: 0.2, step: 0.005, label: '標高フェード幅' },
  })

  const renderer = useThree((state) => state.gl)

  const { geometry, material, uniforms, heightsAttr } = useMemo(() => {
    // 散布域: DEM モードでは地形フットプリントに合わせる（X と Z が異なる）
    const areaX = heightInfo ? heightInfo.terrainWidth : area
    const areaZ = heightInfo ? heightInfo.terrainDepth : area

    /* ---- ベースジオメトリ: 縦ストリップ x∈[-0.5,0.5], y∈[0,1] ---- */
    const positions = []
    const indices = []
    for (let j = 0; j <= SEGMENTS; j += 1) {
      const t = j / SEGMENTS
      positions.push(-0.5, t, 0, 0.5, t, 0)
      if (j < SEGMENTS) {
        const a = j * 2
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
      }
    }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)

    /* ---- per-instance 属性（初期化時のみ CPU で生成） ---- */
    const iPosArr = new Float32Array(maxCount * 2) // XZ 配置
    const iVarArr = new Float32Array(maxCount * 4) // yaw, 高さ個体差, 幅個体差, 風位相
    const iMiscArr = new Float32Array(maxCount * 2) // カール個体差, 色個体差
    const rand = mulberry32(1337)
    for (let i = 0; i < maxCount; i += 1) {
      iPosArr[i * 2] = (rand() - 0.5) * areaX
      iPosArr[i * 2 + 1] = (rand() - 0.5) * areaZ
      iVarArr[i * 4] = rand() * Math.PI * 2
      iVarArr[i * 4 + 1] = 0.7 + rand() * 0.6
      iVarArr[i * 4 + 2] = 0.8 + rand() * 0.5
      iVarArr[i * 4 + 3] = rand() * Math.PI * 2
      iMiscArr[i * 2] = 0.6 + rand() * 0.8
      iMiscArr[i * 2 + 1] = rand()
    }
    const iPosAttr = new THREE.InstancedBufferAttribute(iPosArr, 2)
    const iVarAttr = new THREE.InstancedBufferAttribute(iVarArr, 4)
    const iMiscAttr = new THREE.InstancedBufferAttribute(iMiscArr, 2)
    geometry.setAttribute('iPos', iPosAttr)
    geometry.setAttribute('iVar', iVarAttr)
    geometry.setAttribute('iMisc', iMiscAttr)
    // ブレードはシェーダー内で配置されるので、フィールド全体を覆う球を手動設定
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Math.hypot(areaX, areaZ) / 2 + 4
    )

    /* ---- uniforms（leva から .value 更新。マテリアル再生成なし） ---- */
    const uniforms = {
      coverage: uniform(0.62),
      maskScale: uniform(0.15),
      maskEdge: uniform(0.25),
      maskSeed: uniform(new THREE.Vector2(3.7, 9.1)),
      height: uniform(0.8),
      width: uniform(0.035),
      curl: uniform(1.14),
      windDir: uniform(new THREE.Vector2(1, 0.35).normalize()),
      windStrength: uniform(0.5),
      windSpeed: uniform(1.8),
      windScale: uniform(0.35),
      gust: uniform(0.6),
      colorBase: uniform(new THREE.Color('#33421b')),
      colorTip: uniform(new THREE.Color('#9bc24a')),
      colorVarAmt: uniform(0.47),
      translucency: uniform(0.6),
      sunDir: uniform(new THREE.Vector3(1, 1, 1).normalize()),
      moundDepth: uniform(0.55),
      moundScale: uniform(0.12),
      groundSeed: uniform(new THREE.Vector2(8.3, 2.1)),
      elevMin: uniform(0.2),
      elevMax: uniform(1),
      elevFade: uniform(0.04),
    }
    const u = uniforms

    // 接地関数（worldXZ → 高さ）。DEM があれば heights の storage buffer を
    // バイリニア補間、なければ手続きマウンド（groundField）
    let heightAt
    let heightsAttr = null
    if (heightInfo) {
      const { heights, cols, rows, terrainWidth, terrainDepth } = heightInfo
      heightsAttr = new StorageBufferAttribute(heights, 1)
      const heightsNode = storage(heightsAttr, 'float', cols * rows).toReadOnly()
      const halfW = terrainWidth / 2
      const halfD = terrainDepth / 2
      heightAt = Fn(([xz]) => {
        // RainLayer の衝突ルックアップと同じ格子対応（等間隔格子前提。
        // mercator / natural-earth では近似になる — TerrainLayer 側の注記参照）
        const fx = clamp(xz.x.add(halfW).div(terrainWidth), 0, 1).mul(cols - 1)
        const fz = clamp(xz.y.add(halfD).div(terrainDepth), 0, 1).mul(rows - 1)
        const x0 = int(fx) // 非負なので trunc = floor
        const z0 = int(fz)
        const x1 = min(x0.add(1), int(cols - 1))
        const z1 = min(z0.add(1), int(rows - 1))
        const tx = fx.sub(float(x0))
        const tz = fz.sub(float(z0))
        const h00 = heightsNode.element(z0.mul(int(cols)).add(x0))
        const h10 = heightsNode.element(z0.mul(int(cols)).add(x1))
        const h01 = heightsNode.element(z1.mul(int(cols)).add(x0))
        const h11 = heightsNode.element(z1.mul(int(cols)).add(x1))
        return mix(mix(h00, h10, tx), mix(h01, h11, tx), tz)
      })
    } else {
      const ground = createGroundField({
        moundScale: u.moundScale,
        moundDepth: u.moundDepth,
        seed: u.groundSeed,
        rim: area * 0.5,
      })
      heightAt = ground.heightAt
    }

    const iPos = instancedBufferAttribute(iPosAttr)
    const iVar = instancedBufferAttribute(iVarAttr)
    const iMisc = instancedBufferAttribute(iMiscAttr)

    const t = positionGeometry.y // 0 (根元) .. 1 (先端)
    const side = positionGeometry.x // -0.5 .. 0.5

    // 接地高さ（海面マスクにも使うので先に評価。TSL がノードを共有するので二重計算はない）
    const groundY = heightAt(iPos)

    // マスク外のブレードは高さ・幅ゼロ（面積なし）に潰れて消える
    let mask = coverageMask(iPos, u.maskScale, u.maskSeed, u.coverage, u.maskEdge)
    if (heightInfo) {
      // 標高による生育域（uniform 駆動 = leva「生育下限/上限標高」で即時変更）。
      // 下限: elevMin から fade 幅で立ち上がる（汀線）。
      // 上限: elevMax の上側に fade 幅を取るので、既定 elevMax=1 では山頂まで生える
      const normElev = groundY.sub(heightInfo.minY).div(heightInfo.rangeY)
      const lower = smoothstep(u.elevMin, u.elevMin.add(u.elevFade), normElev)
      const upper = smoothstep(u.elevMax, u.elevMax.add(u.elevFade), normElev).oneMinus()
      mask = mask.mul(lower).mul(upper)
    }
    const h = u.height.mul(iVar.y).mul(mask)
    const w = u.width
      .mul(iVar.z)
      .mul(t.oneMinus())
      .mul(t.oneMinus().mul(0.3).add(0.7))
      .mul(mask)

    // 円弧カール: 全角 A の円弧として位置・接線を厳密に計算（法線が破綻しない）。
    // curl >= 0 なので A→0 は微小クランプで直立（y=h·t, z=0）に自然収束する
    const A = max(u.curl.mul(iMisc.x), 0.001)
    const at = A.mul(t)
    const sinAt = sin(at)
    const cosAt = cos(at)
    const yA = h.mul(sinAt).div(A)
    const zA = h.mul(cosAt.oneMinus()).div(A)
    const nLocal = vec3(0, sinAt.negate(), cosAt) // 円弧に沿ったブレード面法線

    // per-instance yaw で Y 軸回転
    const cy = cos(iVar.x)
    const sy = sin(iVar.x)
    const pLocal = vec3(side.mul(w), yA, zA)
    const pR = vec3(
      pLocal.x.mul(cy).add(pLocal.z.mul(sy)),
      pLocal.y,
      pLocal.x.mul(sy).negate().add(pLocal.z.mul(cy))
    )
    const nR = vec3(
      nLocal.x.mul(cy).add(nLocal.z.mul(sy)),
      nLocal.y,
      nLocal.x.mul(sy).negate().add(nLocal.z.mul(cy))
    )

    // コヒーレント風: 風向きに沿って進行する gust 波 + 個体フラッター。
    // 位相 = dot(位置, 風向)·空間周波数 + time·速度 + 個体位相。振れ幅は t²（先端ほど大）
    const gph = dot(iPos, u.windDir)
      .mul(u.windScale)
      .add(time.mul(u.windSpeed))
      .add(iVar.w)
    const gustWave = sin(gph).mul(0.6).add(sin(gph.mul(0.5).add(1.7)).mul(0.4))
    const flutterWave = sin(time.mul(8).add(iVar.w.mul(3))).mul(0.15).mul(u.gust)
    const sway = gustWave.add(flutterWave).mul(u.windStrength)
    const windOff = u.windDir.mul(sway).mul(t.mul(t))

    const material = new MeshStandardNodeMaterial({
      roughness: 0.47,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    material.positionNode = vec3(
      iPos.x.add(pR.x).add(windOff.x),
      groundY.add(pR.y),
      iPos.y.add(pR.z).add(windOff.y)
    )
    material.normalNode = transformNormalToView(nR.normalize())

    // 根元→先端グラデーション × 個体差 × 根元の擬似 AO
    material.colorNode = mix(u.colorBase, u.colorTip, t)
      .mul(mix(float(1).sub(u.colorVarAmt), float(1).add(u.colorVarAmt), iMisc.y))
      .mul(mix(float(0.5), float(1), smoothstep(0, 0.35, t)))

    // 逆光トランスルーセンシー: 視線が太陽と正対するとき先端色が透ける
    const viewDir = cameraPosition.sub(positionWorld).normalize()
    const back = pow(clamp(dot(viewDir.negate(), u.sunDir), 0, 1), 2)
    material.emissiveNode = u.colorTip.mul(back).mul(u.translucency).mul(t)

    geometry.instanceCount = Math.floor(maxCount * 0.15)

    return { geometry, material, uniforms, heightsAttr }
  }, [area, maxCount, heightInfo])

  // 密度 = instanceCount の変更のみ（ジオメトリ再生成なし）
  useEffect(() => {
    geometry.instanceCount = Math.floor(maxCount * THREE.MathUtils.clamp(density, 0, 1))
  }, [geometry, maxCount, density])

  // leva → uniform 反映（マテリアル再コンパイルは発生しない）
  useEffect(() => {
    const u = uniforms
    u.coverage.value = coverage
    u.maskScale.value = maskScale
    u.maskEdge.value = maskEdge
    u.height.value = bladeHeight * bladeScale
    u.width.value = bladeWidth * bladeScale
    u.curl.value = curl
    u.windStrength.value = windStrength
    u.windSpeed.value = windSpeed
    u.windScale.value = gustSize
    u.gust.value = flutter
    const a = THREE.MathUtils.degToRad(windDirection)
    u.windDir.value.set(Math.cos(a), Math.sin(a))
    u.colorBase.value.set(colorBase)
    u.colorTip.value.set(colorTip)
    u.colorVarAmt.value = colorVar
    u.translucency.value = translucency
    u.moundDepth.value = moundDepth
    u.moundScale.value = moundScale
    u.elevMin.value = elevMin
    u.elevMax.value = elevMax
    u.elevFade.value = elevFade
  }, [
    uniforms,
    coverage,
    maskScale,
    maskEdge,
    bladeHeight,
    bladeWidth,
    bladeScale,
    curl,
    windStrength,
    windSpeed,
    windDirection,
    gustSize,
    flutter,
    colorBase,
    colorTip,
    colorVar,
    translucency,
    moundDepth,
    moundScale,
    elevMin,
    elevMax,
    elevFade,
  ])

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
      // 高さバッファはジオメトリ非経由の standalone storage なので明示解放が必要
      if (heightsAttr) disposeStorageAttributes(renderer, [heightsAttr])
    }
  }, [geometry, material, heightsAttr, renderer])

  return (
    <mesh
      position={position}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      receiveShadow
    />
  )
}
