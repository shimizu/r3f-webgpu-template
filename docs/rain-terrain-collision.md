# 地形衝突と共有ハイトフィールド

> このドキュメントはもともと RainLayer 専用の衝突判定を扱っていたが、地形の高さ場は
> `HeightFieldContext` + 共有バイリニアサンプラに一般化され、雨だけでなく雪・火の粉・
> 竜巻デブリの地形衝突、草の接地、山火事の延焼判定まで同じ仕組みを共有するようになった。
> 本ドキュメントもその現状に合わせて更新している。

## データフロー

```
TerrainLayer (GeoTIFF 読込)
  → buildTerrainGeometry (CPU: DEM → Float32Array)
  → heightInfo = { heights, cols, rows, terrainWidth, terrainDepth, minY, rangeY }
  → onHeightData コールバック → HeightFieldContext (Provider) が保持
      ├─ StorageBufferAttribute を 1 個だけ生成（DEM の GPU コピーを共有）
      └─ createHeightFieldSampler で { heightAt, normalAt, elevationAt } を配布
  → 各消費者が useHeightField() でサンプラを取得
      ├─ RainLayer / SnowLayer / FireLayer … 地形衝突（compute）
      ├─ GrassLayer … 接地・生育マスク（vertex）
      └─ TerrainLayer … 雪線・延焼標高判定（fragment、elevationAt）
```

以前は heightInfo を Scene の `useState` で保持し props でバケツリレーしていたが、
消費者（草・雨）が各自 DEM の GPU バッファを複製していた。現在は Provider が
バッファを 1 個だけ持ち、サンプラを配ることで複製を排除している。

## heightInfo の構造

TerrainLayer が `onHeightData` で返すオブジェクト。

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `heights` | Float32Array | 地形の高さデータ（row-major: `heights[row * cols + col]`） |
| `cols` | number | DEM グリッドの列数（X 方向） |
| `rows` | number | DEM グリッドの行数（Z 方向） |
| `terrainWidth` | number | ワールド座標での幅（X 方向） |
| `terrainDepth` | number | ワールド座標での奥行き（Z 方向） |
| `minY` | number | 正規化標高 0 に対応するローカル Y（`elevationAt` の逆算に使う） |
| `rangeY` | number | 正規化標高 0..1 に対応するローカル Y レンジ |

### 高さデータの生成過程（TerrainLayer.jsx）

1. GeoTIFF を読み込み、NODATA 値を 0 に置換
2. ガウシアンブラー適用（`smooth` パラメータ）
3. ブラー済み DEM から min/max を算出し、標高レンジ `elevRange = maxElev - minElev` を求める。実装には用途の異なる 2 系統の変換がある:
   - `getNormElev` — `(blurred - minElev) / elevRange` で 0〜1 に正規化。頂点カラー用の `aElevation` 属性に使用
   - `getElev` — `blurred × elevToWorld`（`elevToWorld = (targetHeight / elevRange) × heightScale`）でワールド高さに変換。上面ジオメトリの Y 座標と、衝突判定用の `heightBuffer` に使用
   - つまり標高レンジ（max − min）が `targetHeight × heightScale` にマップされる。`minElev` が 0 でない限り最大高さ ≠ `targetHeight × heightScale`
   - **衝突判定に渡されるのは正規化値ではなく `getElev` のワールド高さ**（`heights` バッファ）である点に注意
4. GeoTIFF の座標系を反転して Three.js 座標系に合わせる。`getElev` / `getNormElev` ともに `demRow = rows-1-row`、`demCol = cols-1-col` で**行・列の両軸を反転**する。衝突用 `heightBuffer` も同じ `getElev` ロジックで生成するため、上面ジオメトリと完全に一致する

## GPU Compute の構成

### バッファ（StorageBufferAttribute）

雨・スプラッシュのバッファは `src/compute/particleBuffers.js` の
`createParticleBuffers()` でまとめて確保する。地形高さマップは各ランナーが
自前で複製せず、`HeightFieldContext` が保持する 1 個を共有サンプラ経由で参照する。

| バッファ | サイズ | 用途 | 所有者 |
|---------|--------|------|--------|
| `pos` | particleCount × 3 | 雨粒の現在位置（読み書き） | ランナー（particleBuffers） |
| `vel` | particleCount × 3 | 雨粒の速度ベクトル（読み書き） | ランナー |
| `splashPos` | particleCount × 3 | スプラッシュ粒子の位置 | ランナー |
| `splashVel` | particleCount × 3 | スプラッシュ粒子の速度 | ランナー |
| `splashLife` | particleCount × 1 | スプラッシュの残り寿命 | ランナー |
| 高さマップ | cols × rows × 1 | 地形高さ（読み取り専用） | **HeightFieldContext（共有）** |

### Uniform

| Uniform | 説明 |
|---------|------|
| `timeNode` | 経過時間（秒） |
| `deltaNode` | フレーム間隔 |
| `halfWNode` / `halfDNode` | 雨のエリア半幅 / 半奥行き |
| `topYNode` | 雨の最大高さ |
| `rainSpeedNode` | 基本落下速度 |
| `windXNode` / `windZNode` | 定常風 |
| `intensityNode` | 雨量 0..1（活性粒数ゲート。粒数・風の強さに連動） |
| `turbScaleNode` / `turbStrengthNode` | 乱流パラメータ（`windField.js` に渡す） |
| `gustFreqNode` / `gustStrengthNode` | 突風パラメータ（同上） |

高さマップのグリッドサイズやテライン寸法の uniform は不要になった。座標→高さの
変換は共有サンプラ（`sampleHeightField.js`）が `terrainWidth/Depth` などを
生成時にクロージャで束ねているため、compute 側は `heightAt(vec2(x, z))` を
呼ぶだけでよい。風場の 3 オクターブ FBM も `windField.js` の `windAt()` に移設した。

## パーティクルのライフサイクル

### 1. 生成（CPU 側、初期化時）

- 位置: X/Z はエリア内ランダム、Y は 0〜topY のランダム高さ
- 速度: Y は `-rainSpeed × [0.8, 1.2]`（粒子ごとにばらつき）、X/Z は風 + 微小ジッター

### 2. 落下（GPU、毎フレーム）

3 オクターブの FBM 風場で自然な揺らぎを加える:

```
オクターブ 1: freq=1.0, amp=1.0  （大きなうねり）
オクターブ 2: freq=2.3, amp=0.4  （中程度の渦）
オクターブ 3: freq=4.7, amp=0.15 （細かい乱流）
```

突風（Gust）を sin 波で時間的に変動させ、風力に加算。

速度制限:
- 水平速度上限: 0.02
- 落下速度範囲: `-rainSpeed × [0.7, 1.3]`

位置更新: `nextPos = currentPos + nextVel × delta × 60`（60fps 基準に正規化）

### 3. 衝突判定（GPU）

地表高さは共有サンプラのバイリニア補間で取得する（旧実装は最近傍だった）。

```js
// 共有サンプラ（HeightFieldContext から取得）。terrainWidth/Depth 等は
// サンプラ生成時にクロージャで束ねられているので、渡すのは XZ だけ
groundY = heightSampler.heightAt(vec2(nextPos.x, nextPos.z))

// 衝突判定
needsRespawn = (nextPos.y <= groundY) || (|nextPos.x| > halfW) || (|nextPos.z| > halfD)
```

`heightAt` の内部は 4 近傍セルの `mix(mix(h00,h10,tx), mix(h01,h11,tx), tz)`。
`heightSampler` がない場合は `groundY = 0` にフォールバックする。草の接地・
雪/火の粉の衝突もこの同じ `heightAt` を使うため、レイヤー間で高さの解釈が揃う。

### 4. リスポーン（GPU）

衝突または範囲外になった雨粒は天頂（`topY`）のランダム位置に再配置される。`select()` で分岐なく切り替え。

### 5. 雨量ゲート（GPU）

`intensityNode`（0..1）で降る粒数を変える。`instanceIndex < intensity × particleCount`
の粒だけを「活性」とし、非活性の粒は画面外（`PARKED_Y = -1000`）へ退避する。
活性化されると `parked` 判定で即リスポーンして降り始める。バッファの再確保も
シェーダの再コンパイルも起こさず、uniform 更新だけで雨量が連続的に変わる。
乱流・突風の強さも雨量に連動させる（`setIntensity()`）。同じ活性ゲートを
`runSnowCompute.js`（雪量）が踏襲している。

## スプラッシュシステム

雨粒と 1:1 対応。衝突時のみ発生し、`life <= 0` なら非表示（位置を 9999 に飛ばす）。

| パラメータ | 値 | 説明 |
|----------|-----|------|
| `maxLife` | 0.4 秒 | スプラッシュの最大寿命 |
| `radiusSpeed` | 0.04 ± 0.02 | 放射方向の初速 |
| `upSpeed` | 0.03 ± 0.015 | 上向きの初速 |
| `gravity` | 0.15 | 重力加速度 |
| `damping` | 0.97 | 水平速度の毎フレーム減衰 |

描画: InstancedMesh + ビルボードクアッド。寿命に応じて sin カーブでサイズが膨張→縮小、不透明度がフェードアウト。

## 実装上の設計判断

- **バイリニア補間へ統一**: 高さサンプリングは共有サンプラのバイリニア補間。
  以前は最近傍（RainLayer）とバイリニア（GrassLayer）が並存していたが、
  斜面での衝突が滑らかになる & レイヤー間で高さの解釈が揃う利点を取り、
  `sampleHeightField.js` に一本化した
- **GPU バッファの共有**: DEM の高さバッファは `HeightFieldContext` が 1 個だけ持つ。
  消費者が増えても複製されない
- **ランナーは抽象化せず共有部品だけ切り出す**: `runXxxCompute.js` は
  `runRainCompute.js` をテンプレートにコピーベースで派生。共有するのは
  バッファ定型（particleBuffers）・風場（windField）・高さサンプラ（sampleHeightField）
  の 3 部品に絞る（update Fn の物理は災害ごとに本質的に異なるため）
- **分岐回避**: GPU 上で `select()` を使い、SIMD 実行を妨げない
- **疑似乱数**: `sin/cos` ベースの決定論的ノイズで GPU 親和的に実装
- **WORKGROUP_SIZE = 64**: 典型的な GPU アーキテクチャに最適化
- **メモリレイアウト**: Row-major で CPU-GPU 間のデータ互換性を確保

## 関連ファイル

- `src/layers/RainLayer.jsx` — 雨パーティクル + スプラッシュの描画・compute 呼び出し
- `src/compute/runRainCompute.js` — 雨の GPU compute（衝突判定の核心・派生のテンプレート）
- `src/compute/particleBuffers.js` — storage バッファ群の確保・破棄の定型
- `src/tsl/windField.js` — 3 オクターブ FBM 風場（+ 竜巻用 vortex 項）
- `src/tsl/sampleHeightField.js` — worldXZ → 高さ/法線/正規化標高の共有サンプラ（`cpuHeightAt` も）
- `src/gis/HeightFieldContext.jsx` — heightInfo と DEM の GPU バッファを保持・配布
- `src/layers/TerrainLayer.jsx` — GeoTIFF 読み込み・heightInfo 生成
- `src/Scene.jsx` — HeightFieldProvider のマウント・各災害レイヤーの接続

## この仕組みを共有する他レイヤー

| レイヤー / ランナー | 高さ場の用途 |
|---|---|
| `runSnowCompute.js` / `SnowLayer` | 降雪の着地判定（rest 静止 + フェード） |
| `runEmberCompute.js` / `FireLayer` | 炎・火の粉のスポーン地表高さ |
| `runVortexCompute.js` / `TornadoLayer` | 竜巻デブリのスポーン地表・衝突 |
| `GrassLayer` | 草ブレードの接地（`heightAt`）と生育域（`elevationAt`） |
| `TerrainLayer` | 雪線・延焼の標高判定（`elevationAt`） |
| `LightningLayer` / `TornadoLayer` | 落雷点・竜巻中心の接地（CPU 側 `cpuHeightAt`） |
