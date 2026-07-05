import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useControls } from 'leva'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  clamp,
  cos,
  dot,
  float,
  mix,
  normalGeometry,
  positionGeometry,
  sin,
  smoothstep,
  step,
  time,
  transformNormalToView,
  uniform,
  vec3,
  instancedBufferAttribute,
} from 'three/tsl'

import { coverageMask } from '../tsl/coverageMask'
import { createGroundField } from './groundField'
import { useHeightField } from '../gis/HeightFieldContext'

/**
 * GPU インスタンス樹木レイヤー（GrassLayer パターンの移植）。
 *
 * 全樹木を 1 つの InstancedBufferGeometry・1 ドローコールで描画する。
 * CPU は初期化時に per-instance 属性を詰めるだけで、以降の per-frame 更新は
 * 一切しない。接地・樹種切替・風揺れ・マスクはすべて頂点ステージで計算する。
 *
 *  - 樹種は針葉樹（円錐 2 段）と広葉樹（楕円ドーム）の 2 種。同一トポロジーで
 *    両樹種の頂点位置・法線をジオメトリに焼き込み（position/normal = 針葉樹、
 *    aPosB/aNormalB = 広葉樹）、per-instance の乱数 × 混合比 uniform で
 *    どちらかに切り替える（step なので中間モーフは出ない）
 *  - カバレッジマスク外・生育標高帯外の木はスケール 0 に潰して消す（GPU カリング）
 *  - 密度は geometry.instanceCount の変更のみでスケール（再生成なし）
 *  - 接地は「worldXZ → 高さ」の heightAt 関数で抽象化:
 *      terrain=false → groundField の手続きマウンド（草の床と同じ既定値・シード）
 *      terrain=true  → HeightFieldContext の共有サンプラ（DEM バイリニア補間）。
 *                      terrain 時は標高が高いほど針葉樹寄りにもできる
 *
 * terrain=true では HeightFieldContext（Scene の Provider + TerrainLayer の
 * onHeightData）が heightInfo を発行するまで何も描画しない。
 */

// カノピーの分割数（両樹種で同一トポロジーにするため共通）
const CANOPY_SEGMENTS = 7 // 周方向
const CANOPY_RINGS = 6 // 高さ方向（リング数 = RINGS + 1 レベル）
const TRUNK_SEGMENTS = 6 // 幹の角柱

// シード付き PRNG（mulberry32）。決定的なので render 中でも純粋で、
// リロードしても同じ配置が再現される（GrassLayer と同じ）
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ============================================================
// 樹形プロファイル（単位樹高 y 0..1 に対するカノピー半径）
// ============================================================

// 針葉樹: 円錐 2 段。t=0.48 で半径が跳ね上がる段差を作る
function coniferRadius(t) {
  if (t < 0.48) return 0.3 + (0.06 - 0.3) * (t / 0.48)
  return 0.24 + (0 - 0.24) * ((t - 0.48) / 0.52)
}

// 広葉樹: 楕円ドーム（中心 y=0.62、縦半径 0.38、横半径 0.26）
function broadleafRadius(t) {
  const y = 0.3 + 0.7 * t
  const k = (y - 0.62) / 0.38
  return 0.26 * Math.sqrt(Math.max(0, 1 - k * k))
}

// 樹種ごとの { 幹上端, 幹半径, カノピー基部 y }
const SPECIES = {
  conifer: { trunkTop: 0.3, trunkRadius: 0.035, canopyBase: 0.24, radiusAt: coniferRadius },
  broadleaf: { trunkTop: 0.38, trunkRadius: 0.045, canopyBase: 0.3, radiusAt: broadleafRadius },
}

// 1 樹種ぶんの頂点位置を生成（トポロジーは樹種間で完全一致）。
// 返り値: Float32Array(positions)。index / aH / aTrunk は buildTreeGeometry 側で共通生成
function buildSpeciesPositions(spec) {
  const positions = []

  // --- 幹: 角柱（下リング + 上リング） ---
  for (const y of [0, spec.trunkTop]) {
    for (let s = 0; s <= TRUNK_SEGMENTS; s++) {
      const a = (s / TRUNK_SEGMENTS) * Math.PI * 2
      positions.push(Math.cos(a) * spec.trunkRadius, y, Math.sin(a) * spec.trunkRadius)
    }
  }

  // --- カノピー: リング積層（t=0 基部 → t=1 梢。梢は半径 0 で閉じる） ---
  for (let i = 0; i <= CANOPY_RINGS; i++) {
    const t = i / CANOPY_RINGS
    const y = spec.canopyBase + (1 - spec.canopyBase) * t
    const r = Math.max(spec.radiusAt(t), i === CANOPY_RINGS ? 0 : 0.015)
    for (let s = 0; s <= CANOPY_SEGMENTS; s++) {
      const a = (s / CANOPY_SEGMENTS) * Math.PI * 2
      positions.push(Math.cos(a) * r, y, Math.sin(a) * r)
    }
  }

  return new Float32Array(positions)
}

// 両樹種の位置 + 法線（computeVertexNormals 利用）+ 共通属性を持つジオメトリを構築
function buildTreeGeometry() {
  const indices = []

  // 幹の側面
  const trunkRow = TRUNK_SEGMENTS + 1
  for (let s = 0; s < TRUNK_SEGMENTS; s++) {
    const a = s
    const b = s + trunkRow
    indices.push(a, b, a + 1, a + 1, b, b + 1)
  }

  // カノピーの側面
  const canopyStart = trunkRow * 2
  const canopyRow = CANOPY_SEGMENTS + 1
  for (let i = 0; i < CANOPY_RINGS; i++) {
    for (let s = 0; s < CANOPY_SEGMENTS; s++) {
      const a = canopyStart + i * canopyRow + s
      const b = a + canopyRow
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }

  const posA = buildSpeciesPositions(SPECIES.conifer)
  const posB = buildSpeciesPositions(SPECIES.broadleaf)

  // 法線は各樹種のジオメトリで computeVertexNormals して属性化する
  const normalFor = (positions) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    const normals = g.getAttribute('normal').array.slice()
    g.dispose()
    return normals
  }
  const normalA = normalFor(posA)
  const normalB = normalFor(posB)

  // 正規化高さ（風の揺れの重み）と幹フラグ（色分け）。両樹種で共通に使えるよう
  // 針葉樹側の y を採用する（樹種間の y 差は小さい）
  const vertexCount = posA.length / 3
  const aH = new Float32Array(vertexCount)
  const aTrunk = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    aH[i] = posA[i * 3 + 1]
    aTrunk[i] = i < trunkRow * 2 ? 1 : 0
  }

  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalA, 3))
  geometry.setAttribute('aPosB', new THREE.Float32BufferAttribute(posB, 3))
  geometry.setAttribute('aNormalB', new THREE.Float32BufferAttribute(normalB, 3))
  geometry.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 1))
  geometry.setAttribute('aTrunk', new THREE.Float32BufferAttribute(aTrunk, 1))
  geometry.setIndex(indices)
  return geometry
}

export default function TreeLayer({
  area = 40, // 散布する正方形の一辺（レイヤーローカル単位。terrain 時は無視）
  maxCount = 20000, // 生成本数（density で間引く）
  position = [0, 0, 0],
  terrain = false, // true で HeightFieldContext の DEM 高さ場に接地する
  seaLevel = 0, // 正規化標高（TerrainLayer と同じ値）。leva「生育下限標高」の初期値にのみ使う
  treeScale = 1, // 樹高・樹冠の一括倍率（leva 値に乗算。DEM 上でスケールを合わせるのに使う）
  castShadow = false, // 影を落とすか（本数が多いと負荷が上がるため既定オフ）
}) {
  const {
    density,
    coverage,
    patchScale,
    patchEdge,
    treeHeight,
    treeWidth,
    coniferRatio,
    elevSpecies,
    windStrength,
    windSpeed,
    colorTrunk,
    colorConifer,
    colorBroadleaf,
    colorVar,
    elevMin,
    elevMax,
    elevFade,
  } = useControls('木', {
    density: { value: 0.15, min: 0, max: 1, step: 0.01, label: '密度' },
    coverage: { value: 0.5, min: 0, max: 1, step: 0.01, label: '被覆率' },
    patchScale: { value: 0.08, min: 0.02, max: 0.5, step: 0.001, label: 'パッチスケール' },
    patchEdge: { value: 0.2, min: 0.001, max: 0.4, step: 0.001, label: 'パッチ境界' },
    treeHeight: { value: 1.0, min: 0.2, max: 3, step: 0.01, label: '樹高' },
    treeWidth: { value: 1.0, min: 0.3, max: 2.5, step: 0.01, label: '樹冠幅' },
    coniferRatio: { value: 0.6, min: 0, max: 1, step: 0.01, label: '針葉樹比率' },
    elevSpecies: { value: 0.6, min: 0, max: 2, step: 0.01, label: '標高で針葉樹化' },
    windStrength: { value: 0.12, min: 0, max: 0.5, step: 0.005, label: '風の強さ' },
    windSpeed: { value: 1.2, min: 0, max: 5, step: 0.01, label: '風速' },
    colorTrunk: { value: '#5a4632', label: '幹色' },
    colorConifer: { value: '#2e5d34', label: '針葉樹色' },
    colorBroadleaf: { value: '#4f7d3a', label: '広葉樹色' },
    colorVar: { value: 0.3, min: 0, max: 0.6, step: 0.01, label: '個体色差' },
    // --- 標高による生育域（DEM モードのみ有効。正規化標高 0..1） ---
    // 上限の既定 0.7 は森林限界の想定（堆積の雪線 0.55 より上で途切れる）
    elevMin: { value: seaLevel + 0.02, min: 0, max: 1, step: 0.005, label: '生育下限標高' },
    elevMax: { value: 0.7, min: 0, max: 1, step: 0.005, label: '生育上限標高' },
    elevFade: { value: 0.05, min: 0.005, max: 0.2, step: 0.005, label: '標高フェード幅' },
  })

  // DEM 高さ場は HeightFieldContext から共有取得（GPU バッファは Provider が 1 個だけ保持）
  const { heightInfo: ctxHeightInfo, gpu } = useHeightField()
  const heightInfo = terrain ? ctxHeightInfo : null
  const sampler = terrain ? gpu?.sampler ?? null : null

  const { geometry, material, uniforms } = useMemo(() => {
    // 散布域: DEM モードでは地形フットプリントに合わせる
    const areaX = heightInfo ? heightInfo.terrainWidth : area
    const areaZ = heightInfo ? heightInfo.terrainDepth : area

    /* ---- ベースジオメトリ: 両樹種焼き込みの単木メッシュ ---- */
    const geometry = buildTreeGeometry()

    /* ---- per-instance 属性（初期化時のみ CPU で生成） ---- */
    const iPosArr = new Float32Array(maxCount * 2) // XZ 配置
    const iVarArr = new Float32Array(maxCount * 4) // yaw, 高さ個体差, 幅個体差, 風位相
    const iMiscArr = new Float32Array(maxCount * 3) // 樹種乱数, 色個体差, スケール微差
    const rand = mulberry32(4649)
    for (let i = 0; i < maxCount; i += 1) {
      iPosArr[i * 2] = (rand() - 0.5) * areaX
      iPosArr[i * 2 + 1] = (rand() - 0.5) * areaZ
      iVarArr[i * 4] = rand() * Math.PI * 2
      iVarArr[i * 4 + 1] = 0.65 + rand() * 0.7
      iVarArr[i * 4 + 2] = 0.75 + rand() * 0.5
      iVarArr[i * 4 + 3] = rand() * Math.PI * 2
      iMiscArr[i * 3] = rand()
      iMiscArr[i * 3 + 1] = rand()
      iMiscArr[i * 3 + 2] = 0.85 + rand() * 0.3
    }
    const iPosAttr = new THREE.InstancedBufferAttribute(iPosArr, 2)
    const iVarAttr = new THREE.InstancedBufferAttribute(iVarArr, 4)
    const iMiscAttr = new THREE.InstancedBufferAttribute(iMiscArr, 3)
    geometry.setAttribute('iPos', iPosAttr)
    geometry.setAttribute('iVar', iVarAttr)
    geometry.setAttribute('iMisc', iMiscAttr)
    // 木はシェーダー内で配置されるので、フィールド全体を覆う球を手動設定
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Math.hypot(areaX, areaZ) / 2 + 6
    )

    /* ---- uniforms（leva から .value 更新。マテリアル再生成なし） ---- */
    const uniforms = {
      coverage: uniform(0.5),
      patchScale: uniform(0.08),
      patchEdge: uniform(0.2),
      patchSeed: uniform(new THREE.Vector2(11.3, 4.7)),
      height: uniform(1.0),
      width: uniform(1.0),
      coniferRatio: uniform(0.6),
      elevSpecies: uniform(0.6),
      windDir: uniform(new THREE.Vector2(1, 0.35).normalize()),
      windStrength: uniform(0.12),
      windSpeed: uniform(1.2),
      colorTrunk: uniform(new THREE.Color('#5a4632')),
      colorConifer: uniform(new THREE.Color('#2e5d34')),
      colorBroadleaf: uniform(new THREE.Color('#4f7d3a')),
      colorVarAmt: uniform(0.3),
      // floor モードの手続きマウンド（草の床と同じ既定値・シードで一致させる）
      moundDepth: uniform(0.55),
      moundScale: uniform(0.12),
      groundSeed: uniform(new THREE.Vector2(8.3, 2.1)),
      elevMin: uniform(0.2),
      elevMax: uniform(0.7),
      elevFade: uniform(0.05),
    }
    const u = uniforms

    // 接地関数（worldXZ → 高さ）。GrassLayer と同じ抽象化
    let heightAt
    if (heightInfo && sampler) {
      heightAt = sampler.heightAt
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

    const aPosB = attribute('aPosB', 'vec3')
    const aNormalB = attribute('aNormalB', 'vec3')
    const aH = attribute('aH', 'float')
    const aTrunk = attribute('aTrunk', 'float')

    // 接地高さ（マスク・樹種の標高判定にも使う。TSL がノードを共有するので二重計算はない）
    const groundY = heightAt(iPos)

    // マスク: パッチ被覆 ×（DEM 時）生育標高帯。マスク外はスケール 0 で消える
    let mask = coverageMask(iPos, u.patchScale, u.patchSeed, u.coverage, u.patchEdge)
    let normElev = null
    if (heightInfo) {
      normElev = groundY.sub(heightInfo.minY).div(heightInfo.rangeY)
      const lower = smoothstep(u.elevMin, u.elevMin.add(u.elevFade), normElev)
      const upper = smoothstep(u.elevMax, u.elevMax.add(u.elevFade), normElev).oneMinus()
      mask = mask.mul(lower).mul(upper)
    }

    // 樹種: 乱数 < 実効針葉樹比率 → 針葉樹（broadleaf=0）。
    // DEM 時は標高が高いほど針葉樹比率が上がる（forest zonation の簡易表現）
    let coniferRatioEff = u.coniferRatio
    if (normElev) {
      coniferRatioEff = clamp(
        u.coniferRatio.add(normElev.sub(0.5).mul(u.elevSpecies)),
        0,
        1
      )
    }
    // step(edge, x): x < edge → 0。乱数 >= 比率 で広葉樹
    const broadleaf = step(coniferRatioEff, iMisc.x)

    // 樹種モーフ（step なので実際はどちらかの形状に確定する）
    const pSpecies = mix(positionGeometry, aPosB, broadleaf)
    const nSpecies = mix(normalGeometry, aNormalB, broadleaf).normalize()

    // スケール（マスク × 個体差 × 一括倍率）
    const h = u.height.mul(iVar.y).mul(iMisc.z).mul(mask)
    const w = u.width.mul(iVar.z).mul(iMisc.z).mul(mask)
    const scaled = vec3(pSpecies.x.mul(w), pSpecies.y.mul(h), pSpecies.z.mul(w))

    // per-instance yaw で Y 軸回転
    const cy = cos(iVar.x)
    const sy = sin(iVar.x)
    const pR = vec3(
      scaled.x.mul(cy).add(scaled.z.mul(sy)),
      scaled.y,
      scaled.x.mul(sy).negate().add(scaled.z.mul(cy))
    )
    const nR = vec3(
      nSpecies.x.mul(cy).add(nSpecies.z.mul(sy)),
      nSpecies.y,
      nSpecies.x.mul(sy).negate().add(nSpecies.z.mul(cy))
    )

    // コヒーレント風: gust 波 + 個体フラッター。梢ほど大きく揺れる（aH²）。
    // 振れ幅は樹高に比例させ、幹の根元は動かない
    const gph = dot(iPos, u.windDir)
      .mul(0.3)
      .add(time.mul(u.windSpeed))
      .add(iVar.w)
    const gustWave = sin(gph).mul(0.7).add(sin(gph.mul(0.43).add(1.3)).mul(0.3))
    const sway = gustWave.mul(u.windStrength).mul(h)
    const windOff = u.windDir.mul(sway).mul(aH.mul(aH))

    const material = new MeshStandardNodeMaterial({
      roughness: 0.85,
      metalness: 0,
    })
    material.positionNode = vec3(
      iPos.x.add(pR.x).add(windOff.x),
      groundY.add(pR.y),
      iPos.y.add(pR.z).add(windOff.y)
    )
    material.normalNode = transformNormalToView(nR.normalize())

    // 色: 樹種カノピー色 × 個体差、幹は aTrunk で塗り分け
    const canopyColor = mix(u.colorConifer, u.colorBroadleaf, broadleaf).mul(
      mix(float(1).sub(u.colorVarAmt), float(1).add(u.colorVarAmt), iMisc.y)
    )
    material.colorNode = mix(canopyColor, u.colorTrunk, aTrunk)

    geometry.instanceCount = Math.floor(maxCount * 0.15)

    return { geometry, material, uniforms }
  }, [area, maxCount, heightInfo, sampler])

  // 密度 = instanceCount の変更のみ（ジオメトリ再生成なし）
  useEffect(() => {
    geometry.instanceCount = Math.floor(maxCount * THREE.MathUtils.clamp(density, 0, 1))
  }, [geometry, maxCount, density])

  // leva → uniform 反映（マテリアル再コンパイルは発生しない）
  useEffect(() => {
    const u = uniforms
    u.coverage.value = coverage
    u.patchScale.value = patchScale
    u.patchEdge.value = patchEdge
    u.height.value = treeHeight * treeScale
    u.width.value = treeWidth * treeScale
    u.coniferRatio.value = coniferRatio
    u.elevSpecies.value = elevSpecies
    u.windStrength.value = windStrength
    u.windSpeed.value = windSpeed
    u.colorTrunk.value.set(colorTrunk)
    u.colorConifer.value.set(colorConifer)
    u.colorBroadleaf.value.set(colorBroadleaf)
    u.colorVarAmt.value = colorVar
    u.elevMin.value = elevMin
    u.elevMax.value = elevMax
    u.elevFade.value = elevFade
  }, [
    uniforms,
    coverage,
    patchScale,
    patchEdge,
    treeHeight,
    treeWidth,
    treeScale,
    coniferRatio,
    elevSpecies,
    windStrength,
    windSpeed,
    colorTrunk,
    colorConifer,
    colorBroadleaf,
    colorVar,
    elevMin,
    elevMax,
    elevFade,
  ])

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  // DEM モードで高さ場がまだ無い間は描画しない（hooks 実行後に判定）
  if (terrain && (!heightInfo || !sampler)) return null

  return (
    <mesh
      position={position}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      castShadow={castShadow}
      receiveShadow
    />
  )
}
