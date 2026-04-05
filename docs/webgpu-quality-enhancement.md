# Three.js WebGPU グラフィック品質向上ガイド

本プロジェクト（r183.2）で利用可能な WebGPU ネイティブの品質向上手法をまとめる。

## 現状の品質構成

| 機能 | 状態 | 備考 |
|------|------|------|
| WebGPU レンダラー | 有効 | antialias: true |
| シャドウマップ | 有効 | directional 2048x2048 |
| TSL シェーダー | 活用中 | 水面・雲・地形・雨 |
| IBL 環境マップ | 未使用 | StudioEnvironment.jsx は存在するが未接続 |
| ポストプロセッシング | **未使用** | @react-three/postprocessing は依存に存在 |
| トーンマッピング | デフォルト | 明示設定なし |
| フォグ | 基本 | 線形フォグのみ |

---

## 1. ポストプロセッシング（TSL ネイティブ）

three.js r183 の `examples/jsm/tsl/display/` に WebGPU ネイティブのエフェクトノードが揃っている。
WebGL 用の postprocessing ライブラリとは別系統。

### 高インパクト

#### Bloom（BloomNode）
輝度の高い部分を光らせる。雨粒のバックライト反射やスプラッシュの発光に効果的。

```js
import { bloom } from 'three/tsl'
// or
import { BloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js'
```

#### GTAO（GTAONode）— アンビエントオクルージョン
ジオメトリ認識型の AO。地形の谷間や建物の隅に自然な影を落とす。
SSAO より高品質で WebGPU に最適化されている。

```js
import { GTAONode } from 'three/examples/jsm/tsl/display/GTAONode.js'
```

#### Depth of Field（DepthOfFieldNode）
ジオラマ感を強化する最有力候補。ティルトシフト風のボケで模型感を演出。

```js
import { DepthOfFieldNode } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js'
```

### 中インパクト

#### SSR（SSRNode）— スクリーンスペース反射
濡れた地面の反射に有効。水面や雨で濡れた路面の光沢表現。

```js
import { SSRNode } from 'three/examples/jsm/tsl/display/SSRNode.js'
```

#### God Rays（GodraysNode）
雲の隙間から差す光の筋。ドラマチックな雨天表現に。

```js
import { GodraysNode } from 'three/examples/jsm/tsl/display/GodraysNode.js'
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
// Scene.jsx で追加
import StudioEnvironment from '../StudioEnvironment'

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

### Procedural Wetness（濡れ表現）
地形マテリアルの roughness を雨量に応じて下げ、metalness を微増させる。
```js
// TerrainLayer の material で
const wetness = uniform(0.8) // 0=乾燥, 1=びしょ濡れ
material.roughnessNode = float(0.85).sub(wetness.mul(0.5))  // 0.85 → 0.35
material.metalnessNode = wetness.mul(0.15)                    // 0 → 0.15
```

### Puddle Mapping（水たまり）
地形の低い位置に水たまりを表現。elevation 属性で判定し、低い部分だけ反射を強化。
```js
const isPuddle = smoothstep(float(0.3), float(0.35), elevation).oneMinus()
material.roughnessNode = mix(dryRoughness, float(0.05), isPuddle)
```

### 大気散乱フォグ
現在の線形フォグを TSL で高度依存のエクスポネンシャルフォグに置き換え。
低地ほど濃い霧で雨天の空気感を強化。

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

### Phase 1: 即効性が高いもの
1. **トーンマッピング設定**（ACESFilmic）— 1行で改善
2. **IBL 環境マップ有効化**（StudioEnvironment）— PBR 反射が劇的改善
3. **Bloom**（BloomNode）— 雨粒とスプラッシュの発光

### Phase 2: ジオラマ感の強化
4. **Depth of Field**（DepthOfFieldNode）— ティルトシフト風ボケ
5. **GTAO**（GTAONode）— 地形の谷間に自然な影
6. **Wetness 表現**（TSL roughness 制御）— 濡れた地面

### Phase 3: 映像品質の仕上げ
7. **Film Grain**（FilmNode）— カメラ撮影感
8. **Chromatic Aberration** — レンズ感
9. **God Rays**（GodraysNode）— 雲間の光線（晴れ間演出時）
10. **SSR**（SSRNode）— 水面・濡れ面の反射

### 注意事項
- WebGPU ネイティブの PostProcessing パイプラインは `three/examples/jsm/postprocessing/` ではなく `three/examples/jsm/tsl/display/` のノードを使用する
- R3F + WebGPU での PostProcessing 統合は three.js 側の API が安定途上のため、`@react-three/postprocessing` ではなく TSL ノードを直接使う方が確実
- パフォーマンス: Bloom + GTAO + DoF の3つを同時に有効にしても WebGPU なら 60fps を維持できる見込み（パーティクル 30k 程度であれば）
