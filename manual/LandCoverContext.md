# LandCoverContext（共有土地被覆）

Dynamic World 土地被覆（GeoTIFF、クラス値 0..8）を全レイヤーで共有するコンテキスト。
GPU リソース（DataTexture）は 1 個だけ生成。HeightFieldContext と同型のパターン。

## 概要

`region.landcoverUrl` を Provider 自身が読み込み、CPU 生データ・nearest DataTexture・
CPU サンプラを全消費者（地形配色・草木の散布・今後の建物配置）に配布する。
landcoverUrl を持たない region では `status: 'idle'` のまま何もロードせず、
消費者は既存分岐（標高 stops 配色 / 無条件散布）を通る = 挙動・コスト変化ゼロ。

クラス値はカテゴリカルなので**補間は厳禁**:

- 読み込みは縮小なしフル解像度（geotiff の resample はバイリニアでクラスが化ける）
- DataTexture は `NearestFilter` + mipmap なし（R8）
- CPU サンプラも nearest

## クラス定義（`src/gis/landcover.js`）

| 値 | クラス | 用途 |
|----|--------|------|
| 0 | water | 地形配色で水深 mix |
| 1 | trees | `TREE_CLASSES`（樹木の散布先） |
| 2 | grass | `GRASS_CLASSES` |
| 3 | flooded_vegetation | （除外中） |
| 4 | crops | `GRASS_CLASSES` |
| 5 | shrub_and_scrub | `GRASS_CLASSES` |
| 6 | built | 将来の建物配置の入力候補 |
| 7 | bare | |
| 8 | snow_and_ice | |

パレット（クラス → albedo）は `DEFAULT_LC_PALETTE`。判定・配色の定義は
landcover.js に一元化し、レイヤー側で再定義しない。

## API

### `<LandCoverProvider url view>`

Scene の JSX 全体をラップする（regionId が SceneContent 内の leva 値なので
`Scene()` 側ではなく JSX ラップ）。`url` は `region.landcoverUrl ?? null`、
`view` は `region.view`。texture の dispose は Provider が担う。

### `useLandCover()`

```js
const { status, info, texture, classAtWorld, worldToLonLat } = useLandCover()
```

| 値 | 説明 |
|----|------|
| `status` | `'idle'`（url なし / 失敗）\| `'loading'` \| `'ready'` |
| `info` | `{ data: Uint8Array, width, height, bbox }` \| null（CPU 生データ。将来の建物配置もこれを読む） |
| `texture` | R8 nearest DataTexture（行反転済み: v=1 が北。TerrainLayer の uv 規約と同じ） |
| `classAtWorld` | `(x, z) => 0..8`（world XZ → クラス値の CPU nearest サンプラ）\| null |
| `worldToLonLat` | `(x, z) => [lon, lat]`（equirectangular 逆投影） |

## 座標変換（`src/gis/landcover.js`）

- `createWorldToLonLat(view)` — world XZ → lon/lat。equirectangular 専用
  （他図法の region に landcoverUrl を書くと warn してフィルタ無効化）
- `demUvToLcUvCoeffs(demBbox, lcBbox)` — DEM uv → 土地被覆 uv の affine 係数。
  bbox 比のみで投影非依存・厳密（TerrainLayer の配色が使用）。
  DEM と landcover の bbox が微妙に違っても正しく吸収される

## 消費者と使い方

| 消費者 | 経路 | 内容 |
|--------|------|------|
| TerrainLayer | GPU（texture + affine） | クラス → パレット LUT の albedo。優先順位 texMap > landCover > 標高 stops |
| TreeLayer | CPU（classAtWorld） | 散布時 rejection sampling（trees クラスのみ） |
| GrassLayer | CPU（classAtWorld） | 散布時 rejection sampling（grass/crops/shrub） |

散布側は `status === 'loading'` の間マウントを保留する（無条件散布 → 到着後に
再散布、の二度手間と再コンパイルを防ぐ）。

## 地域プリセットへの追加手順

1. `public/landcover/` に EPSG:4326 の土地被覆 GeoTIFF を置く（DEM と同範囲推奨）
2. `regions.js` の該当 region に `landcoverUrl: './landcover/xxx.tif'` を 1 行追加
3. 完了。持たない region は一切影響を受けない

## 調整のポイント

- 樹木/草の対象クラスを変えるときは landcover.js の `TREE_CLASSES` / `GRASS_CLASSES`
- 地形の色はレイヤー側の `lcUniforms`（palette 9 色 + shadeDark/shadeBright/
  mottleScale/mottleAmount）。すべて `.value` 更新で再コンパイルなし
- rejection の座標引き直しで散布の乱数消費列が変わるため、landcover の有無で
  草木の配置は変わる（データなし region は従来と bit 同一）

## 関連

- ソース: `src/gis/LandCoverContext.jsx`, `src/gis/landcover.js`
- データ: `public/landcover/japan_landcover.tif`（Dynamic World、約 30m、9 クラス）
- 消費者: `TerrainLayer` / `TreeLayer` / `GrassLayer`
