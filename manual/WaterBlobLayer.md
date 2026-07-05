# WaterBlobLayer

TSL による有機的なブロブ状の水塊（球体を変形した水の塊 + 波 + 脈動）。

## 概要

高分割の球体ジオメトリを `positionNode` で変形し、上面が平坦で端が丸い「水の塊」を作る TSL 水面。楕円体スケール → 上面/底面の平坦化 → 側面の膨らみ（表面張力風）→ ゆっくりした脈動 → ノイズによる有機的変形 → 上面の波ディスプレースメント、の順で形状を組み立てる。表面には WaterBoxLayer と同じ波・泡・きらめき・コースティクス・フレネル・深度カラーを合成する。単体の水滴・水盤・池といった「置き物」的な水表現に向く。環境反射は `CubeCamera`（frames=1）でキャプチャ。現 Scene ではマウントされていない（import はトグル運用で保持）。

## 前提・依存

- 配置前提: なし
- `CubeCamera`（drei）で環境マップを 1 回キャプチャして反射に使う
- ベースは `sphereGeometry`（128 分割）。上面を水面位置に合わせるため内部で Y オフセットを適用

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| width | number | 20 | X 方向のサイズ |
| height | number | 8 | Z 方向のサイズ（楕円体の奥行） |
| depth | number | 2.5 | Y 方向の厚み |
| position | [x,y,z] | [0,0,0] | 配置位置（CubeCamera の中心にも使用） |

## 使用例

```jsx
<WaterBlobLayer
  width={20}
  height={8}
  depth={2.5}
  position={[0, 0, 0]}
/>
```

## 調整のポイント

- blob 形状（上面/底面の平坦化度・端の丸み・膨らみ・脈動・変形ノイズ）はファイル冒頭の `BLOB` 定数で調整（props では露出していない）
- `width` / `height` / `depth` は楕円体のスケール。縦横比を変えて細長い水路や丸い水盤にできる
- 上面の平坦化（`BLOB.flattenPower`）に応じてメッシュを下げるオフセットが内部で自動計算される（水面が position.y に来る）
- 分割数は 128 固定（`SPHERE_SEGMENTS`）。滑らかだが単体ブロブ用途を想定した頂点数
- 環境反射は `CubeCamera frames={1}` の一度きりキャプチャ
- 現 Scene では未マウント。有効化する場合は Scene.jsx の JSX に追加する

## 関連

- ソース: `src/layers/WaterBlobLayer.jsx`
- 関連: `src/layers/WaterBoxLayer.jsx`（箱型・頂点変位版）, `src/layers/WaterOceanLayer.jsx`（広域・軽量版）
