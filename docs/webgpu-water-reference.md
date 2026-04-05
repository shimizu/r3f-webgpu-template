# WebGPU Water Simulation - 技術リファレンス

`reference/webgpu-water/` の Evan Wallace 方式水シミュレーションの完全な技術ドキュメント。

---

## アーキテクチャ概要

ハイトフィールド（256×256 テクスチャ）上で波動方程式を解き、200×200 メッシュを変位させ、フラグメントシェーダでレイトレーシングによる反射・屈折を描画する。

### フレーム実行順序

```
1. カメラ補間・uniform 更新
2. [一時停止でなければ]
   a. 球体物理演算（重力・浮力・抵抗）
   b. 球体の水面変位（moveSphere）
   c. 波動方程式ステップ × 2（stepSimulation）
   d. 法線マップ更新（updateNormals）
   e. コースティクス更新（updateCaustics）
3. レンダーパス
   a. プール壁描画
   b. 球体描画
   c. 水面描画（上面 + 下面）
```

---

## テクスチャとバッファ

### シミュレーションテクスチャ（ピンポン A/B）

- **サイズ**: 256×256
- **フォーマット**: `rgba32float`（未対応時 `rgba16float`）
- **チャンネル**:
  - R: 水面の高さ
  - G: 速度（高さの変化率）
  - B: 法線 X 成分
  - A: 法線 Z 成分
- **サンプラー**: linear, clamp-to-edge

### コースティクステクスチャ

- **サイズ**: 1024×1024
- **フォーマット**: `rgba8unorm`
- **チャンネル**: R=集光強度, G=球影係数
- **ブレンド**: 加算合成（src: one, dst: one）

---

## シミュレーションアルゴリズム

### 1. 波紋生成（drop）

```wgsl
// 中心からの距離でコサイン減衰
drop = max(0.0, 1.0 - length(center * 0.5 + 0.5 - uv) / radius)
dropVal = 0.5 - cos(drop * π) * 0.5
info.r += dropVal * strength
```

- center: [-1, 1] 範囲の座標
- radius: 波紋の半径
- strength: 正=上向き、負=下向き

### 2. 波動方程式（update）

```wgsl
// 4近傍の高さ平均
average = (left.r + right.r + up.r + down.r) * 0.25

// 速度更新: バネ定数 2.0 で平均に追従
info.g += (average - info.r) * 2.0

// 減衰: 毎ステップ 0.5% のエネルギー損失
info.g *= 0.995

// 高さ更新
info.r += info.g
```

- **毎フレーム2回実行**で安定性確保
- 減衰 0.995 で自然に波が消える

### 3. 法線計算（normal）

```wgsl
// 隣接テクセルの高さ差から接線ベクトルを構築
tangentX = vec3(delta.x, heightRight - height, 0.0)
tangentY = vec3(0.0, heightDown - height, delta.y)
normal = normalize(cross(tangentY, tangentX))

// XZ 成分のみ格納（Y は再構成: sqrt(1 - x² - z²)）
info.b = normal.x
info.a = normal.z
```

### 4. 球体相互作用（sphere）

```wgsl
// ガウス的な減衰でボリューム変位
fn volumeInSphere(center, uv, radius) -> f32 {
  dist = length(p - center)
  t = dist / radius
  dy = exp(-pow(t * 1.5, 6.0))
  // ...省略
}

// 旧位置で浮上、新位置で沈下（体積保存）
info.r += volumeInSphere(oldCenter, uv, radius)
info.r -= volumeInSphere(newCenter, uv, radius)
```

### ピンポンダブルバッファリング

```
各ステップ:
  1. textureA から読み取り
  2. textureB に書き込み
  3. A ↔ B を交換
```

読み書き競合を防ぐ。

---

## レンダリング

### メッシュ変位（surface.vert.wgsl）

```wgsl
// テクスチャから高さを読み取り Y を変位
uv = position.xy * 0.5 + 0.5
info = textureSample(waterTexture, uv)

output.x = position.x
output.y = info.r      // 高さ → Y 座標
output.z = position.y   // XY 平面 → XZ 平面
```

- 200×200 グリッド（40,401 頂点, 80,000 三角形）
- 座標範囲: [-1, 1]

### 反射・屈折（surface-above.frag.wgsl）

```wgsl
// 1. UV の反復改良（5回）
for (i = 0; i < 5; i++) {
  uv += info.ba * 0.005
  info = textureSample(waterTexture, uv)
}

// 2. 法線再構成
normal = vec3(info.b, sqrt(1 - info.b² - info.a²), info.a)

// 3. 反射・屈折レイ
incomingRay = normalize(worldPos - eyePosition)
reflectedRay = reflect(incomingRay, normal)
refractedRay = refract(incomingRay, normal, IOR_AIR / IOR_WATER)

// 4. フレネル（Schlick 近似）
fresnel = mix(fresnelMin, 1.0, pow(1 - dot(normal, -incomingRay), 3.0))

// 5. ブレンド
color = mix(refractedColor, reflectedColor, fresnel)
```

### レイトレーシング

各レイは以下を判定：
1. **球体との交差** → 球体色
2. **下向きレイ** → プール壁/床色 + コースティクス
3. **上向きレイ** → 壁 or スカイボックス + 太陽スペキュラ

```wgsl
fn intersectSphere(origin, ray, center, radius) -> f32 {
  // 二次方程式で最近交点を計算
  discriminant = b² - 4ac
  if (discriminant > 0) return (-b - sqrt(discriminant)) / 2a
  return 1e6  // ヒットなし
}

fn intersectCube(origin, ray, cubeMin, cubeMax) -> vec2f {
  // AABB レイ交差 → (tNear, tFar) を返す
}
```

---

## コースティクス

### アルゴリズム

**頂点シェーダ**: 水面の各頂点から屈折光をプール床に投影
```wgsl
// 平坦な水面での投影位置（参照用）
oldPos = project(pos, refractedLight_flat)

// 変位した水面での投影位置（実際）
newPos = project(pos + vec3(0, info.r, 0), refractedRay)
```

**フラグメントシェーダ**: スクリーンスペース微分で面積変化を計算
```wgsl
oldArea = length(dpdx(oldPos)) * length(dpdy(oldPos))
newArea = length(dpdx(newPos)) * length(dpdy(newPos))

// 面積が縮小 → 光が収束 → 明るい
intensity = oldArea / newArea * causticIntensity
```

- 加算ブレンドで複数レイの寄与を蓄積
- 球体の影とリム影も計算

---

## 球体物理演算

```javascript
// 水中率
percentUnderWater = clamp((radius - center.y) / (2 * radius), 0, 1)

// 重力 + 浮力
velocity.y += (g - buoyancyFactor * g * percentUnderWater) * dt

// 水中抵抗（速度の二乗に比例）
dragForce = normalize(velocity) * percentUnderWater * dt * |velocity|² * 2.0
velocity -= dragForce

// 空気抵抗（10%/秒の減衰）
velocity *= 1.0 - 0.1 * dt * (1 - percentUnderWater)

// 水面通過時の減衰
surfaceDamping = 1.0 - surfaceProximity * (0.5 + 0.5 * density) * dt
velocity *= max(0, surfaceDamping)

// 床衝突（弾性係数 0.7）
if (center.y < radius - 1) velocity.y = |velocity.y| * 0.7
```

| 定数 | 値 | 用途 |
|---|---|---|
| g | -15.0 | 重力加速度 |
| buoyancyFactor | 1.1 | 浮力係数 |
| airResistance | 0.1 | 空気抵抗（10%/秒） |
| bounce | 0.7 | 床衝突の反発係数 |

---

## Uniform バッファレイアウト

### Common Uniforms（80 bytes）
| オフセット | サイズ | フィールド |
|---|---|---|
| 0 | 64 | viewProjectionMatrix (mat4x4f) |
| 64 | 12 | eyePosition (vec3f) |
| 76 | 4 | padding |

### Light Uniforms（16 bytes）
| オフセット | サイズ | フィールド |
|---|---|---|
| 0 | 12 | direction (vec3f) |
| 12 | 4 | padding |

### Sphere Uniforms（16 bytes）
| オフセット | サイズ | フィールド |
|---|---|---|
| 0 | 12 | center (vec3f) |
| 12 | 4 | radius (f32) |

### Water Uniforms（16 bytes）
| オフセット | サイズ | フィールド |
|---|---|---|
| 0 | 4 | density (f32) |
| 4 | 4 | causticIntensity (f32) |
| 8 | 4 | ior (f32) |
| 12 | 4 | fresnelMin (f32) |

---

## バインドグループ構成

### シミュレーションパイプライン（drop/update/normal/sphere）
```
Binding 0: texture_2d<f32>  — 入力水面テクスチャ
Binding 1: sampler           — サンプラー
Binding 2: uniform buffer    — パイプライン固有パラメータ
```

### 水面レンダリング（12 バインディング）
```
Binding 0:  CommonUniforms
Binding 1:  LightUniforms
Binding 2:  SphereUniforms
Binding 3:  タイルサンプラー
Binding 4:  タイルテクスチャ
Binding 5:  水面サンプラー
Binding 6:  水面テクスチャ
Binding 7:  スカイサンプラー
Binding 8:  スカイキューブマップ
Binding 9:  コースティクステクスチャ
Binding 10: ShadowUniforms
Binding 11: WaterUniforms
```

---

## ファイル構成

```
reference/webgpu-water/src/
├── main.ts                    — アプリエントリ、レンダーループ
├── water.ts                   — 水シミュレーション + 水面描画
├── sphere.ts                  — 球体ジオメトリ + 描画
├── pool.ts                    — プールジオメトリ + 描画
├── shaders/
│   ├── common/
│   │   ├── bindings.wgsl      — 共有 uniform 構造体
│   │   └── functions.wgsl     — intersectCube 等
│   ├── water/
│   │   ├── fullscreen.vert.wgsl — シミュレーション用クアッド
│   │   ├── drop.frag.wgsl      — 波紋生成
│   │   ├── update.frag.wgsl    — 波動方程式
│   │   ├── normal.frag.wgsl    — 法線計算
│   │   ├── sphere.frag.wgsl    — 球体変位
│   │   ├── surface.vert.wgsl   — メッシュ変位
│   │   ├── surface-above.frag  — 水上視点レイトレ
│   │   ├── surface-under.frag  — 水中視点レイトレ
│   │   ├── caustics.vert.wgsl  — コースティクス頂点
│   │   └── caustics.frag.wgsl  — コースティクス集光
│   ├── pool/
│   │   ├── pool.vert.wgsl
│   │   └── pool.frag.wgsl
│   └── sphere/
│       ├── sphere.vert.wgsl
│       └── sphere.frag.wgsl
```

---

## パフォーマンス特性

| 処理 | 回数/フレーム | 負荷 |
|---|---|---|
| 波動方程式 | 2 | 低（256×256 フルスクリーンクアッド） |
| 法線更新 | 1 | 低 |
| コースティクス | 1 | 中（1024×1024 出力） |
| 水面レンダリング | 2 | 高（40K 三角形 × 2パイプライン） |
| プール | 1 | 極低（30 インデックス） |
| 球体 | 1 | 低〜中（800 三角形） |
