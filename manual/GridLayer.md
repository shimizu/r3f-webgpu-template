# GridLayer

工作マット風の青いグリッド床レイヤー。

## 概要

XZ 平面に寝かせた大きな Plane に、TSL でメイン／サブ 2 段階のグリッド線を描く床。工作マット風の青（`#3f73d3`）をベースに、白い線を `fwidth` ベースのアンチエイリアスで描画する。ジオラマステージの基準床として使い、`receiveShadow` で他レイヤーの影を受ける。Scene では `position={[0, -1, 0]}` でマウントされている。

## 前提・依存

- 配置前提: なし
- 連携: `MeshPhysicalNodeMaterial`（roughness=0.95, metalness=0）でライティング・影を受ける。ワールド座標の XZ でグリッドを生成するため、`position` を動かしても線の位相はワールド基準

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| size | number | 400 | 平面の一辺サイズ（ワールド単位） |
| position | [x,y,z] | [0,0,0] | 床の配置位置。Scene では `[0,-1,0]` |
| gridScale | number | 3.0 | メイングリッドの間隔（ワールド単位） |
| subGridScale | number | 1.0 | サブグリッドの間隔 |
| lineWidth | number | 0.02 | メインライン幅 |
| subLineWidth | number | 0.01 | サブライン幅 |
| baseColor | string | '#3f73d3' | ベース色（工作マット風の青） |
| lineColor | string | '#ffffff' | グリッド線の色 |
| lineOpacity | number | 0.3 | メインラインの不透明度（混合強度） |
| subLineOpacity | number | 0.05 | サブラインの不透明度 |

## 使用例

```jsx
import GridLayer from './layers/GridLayer'

// Scene での実際の使い方
<GridLayer position={[0, -1, 0]} />

// 間隔・色をカスタムする
<GridLayer size={200} gridScale={5} baseColor='#2b2b30' lineOpacity={0.5} />
```

## 調整のポイント

- メイン／サブの 2 段階は `max(subLine, mainLine)` で合成され、強い方の線が採用される
- 線幅は `lineWidth / gridScale / 2` として正規化されるため、gridScale を変えると見た目の線幅も変わる
- material は props（各値）を依存に `useMemo` で再生成される。rest オブジェクトではなく個別値で依存させているため props 変更が確実に反映される
- geometry / material ともにアンマウント時に `dispose()` される

## 関連

- ソース: `src/layers/GridLayer.jsx`
- 関連: チェッカーボード床は `StageLayer`。床材の質感基準は `MaterialSamplesLayer`
