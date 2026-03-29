# WebGPU + Three.js 移行ガイド メモ

## 目的

このメモは、Utsubo の「WebGPU + Three.js 移行ガイド（2026年版）」を、このリポジトリで使う観点に絞って整理したものである。

参照元:
https://www.utsubo.com/ja/blog/webgpu-threejs-migration-guide

確認日:
2026-03-26

## 先に結論

このリポジトリにとって重要なのは次の4点である。

1. WebGPU へ寄せるなら import を `three` から `three/webgpu` に切り替える
2. `WebGPURenderer` は非同期初期化なので `await renderer.init()` が必要
3. React Three Fiber では `Canvas` の `gl` を非同期ファクトリーで渡す
4. 既存の GLSL ベース `shaderMaterial` は、長期的には TSL へ置き換える

## 記事の要点

記事全体の要旨は以下だった。

- WebGPU への移行は、多くのケースでレンダラー差し替えから始められる
- `three/webgpu` は WebGPU が使えない環境で WebGL 2 にフォールバックできる
- React Three Fiber でも WebGPU は扱える
- カスタムシェーダーは TSL に寄せるのが本筋
- 大規模な計算やパーティクルでは WebGPU の恩恵が大きい

## このリポジトリに関係するポイント

### 1. `three/webgpu` への切り替え

記事では、Three.js 側の核心変更は以下だと整理されている。

- 変更前: `import * as THREE from 'three'`
- 変更後: `import * as THREE from 'three/webgpu'`

この切り替えで、`WebGPURenderer` を使う前提の API に寄せられる。

このリポジトリで言うと、今の [`src/Scene.jsx`](/home/shimizu/_playground/three-fiber/TSL-tutorials/src/Scene.jsx) は `three` と生 GLSL ベースで動いているので、TSL 学習用に進めるなら今後ここを見直すことになる。

### 2. `await renderer.init()` を忘れない

記事で最重要の注意点として挙がっているのがこれである。

- `WebGLRenderer` は同期初期化
- `WebGPURenderer` は非同期初期化

つまり、Three.js 生コードなら次が必要になる。

```js
const renderer = new THREE.WebGPURenderer()
await renderer.init()
```

記事では、これを忘れると「何も描画されないが、エラーも見えにくい」と説明されている。

### 3. R3F では `Canvas gl={async ...}` を使う

記事の R3F 節で重要なのは、WebGPU 対応時の `gl` の渡し方である。

R3F では同期値ではなく、非同期で renderer を返すファクトリーを使う。

```jsx
<Canvas
  gl={async (canvas) => {
    const renderer = new WebGPURenderer({ canvas, antialias: true })
    await renderer.init()
    return renderer
  }}
>
```

この構成が必要になる理由は、`WebGPURenderer` の初期化が非同期だからである。

### 4. Drei は大半がそのまま使える

記事では、R3F + WebGPU でも多くの Drei コンポーネントはそのまま動くと整理されている。

このリポジトリで今使っているものに引きつけると、少なくとも次は大きく崩れにくい前提で考えてよい。

- `OrbitControls`
- `Environment`
- `useGLTF`
- `Text`
- `Html`

一方で、postprocessing まわりは個別検証が必要とされている。

### 5. `EffectComposer` は注意して扱う

記事では、ポストプロセシングについて次の方針が示されている。

- 推奨は TSL ネイティブエフェクト
- 既存の `EffectComposer` 系は一部互換だが個別テストが必要

このリポジトリは現状 [`src/Scene.jsx`](/home/shimizu/_playground/three-fiber/TSL-tutorials/src/Scene.jsx) で `@react-three/postprocessing` の `EffectComposer` と `Bloom` を使っている。

つまり WebGPU への移行を始めた時に、最初のチェック対象はここになる。

## TSL 学習という観点で重要な点

### TSL は WebGPU 専用記法ではない

記事では、TSL は WGSL と GLSL の両方にコンパイルされる前提で説明されている。

これは学習上かなり重要である。

- TSL を学ぶことは、単に WebGPU 専用コードを書くことではない
- WebGL フォールバックを含む Three.js の shader 記述を抽象化して学ぶことになる

つまりこのリポジトリの目的と相性がよい。

### GLSL から TSL への置き換えが本筋

記事では、既存の `ShaderMaterial` / `RawShaderMaterial` を使っている場合、TSL に変換していく流れを勧めている。

このリポジトリの現状に引きつけると、

- 今は `shaderMaterial` に GLSL 文字列を入れている
- tutorial を進めるなら `NodeMaterial` や各種 node を使う形へ寄せる

という方向になる。

## 今のコードベースへの示唆

### 現状

現状の構成は以下である。

- R3F ベース
- `Canvas` を使っている
- `Scene.jsx` にシーン記述がある
- shader は TSL ではなく GLSL 文字列
- postprocessing を使っている

### 段階的な移行案

このリポジトリで無理のない順序は次の通り。

1. tutorial 単位では、まず TSL の最小サンプルを別実装で作る
2. `shaderMaterial` を直接置き換える前に、`NodeMaterial` の最小例を通す
3. `three/webgpu` + R3F `gl={async ...}` の最小構成を試す
4. `EffectComposer` がそのまま使えるかを確認する
5. 問題があれば、postprocessing は後回しにしてまず素の描画を成立させる

## R3F + WebGPU で避けるべき落とし穴

記事から、このリポジトリで特に気をつけるべき点を抜き出すと以下である。

- `gl={(canvas) => new WebGPURenderer(...)}` のように同期で返さない
- 必ず `await renderer.init()` を挟む
- `useThree().gl.capabilities.isWebGL2` のような WebGL 固有前提に依存しない
- 判定が必要なら `gl.isWebGPURenderer` を見る
- postprocessing は動く前提で決め打ちしない

## この記事を踏まえた判断

このリポジトリは「TSL を学ぶ」ことが主目的なので、結論としては次の方針が妥当である。

- いきなり全面移行はしない
- tutorial ごとに TSL サンプルを R3F で作る
- WebGPU 対応は別の最小ブランチか最小サンプルで検証する
- 既存の GLSL 実装は比較対象として残してもよい

理由は、学習対象が2つあるからである。

- TSL そのもの
- WebGPU / R3F 統合

これらを同時に全部置き換えると、どこで壊れたのか分かりにくくなる。

## このメモを読んだあとの次アクション

- tutorial 1 の R3F 版 TSL サンプルを作る
- `three/webgpu` を使う最小 `Canvas` 構成を別ファイルで試す
- `@react-three/postprocessing` を含まない最小例から始める
- 動いた後で `Bloom` などを段階的に戻す

## 参考

- 元記事: https://www.utsubo.com/ja/blog/webgpu-threejs-migration-guide
