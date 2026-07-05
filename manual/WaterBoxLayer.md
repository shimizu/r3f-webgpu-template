# WaterBoxLayer

TSL による箱型の水面シミュレーション（頂点変位のうねり + 泡 + きらめき + コースティクス）。

## 概要

分割数の高いボックスジオメトリの上面を、複数の波成分（うねり・交差うねり・風波・Perlin さざなみ）で頂点変位させる高精細な TSL 水面。波頭にホワイトウォーター（泡）、水面にきらめき（glint）とフレネル反射、側面に深度グラデーション・フェイクコースティクス・波紋を合成する。環境反射は `CubeCamera`（frames=1）で 1 回だけ環境マップをキャプチャして使う。WaterOceanLayer より造形が細かく水盤・池・プールなど比較的狭い水面に向く。現 Scene ではマウントされていない（import はトグル運用で保持）。

## 前提・依存

- 配置前提: なし
- `CubeCamera`（drei）で環境マップを 1 回キャプチャして反射に使う
- ジオメトリの `segments` が波の解像度を決める（大きいほど高精細・高負荷）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| width | number | 6 | 幅（X） |
| height | number | 6 | 奥行（Z） |
| depth | number | 1.5 | 水の厚み（Y） |
| position | [x,y,z] | [0,0,0] | 配置位置（CubeCamera の中心にも使用） |
| segments | [x,y,z] | [64,16,64] | 各軸の分割数。大きいほど波の解像度が上がるが GPU 負荷増 |

## 使用例

```jsx
<WaterBoxLayer
  width={8}
  height={8}
  depth={1.5}
  position={[0, 0, 0]}
  segments={[64, 16, 64]}
/>
```

## 調整のポイント

- `segments` が最大の負荷要因。既定 `[64,16,64]` から下げると軽くなるが波が粗くなる
- 波の造形（うねり振幅・周波数・速度・泡の閾値・きらめき強度など）はファイル冒頭の定数（WAVE / EFFECTS / GLINT / FOAM 等）で調整（props では露出していない）
- 環境反射は `CubeCamera frames={1}` の一度きりキャプチャなので、周囲が動くシーンでも反射は初期状態で固定される（軽量化のため）
- 広い海面には向かない（頂点数が増えすぎる）。広域は WaterOceanLayer（法線ベースの軽量版）を使う
- 現 Scene では未マウント。有効化する場合は Scene.jsx の JSX に追加する

## 関連

- ソース: `src/layers/WaterBoxLayer.jsx`
- 関連: `src/layers/WaterOceanLayer.jsx`（広域・軽量版）, `src/layers/WaterBlobLayer.jsx`（球体変形のブロブ版）
