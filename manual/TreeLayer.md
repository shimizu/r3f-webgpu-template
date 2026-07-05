# TreeLayer

GPU インスタンスによる樹木レイヤー。針葉樹 + 広葉樹の混在を 1 ドローコールで描画。

## 概要

GrassLayer と同じパターンの GPU インスタンス植生レイヤー。針葉樹（円錐 2 段）と
広葉樹（楕円ドーム）の 2 樹種を同一トポロジーでジオメトリに焼き込み、per-instance の
乱数 × 混合比 uniform でどちらかに切り替える。パッチ被覆マスク（森のまとまり）と
生育標高帯（海面〜森林限界）で分布を制御し、梢ほど大きく揺れる風表現を持つ。
DEM 地形の森・林の景観づくりに使う。

## 前提・依存

- 配置前提: `terrain=true` では `HeightFieldProvider` 配下 + heightInfo 到着後に
  マウント（Scene 側でガード）。`terrain=false` では groundField の手続きマウンドに接地
- 連携: DEM 接地・正規化標高（樹種の標高バイアス・生育帯）は `HeightFieldContext` の
  共有サンプラを使用。floor モードの起伏は草（GrassLayer）と同じ既定値・シードで一致する

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `area` | `number` | `40` | 散布する正方形の一辺（terrain 時は無視され地形フットプリントに合わせる） |
| `maxCount` | `number` | `20000` | 生成本数の上限（leva「密度」で間引く） |
| `position` | `[x,y,z]` | `[0,0,0]` | 配置位置 |
| `terrain` | `boolean` | `false` | true で HeightFieldContext の DEM 高さ場に接地 |
| `seaLevel` | `number` | `0` | 正規化海面標高。leva「生育下限標高」の初期値にのみ使う |
| `treeScale` | `number` | `1` | 樹高・樹冠の一括倍率（leva 値に乗算。DEM 上では 0.3〜0.4 目安） |
| `castShadow` | `boolean` | `false` | 影を落とすか（本数が多いと負荷増のため既定オフ） |

### leva「木」フォルダ（uniform 駆動、再コンパイルなし）

密度 / 被覆率 / パッチスケール / パッチ境界 / 樹高 / 樹冠幅 / **針葉樹比率** /
**標高で針葉樹化**（DEM 時、高所ほど針葉樹寄り）/ 風の強さ / 風速 /
幹色 / 針葉樹色 / 広葉樹色 / 個体色差 / 生育下限標高 / 生育上限標高（既定 0.7 =
森林限界。堆積の雪線 0.55 より上で途切れる想定）/ 標高フェード幅

Scene 側の同名フォルダに「表示」「配置」トグルがあり、非表示中もフォルダが残る。

## 使用例

Scene.jsx の実構成（草と同じトグル方式）:

```jsx
const { showTrees, treePlacement } = useControls('木', {
  showTrees: { value: false, label: '表示' },
  treePlacement: {
    value: 'terrain',
    options: { '地形(DEM)': 'terrain', 'ステージ床': 'floor' },
    label: '配置',
  },
})

{showTrees && treePlacement === 'floor' && <TreeLayer area={40} position={[0, -1, 0]} />}
{showTrees && treePlacement === 'terrain' && heightInfo && (
  <TreeLayer
    terrain
    seaLevel={region.seaLevel}
    treeScale={0.35}
    position={[0, 0.5, 0]}
  />
)}
```

## 調整のポイント

- 密度は `instanceCount` の変更のみ（ジオメトリ再生成なし）。他の leva 値も uniform 駆動で即応
- `area` / `maxCount` / terrain 切替は `useMemo` 依存で GPU リソース全再生成を伴う
- 「針葉樹比率」1 で針葉樹のみ、0 で広葉樹のみ。「標高で針葉樹化」を上げると
  低地=広葉樹 / 高地=針葉樹の植生帯が出る（DEM 時のみ）
- 樹種は step で確定するため中間形状は出ない（個体ごとにどちらか一方）
- マスク外・生育帯外の木はスケール 0 に潰れて消える（頂点は処理されるが描画負荷ほぼゼロ）
- `castShadow` は数千本規模ではオンにできるが、密度最大 + ポストFX 併用時は負荷に注意
- 配置は mulberry32 シード PRNG で決定的（リロードで同じ森が再現される）
- `terrain=true` で region に土地被覆データ（LandCoverContext）があれば、散布時の
  rejection sampling で trees クラスにのみ配置される（市街地・湖・裸地に生えない）。
  coverageMask はクラス内の疎密、標高帯マスクは森林限界として従来どおり合成。
  ロード中はマウント保留。データの無い region は従来の無条件散布と bit 同一

## 関連

- ソース: `src/layers/TreeLayer.jsx`
- 依存: `src/tsl/coverageMask.js`, `src/tsl/sampleHeightField.js`（共有サンプラ）,
  `src/layers/groundField.js`（floor モード）, `src/gis/HeightFieldContext.jsx`
- 関連: `GrassLayer`（パターンの原型）, `TerrainLayer`（heightInfo 供給・雪線との整合）
