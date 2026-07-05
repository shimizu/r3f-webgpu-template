# MaterialSamplesLayer

マテリアル基準となるサンプル球を横一列に並べる lookdev レイヤー。

## 概要

`Matte` → `Semi Gloss` → `Metal` → `Mirror` → `Glass` の 5 種のサンプル球を X 軸方向に並べ、照明・IBL 環境下でのマテリアルの見え方を確認するための基準を提供する。Metal / Mirror の 2 球は `<CubeCamera>` によるリアルタイム環境反射（resolution=256, frames=Infinity）を使う。このプロジェクトのマテリアル調整（「もっとマット」「ガラスっぽく」等）は、これらプリセットからの相対調整を基準にする。現在の `Scene.jsx` では未マウントで、import のみトグル運用で保持されている（lookdev 中に有効化／無効化を切り替えるため。CLAUDE.md 参照）。

## 前提・依存

- 配置前提: なし
- 連携: `StudioEnvironment`（IBL）と `LightingRig` の照明があると各マテリアルの差が正しく出る。Metal/Mirror は CubeCamera が周囲を反射するため、周囲に他レイヤーがあると反射に写り込む

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| position | [x,y,z] | [0,0,0.02] | サンプル群全体の配置位置 |

各サンプル球の材質・配置・ラベルはモジュール内定数 `MATERIAL_SAMPLES` で定義され props では変更できない。球ジオメトリは radius=1.35, segments=96。

## 使用例

```jsx
import MaterialSamplesLayer from './layers/MaterialSamplesLayer'

// 既定位置に 5 球を並べる
<MaterialSamplesLayer />

// 床の上に持ち上げて配置
<MaterialSamplesLayer position={[0, 1.35, 0]} />
```

## 調整のポイント

- 5 プリセットの並び順・値は `MATERIAL_SAMPLES` を編集して調整する。新規マテリアルはゼロから作るより、最も近いプリセットから相対調整するのが方針
- Metal / Mirror は `cubeCamera` を持つサンプルのみリアルタイム反射。反射プローブ用に透明のダミー球を同位置に置き、CubeCamera 自身が自分を写さないようにしている
- Glass は `transmission` / `thickness` / `ior` / `attenuation*` を使った透過マテリアル。わずかに回転（Y 軸 0.22π）させて屈折を見せる

## 関連

- ソース: `src/layers/MaterialSamplesLayer.jsx`
- 関連: CLAUDE.md「マテリアルベースライン」。IBL は `StudioEnvironment`、照明は `LightingRig`
