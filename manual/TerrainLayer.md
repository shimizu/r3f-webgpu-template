# TerrainLayer

GeoTIFF (DEM) から 3D 地形メッシュを生成し、標高カラー・濡れ・堆積（雪/苔）・延焼を表現するレイヤー。

## 概要

GeoTIFF 形式の DEM（数値標高モデル）を読み込み、上面・側面・底面を持つ箱型の地形メッシュを構築する。標高に応じたカラーグラデーション（深海〜山頂）またはテクスチャで着色し、`<Coordinate>` 配下では bbox と view から自動でサイズ・位置を決定して他の GPU 投影レイヤー（GeojsonLayer 等）と整合する。region に土地被覆データ（`landcoverUrl`、LandCoverContext）があればクラス別のパレット配色（森林=緑・市街地=グレー・水域=水深 mix 等）が標高カラーより優先される（BASE 色の優先順位: `texture` prop > 土地被覆 > 標高 stops）。降雨連動の「濡れ」、降雪連動の「堆積（雪/苔）」、山火事の「延焼」を uniform 駆動で重ねられる（値変更でシェーダ再コンパイルは走らない）。地形の高さバッファ（heightInfo）を `onHeightData` で外部に発行し、草・雨などの接地・衝突判定に共有する。

## 前提・依存

- 配置前提: `url`（GeoTIFF）が必須。`<Coordinate>` 配下では投影モード（bbox + view からサイズ自動決定）、外では legacy グリッドモード
- 地理参照のない GeoTIFF は legacy モードにフォールバック（コンソール警告）
- 大きな DEM は自動縮小（512px 超で overview / resample を使用）
- 連携:
  - `onHeightData` で発行する heightInfo を `HeightFieldProvider` の `setHeightInfo` に接続すると、GrassLayer（DEM 接地）・RainLayer / SnowLayer（地形衝突）が同じ高さ場を共有する
  - `wetness` は RainLayer の雨量と連動（Scene では `deriveLayerInputs` の `wetnessTarget`）
  - `snowing` は SnowLayer の降雪と連動
  - `fireIgnition` / `fireRadius` は FireLayer / SmokeLayer と同じ発火点・半径を共有
  - `LandCoverProvider` 配下で土地被覆があれば、DEM uv → 土地被覆 uv の bbox 間 affine で
    nearest サンプルしてクラス別配色（詳細は [LandCoverContext](./LandCoverContext.md)）。
    濡れ・堆積・延焼は土地被覆色の上にも従来どおり乗る

## Props（基本）

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| url | string | （必須） | GeoTIFF (DEM) の URL |
| texture | string \| null | null | 上面に貼るテクスチャ画像パス。null なら標高カラー |
| size | number | 16 | 基準幅（legacy モードのみ。投影モードでは無視され警告） |
| heightRange | number | 4 | 標高レンジ（メッシュの高さスケール） |
| elevationStops | number[] | `[0,0.3,0.4,0.5,0.7,0.85,1.0]` | 標高カラーの境界（正規化標高） |
| colors | object | DEFAULT_COLORS | 標高カラー（deepOcean/shallowOcean/shore/lowland/highland/mountain/peak/side） |
| smooth | number | 0 | ガウシアンブラー半径（DEM 平滑化） |
| heightScale | number | 1.0 | 高さの追加倍率 |
| baseHeight | number | 2.0 | 底面までの深さ（箱の厚み） |
| seaLevel | number | 0 | 海面の正規化標高。カラー分岐・濡れ/延焼の陸地判定に使用 |
| position | [x,y,z] | [0,0,0] | 配置位置 |
| onHeightData | (heightInfo) => void | - | 高さ場コールバック。heightInfo を返す |

heightInfo の中身: `{ heights, cols, rows, terrainWidth, terrainDepth, minY, rangeY }`。

### Props（wet: 濡れ）

陸地上面のみに fBM パッチで albedo を暗く・roughness を下げる。`wetness` を目標に非対称の時定数で追従（降り始めは速く、乾きはゆっくり）。

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| wetness | number | 0 | 濡れカバレッジ目標 0..1（0=乾燥、1=全面濡れ） |
| wetDarken | number | 0.55 | 濡れ部の albedo 減衰率 |
| wetRoughness | number | 0.35 | 濡れ部の roughness（艶） |
| wetScale | number | 0.35 | 濡れパッチの空間周波数 |
| wetRiseTime | number | 1.5 | 濡れの立ち上がり時定数（秒） |
| wetFallTime | number | 8 | 乾きの時定数（秒） |

### Props（acc: 堆積 = 雪/苔）

法線の向き（平らな上面 + 北斜面）× 標高（雪線）× パッチで積もり量を決める。最終堆積量は `max(snowAmount, 降雪駆動)`。`snowing` 中はゆっくり積もり、止むとゆっくり融ける。

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| snowAmount | number | 0 | 手動のマスター量 0..1（leva スライダー。即時反映） |
| snowing | boolean | false | 降雪中フラグ。ON で時定数追従して積もる |
| snowLine | number | 0.55 | 堆積が始まる正規化標高 |
| snowBand | number | 0.15 | 雪線の遷移幅 |
| snowAspect | number | 0.15 | 北斜面が実効的に雪線を下げる量 |
| snowFlatThreshold | number | 0.3 | 積もる面の傾き閾値（normalWorld.y） |
| snowColor | string | '#eef4ff' | 堆積色（白=雪 / 緑=苔） |
| snowRoughness | number | 0.9 | 堆積面の roughness（雪はマット） |
| snowNormalFlatten | number | 0.5 | 法線を上方向へ寄せる強さ |
| snowPatchScale | number | 0.4 | 堆積パッチの空間周波数 |
| snowRiseTime | number | 40 | 積雪の立ち上がり時定数（秒） |
| snowFallTime | number | 240 | 融雪の時定数（秒） |
| snowDriveMax | number | 0.9 | 降雪駆動が到達する堆積量の上限 |

### Props（burn: 延焼 = 山火事）

発火点距離場の解析近似（burnField.js）。焼け跡は albedo を焦がし roughness を上げ、燃焼前線帯はちらつく残火 emissive を出す。`radius` は CPU（Scene）側で進めるので即時反映。

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| fireIgnition | [x,z] \| null | null | 発火点（レイヤーローカル XZ） |
| fireRadius | number | 0 | 延焼半径（world units）。0 で OFF |

## 使用例

Scene.jsx の実際の構成（`<Coordinate>` 配下 + region プリセット + heightInfo 発行）:

```jsx
<Coordinate projection={region.view.projectionType} view={region.view} position={[0, 0.5, 0]}>
  <TerrainLayer
    key={region.id}          // 地域切替で DEM 再ロード → 再マウント
    url={region.demUrl}
    smooth={region.terrain.smooth}
    heightScale={region.terrain.heightScale}
    baseHeight={region.terrain.baseHeight}
    seaLevel={region.seaLevel}
    onHeightData={setHeightInfo}   // HeightFieldProvider に接続
    wetness={inputs.wetnessTarget}
    snowAmount={snowAmount}
    snowing={inputs.snowing}
    fireIgnition={fireIgnition}
    fireRadius={fireRadius}
    snowLine={snowLine}
    snowAspect={snowAspect}
    snowColor={snowColor}
    snowRoughness={snowRoughness}
  />
</Coordinate>
```

最小構成（テクスチャ地形、投影なし）:

```jsx
<TerrainLayer url="/data/dem.tif" texture="/textures/terrain.jpg" size={16} />
```

## 調整のポイント

- 地域を切り替える際は `key` を変えて再マウントする（DEM 再ロードを伴うため）
- 投影モードでは `size` は効かない（`view.worldScale` がサイズを決定）。legacy モードでのみ `size` が有効
- 投影は CPU 焼き込みのため `projUniforms.update()` による動的 view 変更には追従しない。view オブジェクトを差し替えれば再ビルドされる
- 濡れ/堆積/延焼はいずれも uniform 駆動なので、スライダー操作で再コンパイルは走らない（滑らかに変化）
- `smooth` を上げると DEM のノイズが取れるが尾根が甘くなる。ブラーは CPU の分離ガウシアン
- mercator / natural-earth 図法では格子が非等間隔になり、規則格子前提の衝突ルックアップ（RainLayer）は近似になる
- タブ復帰後の巨大 dt は 0.1 秒にクランプ済み（時定数追従が飛ばない）

## 関連

- ソース: `src/layers/TerrainLayer.jsx`
- 関連: `src/gis/CoordinateContext.jsx`（投影）, `src/gis/HeightFieldContext.jsx`（高さ場共有）, `src/tsl/burnField.js`（延焼近似）, `src/tsl/coverageMask.js`, `src/gis/regions.js`（地域プリセット）
- ドキュメント: `docs/rain-terrain-collision.md`, `docs/projection-formulas.md`
- 連携レイヤー: `GrassLayer`（DEM 接地）, `RainLayer` / `SnowLayer`（地形衝突）, `FireLayer` / `SmokeLayer`（延焼）
