# Tutorial 1 Guide

## 対象

このガイドは `refrence/1.tutorial.txt` の内容を、React Three Fiber ベースで理解し直すためのメモである。

元の教材は素の Three.js コードで説明されているが、このリポジトリでは React Three Fiber を使う前提で読む。

## この章で学ぶこと

- TSL は Three.js の高レベルなシェーダー記述手段である
- 生の GLSL / WGSL を直接書かずに、JavaScript / TypeScript 上で shader logic を組み立てられる
- TSL 学習では `three/tsl` を中心に理解し、WebGPU を使う場合は `three/webgpu` も合わせて意識する
- 最初の一歩としては、`NodeMaterial` に単純な `fragmentNode` を入れて色を出す

## TSL とは

TSL は `Three.js Shading Language` の略で、Three.js 上で shader をより構造的に書くための仕組みである。

この章の時点では、次の理解で十分である。

- `shaderMaterial` に GLSL を文字列で渡す方法より高水準
- JavaScript / TypeScript のコードとして shader を組み立てる
- vertex shader / fragment shader だけでなく、より複雑なノード表現にもつながる
- ブラウザ実行時に適切な shader code に変換される

## 元教材を R3F でどう読むか

元の教材では以下を手で組み立てている。

- `Scene`
- `PerspectiveCamera`
- `WebGPURenderer`
- `OrbitControls`
- `Mesh`
- `PlaneGeometry`
- `NodeMaterial`

React Three Fiber では、このうち多くを JSX で宣言的に書ける。

対応関係はおおむね以下の通り。

- `new THREE.Scene()` は `Canvas` の中の scene graph に置き換わる
- `new THREE.PerspectiveCamera(...)` は `Canvas camera={...}` または `<PerspectiveCamera />` に置き換わる
- `new THREE.Mesh(...)` は `<mesh>` に置き換わる
- `new THREE.PlaneGeometry()` は `<planeGeometry />` に置き換わる
- `OrbitControls` は drei の `<OrbitControls />` を使える
- 毎フレームの `renderer.render(...)` は R3F が面倒を見る

つまり、R3F では「Three.js のセットアップコード」をかなり減らし、`scene の中身` に集中しやすい。

## この章で重要な import

R3F を使う場合でも、TSL 自体は Three.js 側の仕組みなので、考え方の中心は変わらない。

この章で意識する import は次の3系統である。

### 1. React Three Fiber

```jsx
import { Canvas } from '@react-three/fiber'
```

### 2. Drei

```jsx
import { OrbitControls } from '@react-three/drei'
```

### 3. Three.js WebGPU / TSL

```jsx
import * as THREE from 'three/webgpu'
import { color } from 'three/tsl'
```

この章の主題はここである。
ただし役割は分けて理解した方がよい。

- `three/tsl`
  - TSL の node を使うための import
- `three/webgpu`
  - WebGPU renderer を使う時の import

TSL そのものは `three/tsl` が中心であり、WebGPU 移行時に `three/webgpu` の理解が必要になる。

## 元教材の最小サンプルがしていること

元のスタートコードは、最終的に以下だけをしている。

1. Plane を1枚置く
2. `NodeMaterial` を作る
3. `fragmentNode = color('crimson')` を設定する
4. 画面に赤い平面を表示する

重要なのは、ここではまだ複雑なノードは使っていないことだ。
「TSL はこうやって material に差し込む」という入口だけを確認している。

## R3F での考え方

通常の R3F では renderer や resize 処理を自前で書かなくてよいので、この章の本質だけを抜き出しやすい。

ただし WebGPU を使う場合は例外で、`Canvas` の `gl` に非同期ファクトリーを渡して `WebGPURenderer` を初期化する必要がある。

この章を R3F で再構成すると、責務は以下のように分かれる。

- `App.jsx`
  - `Canvas` を置く
  - camera の初期位置を決める
- `Scene.jsx`
  - `OrbitControls`
  - `mesh`
  - `planeGeometry`
  - `NodeMaterial`

## R3F 版の最小イメージ

実装詳細はプロジェクトの進め方に合わせて調整すればよいが、章の理解としては次の形を目指せばよい。

```jsx
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu'
import { color } from 'three/tsl'

function TslPlane() {
  const material = new MeshBasicNodeMaterial()
  material.colorNode = color('crimson')

  return (
    <mesh material={material}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  )
}

export default function App() {
  return (
    <Canvas
      camera={{ position: [0, 0, 1] }}
      gl={async (canvas) => {
        const renderer = new WebGPURenderer({ canvas, antialias: true })
        await renderer.init()
        return renderer
      }}
    >
      <OrbitControls />
      <TslPlane />
    </Canvas>
  )
}
```

ただし、このコードは「章の概念説明用の最小イメージ」である。
実際のプロジェクトでは、R3F と `three/webgpu` 周りの組み合わせ方、Drei や postprocessing の互換性を確認しながら組み込む必要がある。

## この章を読むときの注意点

### Three.js のサンプルをそのまま写経しない

元教材の以下の部分は、R3F では基本的に不要か置き換え対象である。

- `new THREE.Scene()`
- `new THREE.PerspectiveCamera(...)`
- `document.body.appendChild(...)`
- `window.addEventListener('resize', ...)`
- `renderer.setAnimationLoop(...)`

これらは R3F の `Canvas` が吸収してくれる責務が多い。

ただし `new THREE.WebGPURenderer()` だけは完全に消えるわけではない。
WebGPU を使う場合は、`Canvas` の `gl={async ...}` の中で明示的に初期化する形へ移る。

### 学ぶべき本体は renderer ではなく material 側

この章で本当に見るべきなのは、次の1行である。

```js
material.colorNode = color('crimson')
```

TSL 学習としては、

- `NodeMaterial` にノードを入れる
- そのノードが最終的な見た目を決める

という関係をまず掴むのが重要である。

## このリポジトリに引きつけた理解

現在のこのリポジトリの `src/Scene.jsx` は、TSL ではなく生の GLSL を `shaderMaterial` に渡している。

つまり tutorial 1 の文脈では、次の置き換えが最初の学習ポイントになる。

- 今の GLSL ベース `shaderMaterial` をやめる
- `MeshBasicNodeMaterial` などの NodeMaterial 系を使う
- `colorNode` か `fragmentNode` に単純な `color(...)` を入れる
- まずは TSL の最小成功例を作る

## この章の学習ゴール

この章を終えた時点で、次の状態になっていれば十分である。

- TSL が何のための仕組みか説明できる
- `three/tsl` と `three/webgpu` の役割の違いが分かる
- Three.js の imperative な初期化コードを、R3F ではどう読み替えるか分かる
- R3F で WebGPU を使う時に `Canvas gl={async ...}` が必要なことを理解している
- NodeMaterial 系と `colorNode` / `fragmentNode` の最小例を理解している

## 次にやるとよいこと

- tutorial 1 の内容を元に、R3F 版の最小 TSL サンプルを `src` に実装する
- `shaderMaterial` と `NodeMaterial` の違いをコード上で見比べる
- tutorial 2 以降で使うノード関数が、`fragmentNode` / `color()` の延長線上にあることを意識して読む
