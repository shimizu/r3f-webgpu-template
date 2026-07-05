# Coordinate（投影コンテキスト）

GIS 投影設定を子レイヤーに提供するコンテキストコンポーネント。このプロジェクトの GIS 設計の中核。

## 概要

`<Coordinate projection view>` で投影設定（図法・中心座標・ワールドスケール）を
一元管理し、配下のレイヤーが `useProjection()` で参照する。地理座標を扱うレイヤーは
自前で投影せず、このコンテキスト経由で `projectLonLatGPU()`（GPU）/
`projectLonLatCPU()`（CPU 焼き込み）を使うことで、地形・ベクター地図・移動体の
位置が自動的に整合する。

グループ自体が投影 XY 平面を床面に寝かせる回転（`[-π/2, 0, 0]`）を持つ。
**北 = -Z（画面奥）** がこのプロジェクトの方位規約（雪の北斜面判定などが依存）。

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `projection` | string | view.projectionType ?? 'equirectangular' | 図法。`equirectangular` / `mercator` / `lambert-cylindrical` / `natural-earth` |
| `view` | object | （必須） | ビュー定義 `{ centerLon, centerLat, worldScale, sampleLonStep, ... }`。regions.js の `region.view` を渡すのが基本 |
| `rotation` | [x,y,z] | `[-π/2, 0, 0]` | 投影平面の回転（通常は変更しない） |
| `...groupProps` | - | - | `position` 等はそのまま `<group>` に渡る |

## フック

| フック | 説明 |
|--------|------|
| `useProjection()` | `{ view, projUniforms, projectionType }` を返す。`<Coordinate>` 外では throw |
| `useProjectionMaybe()` | optional 版。外では null（TerrainLayer の投影/legacy モード判定に使用） |

## 使用例

```jsx
import Coordinate from './gis/CoordinateContext'
import { REGIONS } from './gis/regions'

const region = REGIONS.hormuz

<Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
  <TerrainLayer url={region.demUrl} ... />   {/* bbox + view から自動サイズ */}
  <GeojsonLayer url="/data/world.geojson" /> {/* 同一投影で自動整合 */}
  <MovingEntitiesLayer entityCount={2000} /> {/* GPU 投影も同じ uniforms */}
</Coordinate>
```

新レイヤーで地理座標を扱う場合:

```jsx
const { projUniforms, projectionType } = useProjection()
const worldPos = projectLonLatGPU(lonNode, latNode, projUniforms, projectionType)
```

## 調整のポイント

- **図法の切替は再コンパイルを伴う**（projectionType がシェーダに焼き込まれる）
- TerrainLayer の投影は CPU 焼き込みのため、`projUniforms.update()` による動的
  view 変更には追従しない。view オブジェクトごと差し替えて再マウントする
- 複数の `<Coordinate>` を並べて別図法・別地域を同時表示することも可能
  （projUniforms はコンテキストごとに独立）
- 日付変更線ラッピング・ポリゴンクリップは `projectionGPU.js` 側で処理済み

## 関連

- ソース: `src/gis/CoordinateContext.jsx`, `src/gis/projectionGPU.js`,
  `src/gis/projectionUniforms.js`, `src/gis/projectionOptions.js`, `src/gis/views.js`
- ドキュメント: `docs/projection-formulas.md`（図法数式）,
  `docs/gpu-gis-particle-architecture.md` §3（GPU 投影パターン）
- 消費レイヤー: `TerrainLayer`（optional）, `GeojsonLayer` / `MovingEntitiesLayer`（必須）
