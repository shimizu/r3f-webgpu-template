# SceneEffects（ポストプロセッシング）

WebGPU ネイティブのポストプロセッシングパイプライン。Bloom + Tilt-Shift + Film Grade。

## 概要

`RenderPipeline` + `pass(scene, camera)` でシーンパスを作り、各エフェクトを
TSL ノードグラフでチェーン合成する非描画コンポーネント。マウントすると R3F の
自動描画から手動パイプライン描画（`useFrame` 優先度 1 で `rp.render()`）に切り替わる。
ジオラマの「ミニチュア撮影」風の仕上げに使う。

チェーン構成（順序固定）:
1. **Bloom**（`createBloom.js`）— シーンカラーに加算
2. **Tilt-Shift**（`createTiltShift.js`）— スクリーン Y バンドのミニチュア風ぼかし
3. **Film Grade**（`createFilmGrade.js`）— 色収差 / コントラスト / 彩度 / ビネット / グレイン（最終段）

Godrays / DoF は実装済みだが import ごとコメントアウトで無効化中。

## 前提・依存

- 配置前提: なし（`<Canvas>` 内ならどこでも。非描画）
- GPU 負荷が高く TDR リスクがあるため、Scene.jsx では leva ルートの `postfx` トグルで
  条件マウント（**既定オフ**）。steps≈12 の体積雲や大量パーティクルとの併用時は特に注意

## Props

props なし。調整は leva「フィルムグレード」フォルダ（グレイン / ビネット / 色収差 /
コントラスト / 彩度）で行う。uniform 駆動なのでスライダー操作で再構築は走らない。

## 使用例

```jsx
// Scene.jsx（leva トグルで条件マウント）
{postfx && <SceneEffects />}
```

エフェクトの追加・並び替えは `SceneEffects.jsx` の pipeline useMemo 内で行う:

```jsx
let outputNode = scenePassColor.add(createBloomPass(scenePassColor))
outputNode = createTiltShiftPass(outputNode)
outputNode = createFilmGradePass(outputNode, filmUniforms)
rp.outputNode = outputNode
```

## 調整のポイント

- Bloom の strength / radius / threshold、Tilt-Shift のバンド位置・ぼかし量は
  各 `create*.js` の定数で調整（props 化していない）
- Godrays を有効化する場合は `scenePass.getTextureNode('depth')` と光源参照が必要
  （山火事の光芒演出に有力候補）
- マウント/アンマウントでパイプライン再構築が走る。頻繁なトグルは避ける
- 条件マウント方式なのは「使わないときに完全にゼロコスト」にするため
  （HeightFogLayer の常時マウント方式とは逆の判断）

## 関連

- ソース: `src/effects/SceneEffects.jsx`, `src/effects/create{Bloom,TiltShift,FilmGrade,Dof,Godrays}.js`
- ドキュメント: `docs/webgpu-quality-enhancement.md`（利用可能な全 TSL エフェクトノード一覧）
