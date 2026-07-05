# task.md — GrassSystemThreeJS（Soil Studio）技術移植タスク

`referencejs/GrassSystemThreeJS/`（WebGL2 + GLSL の手続き的土壌・草・雲サンドボックス）の
レビュー結果と、当プロジェクト（WebGPU + TSL）への移植タスクをまとめる。
**必要なアルゴリズム・数式・サンプルコードは本書に固定化してあるので、以後
referencejs を参照する必要はない。**

- 出典: `referencejs/GrassSystemThreeJS/`（MIT License © 2026 mohamedachrefelouafi）
- テクスチャ: ambientCG 規約（Ground048 / Ground103 / Moss002）= CC0。流用可
- 参照側は `MeshStandardMaterial` + `onBeforeCompile` の GLSL 文字列注入。
  当プロジェクトへはコード流用不可、**アルゴリズムを TSL に移植**する
- 本書の TSL コードはすべて**動作未検証の移植スケッチ**。実装時に `npm run dev` で要検証

## タスク一覧

| ID | タスク | 優先度 | 状態 |
|----|--------|--------|------|
| T1 | GrassLayer — GPU インスタンス草レイヤー | 高 | 実装済み（確認待ち）※床版 + DEM 接地版（leva で切替） |
| T2 | 地形の濡れ表現（RainLayer 連動） | 中 | 未着手 |
| T3 | カバレッジマスク共通イディオム | 中（T1/T2 内で導入） | 実装済み（`src/tsl/coverageMask.js`） |
| T4 | 共有ハイトフィールドパターン | 中（T1 の前提） | 実装済み（手続き版 `groundField.js` + DEM 版は GrassLayer 内の storage バイリニア補間） |
| T5 | Worley クラック（乾裂した大地） | 低 | 未着手 |
| T6 | モデルへの苔・風化堆積 | 低 | 未着手 |
| T7 | フィルムグレードパス | 低（SceneEffects 復帰時） | 未着手 |
| — | 体積雲の改善 | **対応不要**（既存 CloudLayer が同等以上） | — |

---

## T1: GrassLayer — GPU インスタンス草レイヤー（優先度: 高）

### 仕様

- 全ブレードを 1 つの InstancedBufferGeometry・**1 ドローコール**で描画
- CPU は初期化時に per-instance 属性（XZ 位置・yaw・高さ/幅/カール/色の個体差・位相）を
  詰めるだけ。以降の per-frame 更新は一切しない（GPU ファースト方針に合致）
- ブレード形状（カール・風揺れ・接地）はすべて頂点ステージ（`positionNode`）で計算
- 密度は `geometry.instanceCount` の変更のみでスケール（leva スライダー）
- 配置マスク外のブレードは高さ・幅を 0 に潰して消す（CPU 側の再配置・カリング不要）
- `frustumCulled = false`（ブレードはシェーダー内でワールド配置されるため）
- 薄いブレードは影キャストしない（`castShadow = false`）が受影はする

### アルゴリズム（参照実装の要点）

1. **ベースジオメトリ**: 縦ストリップ。x ∈ [-0.5, 0.5]、y ∈ [0, 1]（t = 根元 0 → 先端 1）、
   segments 分割（既定 5）
2. **カバレッジマスク**: world XZ の fBM でパッチ状の生育域を決める（T3 のイディオム）。
   マスク値をそのまま高さ・幅に乗算 → マスク外は面積ゼロで消える
3. **円弧カール**: ブレードの反りを全角 A の円弧としてパラメータ化。
   位置と接線が解析的に一致するので法線が破綻しない
   ```
   y(t) = h·sin(A·t)/A
   z(t) = h·(1−cos(A·t))/A
   接線角 = A·t → ブレード面法線（ローカル）= (0, −sin(A·t), cos(A·t))
   A→0 の特異点は A を微小値でクランプすれば y→h·t, z→0 に自然収束
   ```
4. **yaw 回転**: per-instance の向きで位置・法線を Y 軸回転
5. **コヒーレント風**: 風向きに沿って進行する gust 波 + ブレード個別フラッター。
   位相を `dot(位置, 風向) × 空間周波数 + time × 速度 + 個体位相` にするだけで
   「風の波が野原を渡る」見た目になる。振れ幅は t²（先端ほど大きい）
   ```
   gph     = dot(iPos, windDir)·windScale + time·windSpeed + iPhase
   gust    = sin(gph)·0.6 + sin(gph·0.5 + 1.7)·0.4
   flutter = sin(time·8 + iPhase·3)·0.15·gustAmount
   windOff = windDir · (gust + flutter)·strength · t²
   ```
6. **接地**: 根元 Y に共有ハイトフィールド `groundHeightAt(iPos)`（T4）を加算
7. **シェーディング**:
   - 根元→先端のグラデーション（base 色 → tip 色）
   - per-instance 明度スキャッタ: `mix(1−var, 1+var, iColorVar)`
   - 根元の擬似 AO: `mix(0.5, 1.0, smoothstep(0, 0.35, t))`
   - **逆光トランスルーセンシー**: 視線が太陽と正対するとき tip 色を emissive 加算
     `back = clamp(dot(−viewDir, sunDir), 0, 1)² → emissive += tipColor·back·translucency·t`

### TSL 移植スケッチ

```jsx
// src/layers/GrassLayer.jsx
import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  Fn, float, vec2, vec3, uniform, positionGeometry, positionWorld,
  cameraPosition, transformNormalToView, instancedBufferAttribute,
  smoothstep, mix, clamp, dot, sin, cos, pow, select, time,
  mx_fractal_noise_float,
} from 'three/tsl'

const SEGMENTS = 5

// 2D fBM（world XZ）。mx_fractal_noise_float は ±1 を超えうるので 0..1 に clamp
const fbm2 = /*@__PURE__*/ Fn(([p]) => {
  return clamp(mx_fractal_noise_float(vec3(p, 0), 5).mul(0.5).add(0.5), 0, 1)
})

export default function GrassLayer({
  area = 40,          // 散布する正方形の一辺（world 単位）
  maxCount = 200000,  // 生成ブレード数（instanceCount で間引く）
  density = 0.15,     // 0..1
  getGroundHeight,    // TSL Fn: (vec2 worldXZ) => float（省略時はフラット）
}) {
  const { geometry, material } = useMemo(() => {
    /* ---- ベースジオメトリ: 縦ストリップ ---- */
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
    const iPosArr = new Float32Array(maxCount * 2)
    const iVarArr = new Float32Array(maxCount * 4) // yaw, height, width, phase
    const iMiscArr = new Float32Array(maxCount * 2) // curlVar, colorVar
    for (let i = 0; i < maxCount; i += 1) {
      iPosArr[i * 2] = (Math.random() - 0.5) * area
      iPosArr[i * 2 + 1] = (Math.random() - 0.5) * area
      iVarArr[i * 4] = Math.random() * Math.PI * 2
      iVarArr[i * 4 + 1] = 0.7 + Math.random() * 0.6
      iVarArr[i * 4 + 2] = 0.8 + Math.random() * 0.5
      iVarArr[i * 4 + 3] = Math.random() * Math.PI * 2
      iMiscArr[i * 2] = 0.6 + Math.random() * 0.8
      iMiscArr[i * 2 + 1] = Math.random()
    }
    const iPosAttr = new THREE.InstancedBufferAttribute(iPosArr, 2)
    const iVarAttr = new THREE.InstancedBufferAttribute(iVarArr, 4)
    const iMiscAttr = new THREE.InstancedBufferAttribute(iMiscArr, 2)
    geometry.setAttribute('iPos', iPosAttr)
    geometry.setAttribute('iVar', iVarAttr)
    geometry.setAttribute('iMisc', iMiscAttr)
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), area)

    /* ---- uniforms（leva 接続想定） ---- */
    const u = {
      coverage: uniform(0.62),
      maskScale: uniform(0.15),
      maskEdge: uniform(0.25),
      maskSeed: uniform(new THREE.Vector2(3.7, 9.1)),
      curl: uniform(1.14),
      height: uniform(1.5),
      width: uniform(0.05),
      windDir: uniform(new THREE.Vector2(1, 0.35).normalize()),
      windStrength: uniform(0.5),
      windSpeed: uniform(1.8),
      windScale: uniform(0.35),
      gust: uniform(0.6),
      colorBase: uniform(new THREE.Color(0x33421b)),
      colorTip: uniform(new THREE.Color(0x9bc24a)),
      colorVarAmt: uniform(0.47),
      translucency: uniform(0.6),
      sunDir: uniform(new THREE.Vector3(1, 1, 1).normalize()),
    }

    const iPos = instancedBufferAttribute(iPosAttr)
    const iVar = instancedBufferAttribute(iVarAttr)
    const iMisc = instancedBufferAttribute(iMiscAttr)

    /* ---- カバレッジマスク（T3 イディオム） ---- */
    const grassMask = Fn(([worldXZ]) => {
      const n = fbm2(worldXZ.mul(u.maskScale).add(u.maskSeed))
      const threshold = mix(float(1).add(u.maskEdge), u.maskEdge.negate(), u.coverage)
      return smoothstep(threshold.sub(u.maskEdge), threshold.add(u.maskEdge), n)
    })

    /* ---- ブレード形状（位置と法線を同じグラフで構築） ---- */
    const t = positionGeometry.y
    const side = positionGeometry.x

    const mask = grassMask(iPos)
    const h = u.height.mul(iVar.y).mul(mask)
    const w = u.width.mul(iVar.z)
      .mul(t.oneMinus())
      .mul(t.oneMinus().mul(0.3).add(0.7))
      .mul(mask)

    // 円弧カール（A→0 は微小クランプで直立に収束）
    const A = u.curl.mul(iMisc.x)
    const safeA = select(A.abs().greaterThan(0.001), A, float(0.001))
    const at = safeA.mul(t)
    const yA = h.mul(sin(at)).div(safeA)
    const zA = h.mul(cos(at).oneMinus()).div(safeA)
    const nLocal = vec3(0, sin(at).negate(), cos(at))

    // yaw 回転
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

    // コヒーレント風 + フラッター（先端ほど強く t²）
    const gph = dot(iPos, u.windDir).mul(u.windScale)
      .add(time.mul(u.windSpeed)).add(iVar.w)
    const gustWave = sin(gph).mul(0.6).add(sin(gph.mul(0.5).add(1.7)).mul(0.4))
    const flutter = sin(time.mul(8).add(iVar.w.mul(3))).mul(0.15).mul(u.gust)
    const sway = gustWave.add(flutter).mul(u.windStrength)
    const windOff = u.windDir.mul(sway).mul(t.mul(t))

    // 接地（T4: 共有ハイトフィールド。未指定ならフラット）
    const groundY = getGroundHeight ? getGroundHeight(iPos) : float(0)

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

    // グラデーション + 個体差 + 根元 AO
    material.colorNode = mix(u.colorBase, u.colorTip, t)
      .mul(mix(float(1).sub(u.colorVarAmt), float(1).add(u.colorVarAmt), iMisc.y))
      .mul(mix(float(0.5), float(1), smoothstep(0, 0.35, t)))

    // 逆光トランスルーセンシー
    const viewDir = cameraPosition.sub(positionWorld).normalize()
    const back = pow(clamp(dot(viewDir.negate(), u.sunDir), 0, 1), 2)
    material.emissiveNode = u.colorTip.mul(back).mul(u.translucency).mul(t)

    return { geometry, material }
  }, [area, maxCount, getGroundHeight])

  // 密度 = instanceCount のみ（再生成なし）
  useEffect(() => {
    geometry.instanceCount = Math.floor(maxCount * THREE.MathUtils.clamp(density, 0, 1))
  }, [geometry, maxCount, density])

  useEffect(() => () => {
    geometry.dispose()
    material.dispose()
  }, [geometry, material])

  return (
    <mesh
      geometry={geometry}
      material={material}
      frustumCulled={false}
      castShadow={false}
      receiveShadow
    />
  )
}
```

### 実装メモ

- `instancedBufferAttribute()` が three r183 の TSL に存在することを要確認。
  なければ `storage` + `instanceIndex` 参照（`createInterpolationPass.js` と同じパターン）に置換
- TSL は頂点属性を fragment で参照すると自動で varying 化されるので、
  `colorNode` / `emissiveNode` から `positionGeometry` や instanced 属性を直接使ってよい
- 地理配置する場合は `useProjection()` + `projectLonLatGPU()` で iPos を投影座標にする
- GPU 予算: 20 万ブレード生成 × density 0.13 ≒ 2.6 万描画が参照側の既定。
  当プロジェクトでは leva で density を調整しながら FPS を見て上限を決める
- 影は受けるのみ。`castShadow = true` にすると激重になるので禁止

### 受け入れ基準

- [ ] 1 ドローコールで草原が描画される（Stats で確認）
- [ ] leva で density / coverage / curl / wind を操作でき、即時反映される
- [ ] 風の gust 波が「野原を渡る」ように見える（全ブレード同位相のパタパタにならない）
- [ ] マスク境界でブレードが自然にフェードアウトする（プツプツ切れない）
- [ ] TerrainLayer / StageLayer と併用して 60fps 近辺を維持

---

## T2: 地形の濡れ表現 — RainLayer 連動（優先度: 中)

### 仕様

雨が降ると地形が濡れて「暗く・艶やかに」なる天候演出。RainLayer の稼働状態
（または leva の wetness 0..1）を TerrainLayer / StageLayer のマテリアルに接続する。

### アルゴリズム

world XZ の fBM で湿りパッチを作り、albedo を暗く・roughness を下げるだけ。
シェーダーコストはほぼゼロ。

```
wn      = fbm(worldXZ · moistScale + seed) · 0.5 + 0.5
thresh  = mix(1 + edge, −edge, wetness)        // wetness 0 → 全乾, 1 → 全湿
wet     = smoothstep(thresh − edge, thresh + edge, wn)
albedo  *= mix(1.0, wetDarken, wet)            // wetDarken ≈ 0.5
rough    = mix(rough, wetRoughness, wet)       // wetRoughness ≈ 0.35
```

### TSL 移植スケッチ（TerrainLayer への追記イメージ）

```js
const uWetness = uniform(0)            // 0..1（RainLayer 稼働率 or leva）
const uWetDarken = uniform(0.5)
const uWetRoughness = uniform(0.35)
const uMoistScale = uniform(0.18)
const uMoistEdge = uniform(0.12)
const uMoistSeed = uniform(new THREE.Vector2(5, 5))

const wn = clamp(
  mx_fractal_noise_float(
    vec3(positionWorld.xz.mul(uMoistScale).add(uMoistSeed), 0), 5
  ).mul(0.5).add(0.5), 0, 1)
const wThresh = mix(float(1).add(uMoistEdge), uMoistEdge.negate(), uWetness)
const wet = smoothstep(wThresh.sub(uMoistEdge), wThresh.add(uMoistEdge), wn)

material.colorNode = baseColor.mul(mix(float(1), uWetDarken, wet))
material.roughnessNode = mix(baseRoughness, uWetRoughness, wet)
```

### 受け入れ基準

- [ ] wetness 0→1 で乾いた土 → 濡れた土に連続変化する
- [ ] 濡れた領域がパッチ状（全面一様でない）
- [ ] RainLayer の ON/OFF（または降雨強度）に追従する

---

## T3: カバレッジマスク共通イディオム（優先度: 中）

参照側が moss / grass / moisture / tone variation の全部で使っていた統一パラメータ化。
**新規実装ではなく、T1/T2/T5 で同じ形を使い回すための規約**として記録する。

- パラメータ 3 点セット: `coverage`（0=なし〜1=全面）/ `edge`（境界の柔らかさ）/
  `seed`（vec2。ランダマイズ = パンするだけで再生成不要）
- 閾値リマップが肝: `threshold = mix(1 + edge, −edge, coverage)`
  → coverage 0/1 の端でも smoothstep の幅が潰れず、スライダー全域が滑らかに効く

```js
// 汎用 Fn（src/gis/ ではなく共通 util に置く想定）
const coverageMask = /*@__PURE__*/ Fn(([worldXZ, scale, seed, coverage, edge]) => {
  const n = clamp(
    mx_fractal_noise_float(vec3(worldXZ.mul(scale).add(seed), 0), 5)
      .mul(0.5).add(0.5), 0, 1)
  const threshold = mix(float(1).add(edge), edge.negate(), coverage)
  return smoothstep(threshold.sub(edge), threshold.add(edge), n)
})
```

leva 側も `coverage / patchScale / patchSoftness / 🎲 seed` の並びで統一する。

---

## T4: 共有ハイトフィールドパターン（優先度: 中、T1 の前提）

### 概念

地面の高さ関数を**単一の TSL `Fn` として export** し、以下の全消費者で共有する:

1. 地面メッシュの頂点変位（`positionNode`）
2. 地面の解析法線（fragment で有限差分 → 陰影がシルエットと一致）
3. 草・置物の接地（T1 の `getGroundHeight`）
4. パーティクル衝突（RainLayer は既に DEM 衝突を持つので統合検討のみ）

参照側の教訓: 高さの「真実の源」を 1 つにすると、地形をスライダーでいじっても
草・陰影・シルエットが同時に追従し、破綻しない。

### TSL スケッチ（手続き地形の場合）

```js
// src/layers/groundField.js（新設想定）
export const createGroundField = ({ moundScale, moundDepth, seed, rim }) => {
  const heightAt = Fn(([worldXZ]) => {
    const base = clamp(
      mx_fractal_noise_float(vec3(worldXZ.mul(moundScale).add(seed), 0), 5)
        .mul(0.5).add(0.5), 0, 1)
    // ステージ端で 0 に teardown（浮いた崖を作らない）
    const edge = smoothstep(float(rim), float(rim * 0.8), worldXZ.abs())
    return base.mul(moundDepth).mul(edge.x).mul(edge.y)
  })

  // 有限差分の解析法線（fragment 用）
  const normalAt = Fn(([worldXZ]) => {
    const e = float(0.08)
    const h0 = heightAt(worldXZ)
    const hx = heightAt(worldXZ.add(vec2(e, 0)))
    const hz = heightAt(worldXZ.add(vec2(0, e)))
    return vec3(h0.sub(hx).div(e), 1, h0.sub(hz).div(e)).normalize()
  })

  return { heightAt, normalAt }
}
```

TerrainLayer（DEM ベース）に草を生やす場合は、`heightAt` を DEM テクスチャの
サンプリングに差し替えれば T1 側は無変更で済む — これがこのパターンの狙い。

---

## T5: Worley クラック — 乾裂した大地（優先度: 低）

### アルゴリズム

- セルラー（Worley）ノイズの **F2 − F1**（最近傍と第 2 近傍の距離差）はセル境界で
  0 になる → `1 − smoothstep(0, width, F2−F1)` で多角形プレート間の亀裂網になる
- 入力座標を fBM でドメインワープすると縁が有機的に蛇行する
- 2.7 倍周波数の第 2 層（強度 0.5）で大プレートを細分割すると「干上がった湖底」らしくなる
- **法線の溝彫り**: クラック強度の有限差分勾配で法線を亀裂側に倒すと、
  壁面が光を拾ってフラットなデカールでなく「彫れた溝」に見える

```
crack   = max(primary, secondary·0.5)
albedo *= 1 − 0.7·crack
rough   = mix(rough, 1.0, crack)          // 亀裂内はマット
grad    = ∇crack（有限差分 e≈0.02）
crackN  = normalize(−grad.x·depth, 1, −grad.y·depth)
normal  = mix(normal, crackN, smoothstep(0.02, 0.5, crack))
```

### TSL 移植スケッチ

`mx_worley_noise_float` は F1 相当しか返さないため F1/F2 は自前実装が必要:

```js
const hash22 = /*@__PURE__*/ Fn(([p]) => {
  const q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))
  return fract(sin(q).mul(43758.5453123))
})

// 3×3 近傍を JS ループで展開（TSL Loop でも可）
const worleyF1F2 = /*@__PURE__*/ Fn(([x]) => {
  const n = floor(x)
  const f = fract(x)
  const f1 = float(8).toVar()
  const f2 = float(8).toVar()
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const g = vec2(i, j)
      const r = g.add(hash22(n.add(g))).sub(f)
      const d = dot(r, r)
      If(d.lessThan(f1), () => {
        f2.assign(f1)
        f1.assign(d)
      }).ElseIf(d.lessThan(f2), () => {
        f2.assign(d)
      })
    }
  }
  return vec2(sqrt(f1), sqrt(f2))
})

const crackAt = Fn(([xz]) => {
  const warp = vec2(
    mx_fractal_noise_float(vec3(xz.mul(uCrackScale.mul(0.5)).add(uCrackSeed).add(3.1), 0), 5),
    mx_fractal_noise_float(vec3(xz.mul(uCrackScale.mul(0.5)).add(uCrackSeed).add(7.7), 0), 5)
  ).mul(uCrackWarp)
  const cp = xz.mul(uCrackScale).add(uCrackSeed).add(warp)
  const w = max(uCrackWidth, 0.001)
  const f = worleyF1F2(cp)
  const primary = smoothstep(float(0), w, f.y.sub(f.x)).oneMinus()
  const f2nd = worleyF1F2(cp.mul(2.7).add(13))
  const secondary = smoothstep(float(0), w.mul(1.6), f2nd.y.sub(f2nd.x)).oneMinus().mul(0.5)
  return clamp(max(primary, secondary), 0, 1)
})
```

パラメータ既定値（参照側）: scale 0.9 / width 0.06 / warp 0〜2 / depth 0.7。

---

## T6: モデルへの苔・風化堆積（優先度: 低）

### アルゴリズム

任意 GLB の**上向き面**にだけ苔（または雪・埃）を成長させる。メッシュ解析不要:

```
up    = clamp(worldNormal.y, 0, 1)
top   = smoothstep(flatThreshold, 1, up)        // flatThreshold ≈ 0.35
accum = top × coverageMask(modelXZ)             // T3 のマスク（モデル空間 XZ）
```

- **モデル空間で評価する**のが肝: world→model の逆行列（`uModelInv`）を通した座標で
  ノイズを引くと、モデルを動かしてもパターンが張り付いたまま
- 頂点ステージ: `positionNode += normalLocal · thickness · accum`。
  スケール非依存にするには world 法線長で割って補正
- フラグメント: `accum` で albedo / roughness を苔側に mix、
  法線は「world up + fBM 微起伏」の relief 法線へ mix

TSL では `objectWorldMatrix` の逆行列 uniform を CPU で渡すか、
`positionLocal` を直接使えばモデル固定はさらに簡単。展示物（GLB）の
風化 lookdev として面白いが、現状ユースケースがないので保留。

---

## T7: フィルムグレードパス（優先度: 低、SceneEffects 復帰時）

表示空間（トーンマップ後）の 1 パスで「フィルム撮影」感を出す。全て安価:

```
dir = uv − 0.5
// 放射状の色収差（端ほど強い）
ca  = chroma · dot(dir, dir) · 4
r   = sample(uv − dir·ca).r,  g = sample(uv).g,  b = sample(uv + dir·ca).b
// コントラスト / 彩度
col = (col − 0.5)·contrast + 0.5
col = mix(vec3(luma), col, saturation)
// ビネット
col *= 1 − smoothstep(0.85, size, length(dir)) · vignette
// アニメーショングレイン
col += (hash(uv + fract(time)) − 0.5) · grain
```

SceneEffects の `rp.outputNode` の最終段に TSL でそのまま組める
（`createBloom.js` 等と同じ `create*Pass()` 分割で `createFilmGrade.js` に）。
SceneEffects 自体が GPU 予算で無効化中のため、復帰させるときに合わせて検討。

---

## 対応不要と判断したもの

### 体積雲（clouds.js）→ 既存 CloudLayer が同等以上

参照側の雲テクニックは既存 `CloudLayer.jsx` にすべて実装済みであることを確認した:

| 参照側のテクニック | CloudLayer の対応 |
|---|---|
| レイ開始のディザ（バンディング隠し） | 実装済み（`hash(screenCoordinate)` ジッター。time を混ぜない改良付き） |
| 透過率での早期 Break | 実装済み（`MARCH.transmittanceMin`） |
| Henyey-Greenstein 位相 | 実装済み（係数前計算付き） |
| 高さ減衰カバレッジ（有機的な雲頂） | 実装済み（垂直プロファイル + `towerByWeather` で上位互換） |
| detail 侵食（縁のちぎれ） | 実装済み（wispy/billow 切替・高さ依存の挙動切替で上位互換） |
| セルフシャドウのライトマーチ | 実装済み（安い `sampleBase` 近似でコスト 1/4 の改良付き） |
| エネルギー保存積分 | 実装済み（front-to-back 前割り） |

唯一未実装なのは**低解像度レンダリング + フル解像度アップサンプル合成**
（雲だけ half/quarter 解像度の別パスで描く。TDR 対策として効果大）。
ただし scenePass 構成の変更が必要で工事が大きく、現行の steps≈12・1 層構成で
予算内に収まっているため**保留**。将来 steps を上げたくなったときの第一候補。

### その他

- **postfx.js の EffectComposer 構成**（UnrealBloomPass / BokehPass / MSAA RT）:
  WebGL 専用。当プロジェクトは WebGPU ネイティブの `RenderPipeline` 系で既により良い形
- **土壌 PBR テクスチャ運用**: 汎用知識。必要なら ambientCG（CC0）から直接取得
- **DoF フォーカス面ビジュアライザ**: DoF 自体が無効化中のため不要
- **lil-gui**: 当プロジェクトは leva で統一
