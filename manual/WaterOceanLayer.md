# WaterOceanLayer

TSL による広域の海面レイヤー（波・フレネル・コースティクス・深度カラー + 浸水/濁り連動）。

## 概要

薄い箱型ジオメトリの上面をノーマルマップスクロールで波立たせ、側面に深度グラデーション・フェイクコースティクス・波紋バンドを合成する TSL 水面。`MeshPhysicalNodeMaterial` の transmission / attenuation で透過と光吸収を表現する。`floodLevel` で水位を上げると（地形は不動なので）海岸線が内陸へ食い込み、`murkiness` で泥水に濁る。Scene では地形フットプリントに合わせた広い海面として使う。WaterBoxLayer / WaterBlobLayer と違い頂点変位ではなく法線ベースの波なので軽量で、広い面積に向く。

## 前提・依存

- 配置前提: なし（`<Coordinate>` 配下でなくてもよい）
- テクスチャ: `./textures/waternormals.jpg`（ノーマルマップ）を読み込む
- 連携: `floodLevel` / `murkiness` は Scene の浸水・雨量と連動（`deriveLayerInputs` の `floodLevel` / `murkiness`）。地形の海面標高（seaLevel）とは独立

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| width | number | 200 | 幅（X） |
| height | number | 200 | 奥行（Z） |
| depth | number | 2 | 水の厚み（Y） |
| opacity | number | 1.0 | 不透明度スケール（transmission と opacityNode に乗算） |
| position | [x,y,z] | [0,0,0] | 配置位置 |
| floodLevel | number | 0 | 水位上昇（world units）。position.y に加算されて海岸線が内陸へ食い込む |
| murkiness | number | 0 | 濁り 0..1（uniform 駆動）。増水時の泥水表現 |

## 使用例

Scene.jsx の構成（地形フットプリントに合わせ、浸水・濁りを連動）:

```jsx
{showOcean && (
  <WaterOceanLayer
    width={footprint.width}
    height={footprint.depth}
    depth={1}
    opacity={0.85}
    position={[0, 0.5, 0]}
    floodLevel={inputs.floodLevel}
    murkiness={inputs.murkiness}
  />
)}
```

## 調整のポイント

- `floodLevel` は `position.y` に加算される（地形は動かさず水位だけ上げる設計）。浸水演出は 0.6 程度まで（Scene の leva 上限）
- `murkiness` は uniform 駆動なので再コンパイルなしで泥水（`#6f5c3d`）へ寄る。色・光吸収色・不透明度が同時に濁る
- `opacity` は transmission と opacityNode の両方に効く。0.85 前後で水中が透けつつ存在感が出る
- 広い面積を軽量に描くレイヤー。細かい波の造形が欲しいときは WaterBoxLayer（頂点変位）を検討
- 波の見た目（波紋周波数・コースティクス・フレネル等）はファイル冒頭の定数（EFFECTS / CAUSTIC / SIDE 等）で調整（props では露出していない）

## 関連

- ソース: `src/layers/WaterOceanLayer.jsx`
- 関連: `src/layers/WaterBoxLayer.jsx`（箱型・頂点変位の高精細版）, `src/layers/WaterBlobLayer.jsx`（ブロブ版）
- テクスチャ: `public/textures/waternormals.jpg`
- 連携: `src/scenario/weather.js`（floodLevel / murkiness 導出）
