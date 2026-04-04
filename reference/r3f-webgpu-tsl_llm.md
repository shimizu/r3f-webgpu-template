# React Three Fiber + WebGPU + TSL テクニック集

このドキュメントは、React Three Fiber (R3F) 上で WebGPU と TSL (Three.js Shading Language) を使うために必要なテクニックを網羅的にまとめたものである。LLM がコード生成時に参照することを想定している。

---

## 1. 環境セットアップ

### 1.1 import 体系

TSL を使うには 3 系統の import を使い分ける。

```js
// React Three Fiber
import { Canvas, useThree, useFrame } from '@react-three/fiber'

// Drei (R3F ヘルパー)
import { OrbitControls } from '@react-three/drei'

// Three.js WebGPU / TSL
import * as THREE from 'three/webgpu'
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu'
import { color, positionLocal, /* ... */ } from 'three/tsl'
```

- `three/tsl`: TSL ノード関数の import 元
- `three/webgpu`: WebGPURenderer や NodeMaterial 系クラスの import 元
- TSL は WebGPU 専用ではなく、WGSL と GLSL の両方にコンパイルされる

### 1.2 WebGPURenderer の初期化 (R3F)

WebGPURenderer は非同期初期化が必要。R3F では `Canvas` の `gl` に async ファクトリーを渡す。

```jsx
<Canvas
  camera={{ position: [0, 0, 1] }}
  gl={async (canvas) => {
    const renderer = new WebGPURenderer({ canvas, antialias: true })
    await renderer.init()
    return renderer
  }}
>
  {/* children */}
</Canvas>
```

**注意**: `await renderer.init()` を忘れると何も描画されないがエラーも出にくい。

### 1.3 Drei との互換性

R3F + WebGPU でも以下の Drei コンポーネントはそのまま動く。

- `OrbitControls`
- `Environment`
- `useGLTF`
- `Text`
- `Html`

ただし `@react-three/postprocessing` (EffectComposer, Bloom 等) は個別検証が必要。推奨は TSL ネイティブエフェクト。

---

## 2. TSL 基礎

### 2.1 NodeMaterial と colorNode

TSL の出発点は、NodeMaterial にノードを差し込むことである。

```js
const material = new MeshBasicNodeMaterial()
material.colorNode = color('crimson')
```

- `colorNode`: マテリアルの最終色を決めるノード
- `fragmentNode`: 元教材で使われる低レベルなエントリポイント（`colorNode` の方が R3F では扱いやすい）
- `MeshBasicNodeMaterial`: ライティング不要の確認に最適

### 2.2 R3F でのマテリアル管理パターン

マテリアルは `useState` で一度だけ作り、`useEffect` で dispose する。

```jsx
function TslPlane() {
  const [material] = useState(() => {
    const mat = new MeshBasicNodeMaterial()
    mat.colorNode = positionLocal
    return mat
  })

  useEffect(() => {
    return () => material.dispose()
  }, [material])

  return (
    <mesh material={material}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  )
}
```

### 2.3 背景ノード (backgroundNode)

raymarching など、mesh ではなくシーン全体に shader を適用する場合は `scene.backgroundNode` を使う。

```js
const { scene } = useThree()
scene.backgroundNode = myRaymarchNode
```

---

## 3. TSL ノード関数一覧と用途

### 3.1 座標・属性ノード

| ノード | 説明 |
|---|---|
| `positionLocal` | オブジェクトのローカル座標 (vec3) |
| `uv()` | UV 座標 |
| `normalLocal` | ローカル法線 |

`positionLocal` をそのまま `colorNode` に渡すと、座標値が RGB として可視化される。

### 3.2 数学関数

| 関数 | 用途 |
|---|---|
| `abs(x)` | 絶対値。マスク作り、SDF の輪郭化 |
| `fract(x)` | 小数部分。繰り返しパターンの基本 |
| `step(edge, x)` | 閾値で 0/1 に二値化 |
| `smoothstep(edge0, edge1, x)` | 滑らかな補間。距離場を線やマスクへ変換 |
| `length(v)` | ベクトルの長さ。円形パターン、SDF の基本 |
| `dot(a, b)` | 内積。方向射影、Lambert diffuse |
| `cross(a, b)` | 外積。カメラ right/up ベクトルの計算 |
| `normalize(v)` | 正規化 |
| `clamp(x, min, max)` | 値の範囲制限。無限直線を線分にする |
| `mix(a, b, t)` | 線形補間。色の合成、レイヤー合成の基本 |
| `sin(x)`, `cos(x)` | 三角関数。波、アニメーション |
| `atan(y, x)` | 角度。極座標パターン、花・蝶 SDF |
| `pow(base, exp)` | べき乗。specular の鋭さ、Fresnel |
| `min(a, b)` | SDF union (和集合) |
| `max(a, b)` | SDF intersection (積集合) |
| `negate(x)` | 符号反転。SDF subtraction に使う |
| `reflect(incident, normal)` | 反射ベクトル。specular, reflection ray |
| `rotateUV(uv, angle, center)` | 2D 座標回転。模様の回転、楕円 SDF |

### 3.3 ベクトル・スカラー構築

```js
vec2(x, y)    // 2D ベクトル
vec3(x, y, z) // 3D ベクトル
float(x)      // スカラー
color('name') // 色ノード
```

### 3.4 時間

```js
import { time } from 'three/tsl'
// time は毎フレーム自動で増加するビルトインノード
sin(p.mul(10).add(time)) // アニメーション
```

### 3.5 ノイズ関数

```js
import { mx_noise_float, mx_worley_noise_vec3 } from 'three/tsl'
```

| 関数 | 用途 |
|---|---|
| `mx_noise_float(position)` | Perlin 系ノイズ。地形の凹凸、条件分岐の入力 |
| `mx_worley_noise_vec3(uv)` | Worley (Cellular) ノイズ。有機的テクスチャ |

---

## 4. TSL プログラミングパターン

### 4.1 `Fn` によるノード関数定義

複数ステップの処理をまとめる。

```js
const main = Fn(() => {
  const p = positionLocal.toVar()
  p.mulAssign(5)
  p.assign(p.fract().sub(0.5))
  p.assign(length(p))
  return p
})

material.colorNode = main()
```

引数付き関数:

```js
const Circle = Fn(([position, radius]) => {
  return length(position).sub(radius)
})
```

### 4.2 `.toVar()` による一時変数

途中で値を更新するには `.toVar()` で mutable 変数を作る。

```js
const p = positionLocal.toVar()  // 書き換え可能
p.assign(rotateUV(p.xy, time, vec2()))  // 代入
p.z.assign(1)  // 成分への代入
p.mulAssign(5)  // 複合代入
p.addAssign(offset)
```

### 4.3 `If` / `Loop` / `Break` による制御構造

これらは JavaScript の制御構文ではなく、shader に落とし込まれる TSL ノードである。

```js
// 条件分岐
If(abs(p.x).greaterThan(0.45), () => {
  p.z.assign(1)
})

// 比較メソッド: .lessThan(), .greaterThan(), .equal()

// ループ
Loop({ start: 0, end: maxSteps }, () => {
  // 処理
})

// ループ脱出
If(condition, () => {
  Break()
})
```

### 4.4 `select` による条件カラーリング

```js
const colour = select(
  sdfScene.lessThan(0),  // 条件
  insideColour,           // true の場合
  outsideColour           // false の場合
)
```

### 4.5 メソッドチェーン

TSL ノードにはメソッドチェーン形式もある。

```js
positionLocal.mul(4.9999).fract().step(0.5)
positionLocal.length().mul(15).fract().step(0.5)
sdfScene.mul(75).add(time).sin().abs()
dot(viewDirection, normal).oneMinus().pow(power)
```

### 4.6 `.toVar("name")` による変数名付け

デバッグ時に生成 shader 内の変数名を読みやすくする。

```js
const p = positionLocal.toVar("myPosition")
```

---

## 5. uniform による外部パラメータ制御

### 5.1 `uniform(...)` - 単一値

```js
import { uniform } from 'three/tsl'

const radius = uniform(0.1)
const intensity = uniform(2.0)

// shader 内で使用
distance.assign(pow(radius.div(distance), intensity))

// JavaScript から更新
radius.value = newValue
```

### 5.2 `uniformArray(...)` - 配列

```js
import { uniformArray } from 'three/tsl'
import { Color } from 'three'

const colours = uniformArray([
  new Color('#ff0d4d'),
  new Color('#1a66ff'),
  new Color('#33ff33'),
], 'color')

// shader 内で使用
colours.element(i)

// JavaScript から更新 (オブジェクトを .set() で更新)
colours.array[0].set('#ffffff')
```

### 5.3 R3F での uniform パターン

`useState` で一度だけ作り、GUI や `useFrame` から `.value` を更新する。

```jsx
const [radiusUniform] = useState(() => uniform(0.1))

// Leva からの値同期
useEffect(() => {
  radiusUniform.value = controls.radius
}, [controls.radius])

// useFrame からの毎フレーム更新
useFrame((state) => {
  cameraPositionUniform.value.copy(state.camera.position)
})
```

---

## 6. テクスチャ

```js
import { texture, convertColorSpace } from 'three/tsl'

material.colorNode = texture(myTexture)

// 色空間変換
material.colorNode = convertColorSpace(
  texture(myTexture),
  THREE.SRGBColorSpace,
  THREE.LinearSRGBColorSpace
)
```

---

## 7. 2D SDF (Signed Distance Field)

### 7.1 基本概念

SDF は「点から最も近い表面までの距離」を返す関数。

- 正: 外側
- 0: 表面
- 負: 内側

### 7.2 基本図形

```js
// 円
const Circle = Fn(([position, radius]) => {
  return length(position).sub(radius)
})

// 楕円 (座標変換 + 円)
const Ellipse = Fn(([position, radius, scale, angle]) => {
  const angledPosition = rotateUV(position, angle, vec2())
  const scaledPosition = angledPosition.mul(scale)
  return length(scaledPosition).sub(radius)
})

// 箱
const Box = Fn(([position, dimensions, angle]) => {
  const angledPosition = rotateUV(position, angle, vec2())
  const distance = abs(angledPosition).sub(dimensions)
  return length(max(distance, 0)).add(min(max(distance.x, distance.y), 0))
})
```

### 7.3 SDF ブーリアン演算

```js
// Union (合体): min
const united = min(circleDistance, boxDistance)

// Intersection (交差): max
const intersected = max(circleDistance, boxDistance)

// Subtraction (切り抜き): max + negate
const subtracted = max(negate(innerCircle), outerCircle)
```

### 7.4 SDF の輪郭化 (リング)

```js
// abs で表面からの距離に変換し、厚みを引く
const torus = Circle(p, radius).abs().sub(0.05)
```

### 7.5 角度依存 SDF (花・蝶)

```js
const circleAngle = atan(position.y, position.x)
const bumps = cos(circleAngle.mul(frequency)).mul(amplitude)
return length(position).sub(radius).add(bumps)
```

### 7.6 SDF の可視化

```js
// グレースケール距離表示
vec3(1).mul(sdfDistance)

// distance lines (等高線アニメーション)
colour.mul(sdfScene.mul(75).add(time).sin().abs())

// inside/outside 色分け
select(sdfScene.lessThan(0), insideColour, outsideColour)

// 塗りマスクへの変換
Circle(p, radius).smoothstep(0.005, 0)
```

### 7.7 SDF マスクによるレイヤー合成

```js
const circleMask = Circle(p, radius).smoothstep(0.005, 0)
const finalColour = mix(vec3(0), color('crimson'), circleMask).toVar()
finalColour.assign(mix(finalColour, patternColour, nextMask))
```

---

## 8. 線分の描画 (距離場ベース)

```js
// 線分の距離場
const Line = Fn(([position, direction, distance, thickness]) => {
  const projection = dot(position, direction)
  const clampedProjection = clamp(projection, 0, distance)
  const lineDistance = length(position.sub(clampedProjection.mul(direction)))
  return smoothstep(thickness, 0, lineDistance)
})

// 円の輪郭線
const Circle = Fn(([position, radius, thickness]) => {
  const signedDistance = length(position).sub(radius)
  return smoothstep(thickness, 0, abs(signedDistance))
})
```

---

## 9. 模様生成パイプライン

### 9.1 チェック柄

```js
positionLocal.mul(4.9999).fract().step(0.5)
```

### 9.2 同心円リング

```js
positionLocal.length().mul(15).fract().step(0.5)
```

### 9.3 アニメーション波リング

```js
const p = positionLocal.toVar()
p.mulAssign(5)
p.assign(p.fract().sub(0.5))
p.assign(length(p))
p.assign(sin(p.mul(10).add(time)))
p.assign(abs(p))
p.assign(step(0.5, p))
```

### 9.4 渦 (Swirl)

```js
const angle = atan(position.y, negate(position.x))
const len = length(position)
return sin(len.mul(-20).add(angle).mul(4))
```

### 9.5 ストライプ / ブロック

```js
// mod でタイル
vec3(position.mul(20).mod(2))

// fract + step でブロック
position.mul(scale).fract().step(0.5)
```

---

## 10. 3D Raymarching

### 10.1 基本構造

raymarching はピクセルごとに ray を飛ばし、SDF で表面を探す描画手法。通常の mesh + geometry + material とは別の描画パイプラインである。

```js
const Raymarcher = Fn(() => {
  const rayOrigin = uniforms.cameraPosition.toVar()
  const rayDirection = normalize(/* ... */).toVar()
  const accumulatedDistance = float(0).toVar()
  const position = vec3(0).toVar()
  const distance = float(0).toVar()

  Loop({ start: 0, end: maxSteps }, () => {
    position.assign(rayOrigin.add(rayDirection.mul(accumulatedDistance)))
    distance.assign(sdfScene(position))
    accumulatedDistance.addAssign(distance)

    If(
      abs(distance).lessThan(surfaceDistance)
        .or(accumulatedDistance.greaterThan(cameraFar)),
      () => { Break() }
    )
  })

  return /* shading result */
})
```

### 10.2 カメラ ray の構築

```js
const forward = normalize(lookAt.sub(rayOrigin))
const right = normalize(cross(vec3(0, 1, 0), forward))
const up = cross(forward, right)

const rayDirection = normalize(
  forward.add(right.mul(p.x)).add(up.mul(p.y))
)
```

### 10.3 R3F カメラ連携

`useFrame` で R3F のカメラ情報を uniform 経由で shader に渡す。

```jsx
useFrame((state) => {
  cameraPositionUniform.value.copy(state.camera.position)
  cameraTargetUniform.value.copy(controlsRef.current.target)
})
```

### 10.4 3D SDF プリミティブ

2D SDF と同じ関数構造を 3D に拡張する。`min`/`max`/`negate` による union/intersection/subtraction もそのまま使える。

### 10.5 scene SDF に id を返す

3D では scene SDF が何度も呼ばれるため、色計算を分離する。

```js
// vec2(distance, materialId) を返す
const sdfScene = Fn(([position]) => {
  const distance = vec2(floorDist, 0).toVar()
  If(distance.x.greaterThan(sphereDist), () => {
    distance.assign(vec2(sphereDist, 1))
  })
  return distance
})

// raymarch / normal / shadow は .x (距離) だけを使う
// hit 後の shading でだけ .y (id) で色を決める
```

### 10.6 raymarching と mesh の共存

- 簡単: `scene.backgroundNode` に raymarching、通常 mesh を前面に置く
- 中程度: fullscreen plane の fragment shader で raymarching
- 難しい: raymarched object と通常 mesh を同一 3D 空間で合成 (depth 処理が必要)

---

## 11. 法線計算 (SDF ベース)

hit 位置の周囲で SDF を再評価し、勾配ベクトルから法線を近似する。

```js
const getNormal = Fn(([position, distance]) => {
  const offset = vec2(surfaceDistance, 0)
  return normalize(
    distance.sub(
      vec3(
        sdfScene(position.sub(offset.xyy)).x,
        sdfScene(position.sub(offset.yxy)).x,
        sdfScene(position.sub(offset.yyx)).x
      )
    )
  )
})
```

---

## 12. ライティング

### 12.1 Lambert Diffuse

```js
const lightDirection = normalize(lightPosition.sub(position))
const diffuse = clamp(dot(normal, lightDirection), 0, 1)
```

### 12.2 Ambient

```js
const ambient = vec3(1).mul(ambientStrength)
// hit した物体表面にだけ足す (背景には適用しない)
```

### 12.3 Phong Specular

```js
const viewDirection = normalize(rayOrigin.sub(position))
const shineDirection = reflect(lightDirection.negate(), normal)
const specularIntensity = pow(
  clamp(dot(viewDirection, shineDirection), 0, 1),
  shininess
).mul(specularStrength)
```

### 12.4 最終色の合成

```js
finalColour.assign(
  ambientColour.mul(ambient)
    .add(diffuseColour.mul(diffuse))
    .add(specularColour.mul(specularIntensity))
)
```

---

## 13. Shadow (影)

### 13.1 Shadow Ray の基本

hit 点から light 方向へ 2 本目の raymarch を行う。

```js
const shadowMarcher = Fn(([origin, direction]) => {
  const shadow = float(1).toVar()
  const accumulatedDistance = float(0).toVar()

  Loop({ start: 0, end: shadowMaxSteps }, () => {
    const position = origin.add(direction.mul(accumulatedDistance))
    const distance = sdfScene(position)

    // Hard shadow
    If(abs(distance).lessThan(surfaceDistance), () => {
      shadow.assign(0)
      Break()
    })

    accumulatedDistance.addAssign(distance)
  })

  return shadow
})
```

### 13.2 Self-shadowing 回避

shadow ray の始点は normal 方向に少し押し出す。

```js
const shadowOrigin = position.add(normal.mul(surfaceDistance))
```

### 13.3 Soft Shadow

```js
shadow.assign(min(shadow, shadowSoftness.mul(distance).div(accumulatedDistance)))
```

### 13.4 shadow は diffuse にだけ掛ける

```js
diffuse.mulAssign(shadow)
// ambient と specular はそのまま残す
```

---

## 14. Reflection (反射)

### 14.1 Reflection Ray

hit 点で法線を使って反射 ray を作り、再度 raymarch する。

```js
// bounce ループ
rayOrigin.assign(position.add(normal.mul(surfaceDistance)))
rayDirection.assign(reflect(rayDirection, normal))
```

### 14.2 反射色の蓄積

```js
const reflectivityFactor = float(1).toVar()

// 各 bounce で
finalColour.addAssign(surfaceColour.mul(reflectivityFactor))
reflectivityFactor.mulAssign(reflectivity)
```

### 14.3 bounce 時の viewDirection

reflection 時は camera 位置ではなく、入射 ray の逆向きを使う。

```js
const viewDirection = normalize(rayDirection.negate())
```

### 14.4 背景色がある場合の reflection 合成

背景が黒でない場合、`addAssign` ではなく `mix` を使う。

```js
finalColour.assign(
  mix(finalColour, surfaceColour, reflectivityFactor)
)
```

---

## 15. Ambient Occlusion (AO)

hit 点の法線方向に複数サンプルを取り、近傍に遮蔽物があるかを見る。

```js
const computeAO = Fn(([position, normal]) => {
  const occlusion = float(0).toVar()
  const spacer = float(1).toVar()

  Loop({ start: 0, end: samples }, () => {
    const samplePos = position.add(normal.mul(spacer.mul(spread)))
    const distance = sdfScene(samplePos)
    occlusion.addAssign(smoothstep(0.0, 0.1, distance))
    spacer.addAssign(1)
  })

  return occlusion.div(float(samples))
})

// diffuse に掛ける
diffuse.mulAssign(ao)
```

shadow とは独立した仕組みで、directional light の有無にかかわらず接地感を出せる。

---

## 16. Fresnel Effect

視線角度に応じて表面色を変化させる。

```js
const fresnel = Fn(([viewDirection, normal, power, bias, scale]) => {
  return bias.add(
    scale.mul(dot(viewDirection, normal).oneMinus().pow(power))
  )
})

const surfaceColour = mix(
  diffuseColour.mul(diffuse),
  grazingColour.mul(diffuse),
  fresnelFactor
)
```

- 正面: base colour が強い
- 輪郭 (grazing angle): environment colour が強い
- 水面の材質感に特に効果的

---

## 17. Atmospheric Scattering (空)

sky colour を生成する関数で、background と surface 両方の colour source として使える。

構成要素:
- horizon gradient
- sun glow
- mie scattering (暖色)
- rayleigh scattering (青み)
- 夜側への減衰

```js
const skyColour = atmosphericScattering(position, normalize(lightPosition))
const finalColour = skyColour.toVar()  // 何も hit しないピクセルの色

// surface の diffuse colour にも sky を使うと一体感が出る
const diffuseColour = atmosphericScattering(
  reflect(rayDirection, normal),
  normalize(lightPosition)
)
```

---

## 18. Fog (霧)

距離に応じて色を空色へ寄せる。

```js
// fog は distance に応じた mix で実装
finalColour.assign(mix(finalColour, fogColour, fogFactor))
```

---

## 19. FBM (Fractal Brownian Motion)

ノイズを複数 octave 重ねて自然な地形を作る。

```js
const fbm = Fn(([position]) => {
  const accumulator = float(0).toVar()
  const amplitude = float(1).toVar()
  const p = position.toVar()

  Loop({ start: 0, end: octaves }, () => {
    accumulator.addAssign(amplitude.mul(noise(p)))
    amplitude.mulAssign(gain)
    p.mulAssign(lacunarity.mul(rotationMatrix))
  })

  return accumulator
})
```

- `octaves`: 重ねる回数 (多いほど細部が増える)
- `lacunarity`: 各 octave での周波数倍率
- `gain`: 各 octave での振幅減衰
- 座標回転を混ぜると人工的な格子感が崩れる
- 高さ場として `position.y.sub(fbm(position))` にすれば SDF 化できる

---

## 20. Ocean (水面)

### 20.1 Gerstner Wave

FBM より軽い周期的な水面表現。

```js
const gerstnerWave = Fn(([wave, gridPoint]) => {
  // wave: vec4(directionX, directionY, steepness, wavelength)
  // 複数の波を重ねて水面を作る
})

// 3 本の wave を合成
p.addAssign(gerstnerWave(waveA, gridPoint))
p.addAssign(gerstnerWave(waveB, gridPoint))
p.addAssign(gerstnerWave(waveC, gridPoint))
return p.y
```

### 20.2 水面の shading

水面は sky colour を base に Fresnel を強めに効かせると自然に見える。

---

## 21. Clouds (雲)

land の FBM を流用しつつ、より粗い設定で雲レイヤーを作る。

- `octaves: 3`, `lacunarity: 3.5`, `gain: 0.3` など軽めの設定
- `position.y > bottom` のときだけ生成
- reflection 対象にせず、空色ベースで明るく混ぜる

---

## 22. パフォーマンス最適化

### 22.1 Adaptive DPR

FPS を監視して `renderer.setPixelRatio()` を動的に調整する。

```jsx
function AdaptiveDprController() {
  useFrame((state) => {
    const fps = /* FPS 計算 */
    const currentDpr = state.gl.getPixelRatio()

    if (fps < targetFps * 0.95) {
      state.gl.setPixelRatio(currentDpr * 0.9)
    } else if (fps > targetFps) {
      state.gl.setPixelRatio(Math.min(currentDpr * 1.1, maxDpr))
    }
  })
  return null
}
```

- target FPS は理想値より低めに設定 (例: 60fps 理想なら 45fps 目標)
- 0.9 / 1.1 のような小さな倍率で徐々に調整
- shader を変えずに負荷を吸収できる

### 22.2 scene SDF を軽く保つ

raymarch、shadow、reflection、normal が全て同じ scene SDF を共有するため、この関数は軽く保つことが重要。色計算は hit 後にまとめて行う。

---

## 23. デバッグ

### 23.1 生成 shader の確認

```js
const { gl, scene, camera } = useThree()
const meshRef = useRef()

useEffect(() => {
  gl.debug.getShaderAsync(scene, camera, meshRef.current).then((result) => {
    console.log(result.fragmentShader)
  })
}, [gl, scene, camera])
```

TSL がどのような shader code に変換されたか実行時に確認できる。

---

## 24. コード構成パターン

### 24.1 小規模 (tutorial 1-10)

- `App.jsx`: Canvas + WebGPU renderer
- `Scene.jsx`: OrbitControls + mesh + TSL ロジック

### 24.2 大規模 raymarching scene (tutorial 21+)

```
App.jsx                    - Canvas, WebGPU 初期化
Scene.jsx                  - Leva GUI, composition
AdaptiveDprController.jsx  - DPR 制御
AtmosphericScattering.js   - 空色生成
AmbientOcclusion.js        - AO 計算
ShadowMarcher.js           - Shadow ray
Fog.js                     - 霧の合成
Land.js                    - 地形 SDF + shading
Ocean.js                   - 水面 SDF + shading
Clouds.js                  - 雲 SDF + shading
SdfScene.js                - Orchestration (raymarch loop, light, normal, fog)
```

### 24.3 責務分離の原則

- **TSL 側**: 見た目の計算 (SDF, lighting, pattern)
- **React 側**: 状態管理 (入力, カメラ同期, GUI → uniform 更新)
- **scene SDF**: 距離場の定義のみ (色計算を混ぜない)
- **shading**: hit 後にだけ実行 (material id で色分け)

---

## 25. R3F + WebGPU 移行時の注意点

1. `gl` ファクトリーは必ず async にする (`await renderer.init()` 必須)
2. `three/webgpu` と `three/tsl` の import を使い分ける
3. WebGL 固有の判定 (`gl.capabilities.isWebGL2`) に依存しない
4. WebGPU 判定が必要なら `gl.isWebGPURenderer` を使う
5. postprocessing は個別検証が必要
6. TSL は WebGPU 専用ではなく、GLSL/WGSL 両方にコンパイルされる
