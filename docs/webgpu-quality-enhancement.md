# Three.js WebGPU グラフィック品質向上ガイド

本プロジェクト（r183.2）で利用可能な WebGPU ネイティブの品質向上手法をまとめる。

## 現状の品質構成

> このプロジェクトは災害ジオラマ可視化基盤へ発展し、Scene.jsx の構成が大きく変わった。
> 以下は現状に更新した表。多くの項目が「未マウント → 有効/実装済み」に進んでいる。

| 機能 | 状態 | 備考 |
|------|------|------|
| WebGPU レンダラー | 有効 | antialias: true |
| シャドウマップ | 有効 | directional 2048x2048 |
| TSL シェーダー | 活用中 | Terrain（DEM）・Cloud（体積雲）・Water・Grass・各災害レイヤーが常時マウント。地域プリセット（regions.js）で切替 |
| IBL 環境マップ | StudioEnvironment 実装済み | 有効化は Scene 構成による |
| ポストプロセッシング | **実装済み・leva トグルでマウント** | `src/effects/` に Bloom + Tilt-Shift + Film Grade。`postfx` トグルで `<SceneEffects />` をマウント（既定オフ、GPU 予算次第） |
| トーンマッピング | デフォルト | 明示設定なし |
| フォグ | 高さフォグ実装済み | `HeightFogLayer`（`scene.fogNode`、距離+高さ指数フォグ）を uniform 駆動 |
| 濡れ / 堆積 / 延焼 | 実装済み | TerrainLayer に wet（濡れ）/ acc（雪・苔）/ burn（延焼）の表面表現（後述 §6 の Wetness は実装済み） |

---

## 1. ポストプロセッシング（TSL ネイティブ）

three.js r183 の `addons/tsl/display/`（= `examples/jsm/tsl/display/`）に WebGPU ネイティブのエフェクトノードが揃っている。
WebGL 用の postprocessing ライブラリとは別系統。

### 実装状況

本プロジェクトでは `src/effects/` 配下に TSL ポストプロセスが**実装済み**:

| ファイル | 内容 | 状態 |
|---------|------|------|
| `src/effects/createBloom.js` | `bloom` ノードのラッパー（`createBloomPass`） | **有効** |
| `src/effects/createTiltShift.js` | ミニチュア風ぼかし（GaussianBlur） | **有効** |
| `src/effects/createFilmGrade.js` | 色収差 + コントラスト + 彩度 + ビネット + グレイン | **有効** |
| `src/effects/createDof.js` | `dof` ノードのラッパー（`createDofPass`） | コメントアウトで無効化 |
| `src/effects/createGodrays.js` | `godrays` ノードのラッパー（`createGodraysPass`） | コメントアウトで無効化 |
| `src/effects/SceneEffects.jsx` | `RenderPipeline` + `pass(scene, camera)` で合成 | leva `postfx` トグルでマウント |

`SceneEffects.jsx` は `RenderPipeline(renderer)` と `pass(scene, camera)` でシーンパスを作り、
各エフェクトをノードグラフでチェーン合成して `rp.outputNode` に渡す。
現状のチェーンは **Bloom（加算）→ Tilt-Shift → Film Grade** の順で、最終段の Film Grade が
色収差・コントラスト・彩度・ビネット・アニメーショングレインをまとめて適用する。
**Godrays と DoF は import 行を含めてコメントアウトされており無効**。

> **マウント状況（更新）**
> `SceneEffects` は Scene.jsx の leva `postfx` トグルでマウントされる（既定オフ）。
> GPU 負荷が高く、steps≈12 の体積雲や災害パーティクルと併用すると TDR リスクが
> あるため、必要なときだけ有効化する運用。マウントすると R3F の自動描画から
> 手動パイプライン描画（`useFrame` で `rp.render`）に切り替わる。

各エフェクトの import パスは以下の通り（実装準拠）:

```js
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
import { godrays } from 'three/addons/tsl/display/GodraysNode.js'
```

### 高インパクト

#### Bloom（BloomNode）— 実装済み・有効
輝度の高い部分を光らせる。雨粒のバックライト反射やスプラッシュの発光に効果的。
`createBloom.js` で `bloom(scenePassColor, strength, radius, threshold)` をラップ済み。

```js
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
```

#### GTAO（GTAONode）— アンビエントオクルージョン
ジオメトリ認識型の AO。地形の谷間や建物の隅に自然な影を落とす。
SSAO より高品質で WebGPU に最適化されている。

```js
import { GTAONode } from 'three/addons/tsl/display/GTAONode.js'
```

#### Depth of Field（DepthOfFieldNode）— 実装済み・無効化中
ジオラマ感を強化する最有力候補。ティルトシフト風のボケで模型感を演出。
`createDof.js` で `dof(inputNode, viewZ, focusDistance, focalLength, bokehScale)` をラップ済みだが、SceneEffects ではコメントアウトされている。

```js
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js'
```

### 中インパクト

#### SSR（SSRNode）— スクリーンスペース反射
濡れた地面の反射に有効。水面や雨で濡れた路面の光沢表現。

```js
import { SSRNode } from 'three/addons/tsl/display/SSRNode.js'
```

#### God Rays（GodraysNode）— 実装済み・無効化中
雲の隙間から差す光の筋。ドラマチックな雨天表現に。
`createGodrays.js` で `godrays(scenePassDepth, camera, light)` をラップ済みだが、SceneEffects ではコメントアウトされている。

```js
import { godrays } from 'three/addons/tsl/display/GodraysNode.js'
```

#### Motion Blur
雨粒の軌跡をさらに強調。ただし現在のストリーク描画と重複する可能性あり。

```js
import { MotionBlur } from 'three/examples/jsm/tsl/display/MotionBlur.js'
```

### 雰囲気系

#### Film Grain（FilmNode）
フィルム粒状感。ジオラマ撮影の質感を加える。

```js
import { FilmNode } from 'three/examples/jsm/tsl/display/FilmNode.js'
```

#### Chromatic Aberration
レンズの色収差。カメラで撮影した雰囲気を出す。

```js
import { ChromaticAberrationNode } from 'three/examples/jsm/tsl/display/ChromaticAberrationNode.js'
```

#### Vignette / LUT
ビネット（周辺減光）や LUT カラーグレーディングで映画的な色調に。

```js
import { Lut3DNode } from 'three/examples/jsm/tsl/display/Lut3DNode.js'
```

---

## 2. アンチエイリアシング

現在は WebGPU デフォルトの MSAA（`antialias: true`）のみ。

| 手法 | ファイル | 特徴 |
|------|---------|------|
| FXAA | FXAANode.js | 軽量、エッジにわずかなぼけ |
| SMAA | SMAANode.js | FXAA より高品質、テクスチャベース |
| SSAA | SSAAPassNode.js | 最高品質、重い（スーパーサンプリング） |
| TRAA | TRAANode.js | テンポラル。動的シーンに強い |

雨パーティクルのような細い線は TRAA が最も効果的。

---

## 3. トーンマッピングと色空間

現在未設定。WebGPU レンダラーのデフォルトに依存。

```js
// App.jsx の renderer 設定で追加可能
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.8  // 雨天は暗めに
renderer.outputColorSpace = THREE.SRGBColorSpace
```

| マッピング | 特徴 |
|-----------|------|
| Linear | デフォルト。HDR 非対応 |
| Reinhard | 自然なロールオフ |
| **ACESFilmic** | 映画的。ハイライトの圧縮が美しい |
| AgX | Blender 互換。中間トーンの再現性が高い |

雨天ジオラマには **ACESFilmic + exposure 0.7〜0.9** を推奨。暗部の階調が豊かになる。

---

## 4. IBL 環境マップの有効化

`StudioEnvironment.jsx` が既に存在するが Scene で未使用。
有効化すると PBR マテリアル（水面・地形）の環境反射が劇的に改善する。

```jsx
// Scene.jsx で追加（StudioEnvironment.jsx は src/ 直下にあるため同階層パス）
import StudioEnvironment from './StudioEnvironment'

<StudioEnvironment />
```

または HDR 環境マップを使う場合:
```jsx
import { Environment } from '@react-three/drei'
<Environment files="path/to/hdr.hdr" />
```

---

## 5. シャドウ品質

現在: 単一 directionalLight の 2048x2048 シャドウマップ。

### 改善オプション

#### シャドウマップ解像度の向上
```jsx
shadow-mapSize-width={4096}
shadow-mapSize-height={4096}
```

#### VSM（Variance Shadow Maps）
ソフトシャドウ。PCF より自然な半影。
```js
renderer.shadowMap.type = THREE.VSMShadowMap
```

#### CSM（Cascaded Shadow Maps）— @react-three/drei
広いシーンでの影の精度向上。ジオラマには過剰な可能性あり。

---

## 6. TSL マテリアル強化

WebGPU + TSL ならではの手法。

### Procedural Wetness（濡れ表現）— 実装済み
`TerrainLayer` に実装済み。fBM パッチマスク（`coverageMask`）で陸地の上面だけを
暗く・低 roughness にし、雨量・浸水と連動する。濡れ量は目標値に対して非対称の
時定数で追従する（降り始めは速く濡れ、止んだ後はゆっくり乾く）。下は概念コード。
```js
// TerrainLayer の material で（実際は wet uniform セット + coverageMask）
const wetness = uniform(0.8) // 0=乾燥, 1=びしょ濡れ
material.roughnessNode = float(0.85).sub(wetness.mul(0.5))  // 0.85 → 0.35
```
同じパターンで **acc（雪・苔の堆積）** と **burn（山火事の延焼・焼け跡）** も
TerrainLayer に載っている（法線の向き・標高・延焼マスクで albedo/roughness/emissive を変える）。

### Puddle Mapping（水たまり）
地形の低い位置に水たまりを表現。elevation 属性で判定し、低い部分だけ反射を強化。
```js
const isPuddle = smoothstep(float(0.3), float(0.35), elevation).oneMinus()
material.roughnessNode = mix(dryRoughness, float(0.05), isPuddle)
```

### 高度依存フォグ — 実装済み
`HeightFogLayer`（`src/tsl/heightFog.js`）で実装済み。距離 + 高さの指数フォグを
`scene.fogNode` に設定し、低地ほど濃く上空ほど薄い。density は uniform 駆動で
0 なら完全無効。空・雲は `fog: false` で除外している。マウントは常時（条件マウントは
全マテリアル再コンパイルを招くため）。

---

## 7. 利用可能な TSL エフェクトノード一覧

three.js r183 の `examples/jsm/tsl/display/` に存在する全ノード:

### ポストプロセッシング
| ノード | 用途 |
|--------|------|
| BloomNode | グロー/ブルーム |
| DepthOfFieldNode | 被写界深度 |
| MotionBlur | モーションブラー |
| GTAONode | アンビエントオクルージョン |
| SSRNode | スクリーンスペース反射 |
| SSGINode | スクリーンスペース GI |
| GodraysNode | ゴッドレイ |
| OutlineNode | アウトライン |
| DenoiseNode | デノイズ |

### AA
| ノード | 用途 |
|--------|------|
| FXAANode | 高速近似 AA |
| SMAANode | サブピクセル形態学的 AA |
| SSAAPassNode | スーパーサンプリング AA |
| TRAANode | テンポラル AA |

### レンズ/フィルム
| ノード | 用途 |
|--------|------|
| FilmNode | フィルムグレイン |
| ChromaticAberrationNode | 色収差 |
| LensflareNode | レンズフレア |
| AnamorphicNode | アナモルフィックレンズ |
| Lut3DNode | 3D LUT カラーグレーディング |

### ブラー
| ノード | 用途 |
|--------|------|
| GaussianBlurNode | ガウシアンブラー |
| BilateralBlurNode | バイラテラルブラー |
| radialBlur | ラジアルブラー |
| boxBlur | ボックスブラー |
| hashBlur | ハッシュブラー |

### その他
| ノード | 用途 |
|--------|------|
| DotScreenNode | ドットスクリーン |
| PixelationPassNode | ピクセル化 |
| RetroPassNode | レトロ風 |
| SobelOperatorNode | エッジ検出 |
| RGBShiftNode | RGB シフト |
| Sepia | セピア |
| BleachBypass | ブリーチバイパス |
| CRT | CRT モニター風 |
| AfterImageNode | 残像 |
| TransitionNode | シーン遷移 |

---

## 8. 推奨実装優先順位（雨天ジオラマ向け）

> 実装状況を更新。Bloom / Tilt-Shift / Film Grade（グレイン + 色収差 + ビネット）・
> Wetness・高さフォグは実装済み。残りは未着手または意図的に不採用。

### 実装済み
- **Bloom**（BloomNode）— `createBloom.js`。SceneEffects チェーンで有効
- **Tilt-Shift**（GaussianBlur）— `createTiltShift.js`。ミニチュア風ぼかし
- **Film Grade**（`createFilmGrade.js`）— **Film Grain・Chromatic Aberration・
  Vignette・コントラスト・彩度をまとめて実装**。チェーン最終段
- **Wetness 表現**（TSL roughness 制御）— TerrainLayer に実装（濡れ / 堆積 / 延焼）
- **高さフォグ** — HeightFogLayer（`scene.fogNode`）

### 未着手（有効化候補）
- **トーンマッピング設定**（ACESFilmic）— 1行で改善
- **IBL 環境マップ有効化**（StudioEnvironment）— PBR 反射が劇的改善
- **Depth of Field**（DepthOfFieldNode）— `createDof.js` 実装済み・コメントアウト中
- **God Rays**（GodraysNode）— `createGodrays.js` 実装済み・コメントアウト中。山火事の光芒に有力
- **SSR**（SSRNode）— 水面・濡れ面の反射

### 意図的に不採用
- **GTAO / SSAO 系** — このプロジェクトでは採用しない方針（提案対象外）

### 注意事項
- WebGPU ネイティブの PostProcessing パイプラインは `three/examples/jsm/postprocessing/` ではなく `three/examples/jsm/tsl/display/` のノードを使用する
- R3F + WebGPU での PostProcessing 統合は three.js 側の API が安定途上のため、`@react-three/postprocessing` ではなく TSL ノードを直接使う方が確実
- パフォーマンス予算: 体積雲は steps≈12・SceneEffects は既定オフが TDR 回避の目安。
  災害パーティクル（雨/雪/火の粉/デブリ）と重い raymarch を同時に焚かないよう、
  シナリオ側（`deriveLayerInputs`）で山火事中は通常雲の coverage を絞る等の制御を持つ
