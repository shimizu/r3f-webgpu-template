# Regions（地域プリセット）

「どの地域をジオラマ化するか」に紐づく設定を 1 オブジェクトに集約するプリセット定義。

## 概要

DEM url・bbox・投影ビュー・海面標高・地形パラメータ・ラベル・移動体生成域を
地域ごとに 1 オブジェクトへまとめる。Scene は leva「地域」セレクタで REGIONS から
1 つ選び、各レイヤーへ配線するだけになる（Scene から地域固有のマジックナンバーを排除）。
現在 `hormuz`（ホルムズ海峡）と `taiwan`（台湾）を登録済み。

## リージョン定義の構造

```js
REGIONS.hormuz = {
  id: 'hormuz',
  label: 'ホルムズ海峡',          // leva セレクタの表示名
  demUrl: './dem/hormuz.tif',     // public/dem/ 配下の GeoTIFF
  bbox: { lonMin, lonMax, latMin, latMax }, // tif の実 bbox（getBoundingBox() と同値）
  view: {                          // <Coordinate> に渡す投影ビュー
    centerLon, centerLat, worldScale,
    altitudeScale, sampleLonStep, sampleLatStep, projectionType,
  },
  seaLevel: 0.19,                 // 正規化海面標高（lookdev 調整値。0m の物理値ではない）
  terrain: { smooth, heightScale, baseHeight }, // TerrainLayer の形状パラメータ
  cloudHeight: 5,                 // 雲・雷・竜巻の基準高さ
  labels: [{ id, text, position }], // Labels3DLayer 用の地名
  entityRegion: { lonMin, ..., lonDrift } | null, // MovingEntitiesLayer のモック生成域
}
```

## API

| export | 説明 |
|--------|------|
| `REGIONS` | 全リージョン定義 |
| `REGION_OPTIONS` | leva select 用の `{ ラベル: id }` マップ |
| `regionFootprint({ bbox, view })` | 投影後の地形フットプリント `{ width, depth }`（world units）を返す。equirectangular 前提: 幅 = Δλ·cos(centerLat)·worldScale |

`regionFootprint` は heightInfo（DEM ロード完了）を**待たずに**マウントするレイヤー
（海面・雲・煙）のサイズ決定に使う。

## 使用例

```jsx
// Scene.jsx
const { regionId } = useControls({ regionId: { value: 'hormuz', options: REGION_OPTIONS, label: '地域' } })
const region = REGIONS[regionId]
const footprint = useMemo(() => regionFootprint(region), [region])

<Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
  <TerrainLayer key={region.id} url={region.demUrl} seaLevel={region.seaLevel}
    smooth={region.terrain.smooth} heightScale={region.terrain.heightScale}
    baseHeight={region.terrain.baseHeight} ... />
</Coordinate>
<WaterOceanLayer width={footprint.width} height={footprint.depth} ... />
<CloudLayer width={footprint.width} depth={footprint.depth} position={[0, region.cloudHeight, 0]} ... />
<Labels3DLayer labels={region.labels} />
```

## 新しい地域の追加手順

1. GeoTIFF を `public/dem/` に置く
2. bbox を取得（node + geotiff の `getBoundingBox()`、または初回ロードの console）
3. `REGIONS` にエントリ追加:
   - `view.centerLon/Lat` = bbox 中心
   - `worldScale` = 望むフットプリントから逆算（奥行 = Δφ(rad) × worldScale）
   - `seaLevel` は初期値を置いて lookdev で微調整（縮小 + ブラー済み DEM の
     min..max 正規化基準。物理 0m とはずれる）
4. 地域切替時の注意: Scene は `key={region.id}` で TerrainLayer を再マウントし、
   `setHeightInfo(null)` で旧地形の高さ場を破棄する（既に配線済み）

## 調整のポイント

- `seaLevel` は海色マスク・草/木の生育下限・濡れ/延焼の陸地判定が参照する
  見た目基準の値。海岸線がずれる場合はここを調整
- `worldScale` を変えるとフットプリントが変わり、海面・雲・雨・雪の散布域も
  自動追従する（手打ちサイズは存在しない）
- DEM を持たない汎用ビュー（WORLD_VIEW / JAPAN_VIEW）は `src/gis/views.js` に残っている

## 関連

- ソース: `src/gis/regions.js`, `src/gis/views.js`
- 関連: `CoordinateContext`（view の消費者）, `TerrainLayer`, `Labels3DLayer`
