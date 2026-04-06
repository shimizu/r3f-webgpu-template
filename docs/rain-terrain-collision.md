# RainLayer - TerrainLayer 衝突判定ドキュメント

## データフロー

```
TerrainLayer (GeoTIFF 読込)
  → buildTerrainGeometry (CPU: DEM → Float32Array)
  → heightInfo = { heights, cols, rows, terrainWidth, terrainDepth }
  → Scene.jsx: onHeightData コールバックで state に保持
  → RainLayer (props 経由で受け取り)
  → createRainComputeRunner (GPU compute 初期化)
  → rainComputeNode (毎フレーム GPU 上で衝突判定 + リスポーン)
```

## heightInfo の構造

TerrainLayer が `onHeightData` で返すオブジェクト。

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `heights` | Float32Array | 地形の高さデータ（row-major: `heights[row * cols + col]`） |
| `cols` | number | DEM グリッドの列数（X 方向） |
| `rows` | number | DEM グリッドの行数（Z 方向） |
| `terrainWidth` | number | ワールド座標での幅（X 方向） |
| `terrainDepth` | number | ワールド座標での奥行き（Z 方向） |

### 高さデータの生成過程（TerrainLayer.jsx）

1. GeoTIFF を読み込み、NODATA 値を 0 に置換
2. ガウシアンブラー適用（`smooth` パラメータ）
3. 標高値を正規化（最大高さ = `targetHeight × heightScale`）
4. GeoTIFF の座標系（北→南、西→東）を反転して Three.js 座標系に合わせる

## GPU Compute の構成

### バッファ（StorageBufferAttribute）

| バッファ | サイズ | 用途 |
|---------|--------|------|
| `positionAttribute` | particleCount × 3 | 雨粒の現在位置（読み書き） |
| `velocityAttribute` | particleCount × 3 | 雨粒の速度ベクトル（読み書き） |
| `splashPosAttribute` | particleCount × 3 | スプラッシュ粒子の位置 |
| `splashVelAttribute` | particleCount × 3 | スプラッシュ粒子の速度 |
| `splashLifeAttribute` | particleCount × 1 | スプラッシュの残り寿命 |
| `heightMapAttribute` | cols × rows × 1 | 地形高さマップ（読み取り専用） |

### Uniform

| Uniform | 説明 |
|---------|------|
| `timeNode` | 経過時間（秒） |
| `deltaNode` | フレーム間隔 |
| `halfWNode` / `halfDNode` | 雨のエリア半幅 / 半奥行き |
| `topYNode` | 雨の最大高さ |
| `rainSpeedNode` | 基本落下速度 |
| `windXNode` / `windZNode` | 定常風 |
| `heightColsNode` / `heightRowsNode` | 高さマップのグリッドサイズ |
| `terrainHalfWNode` / `terrainHalfDNode` | テラインの半幅 / 半奥行き |
| `terrainWidthNode` / `terrainDepthNode` | テラインの幅 / 奥行き |
| `turbScaleNode` / `turbStrengthNode` | 乱流パラメータ |
| `gustFreqNode` / `gustStrengthNode` | 突風パラメータ |

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

```
// 雨粒の次の位置からテライン座標へ正規化
u = (nextPos.x + terrainHalfW) / terrainWidth
v = (nextPos.z + terrainHalfD) / terrainDepth

// [0, 1) にクランプしてグリッド座標に変換
col = floor(clamp(u, 0, 0.999) × (cols - 1))
row = floor(clamp(v, 0, 0.999) × (rows - 1))

// 高さマップから地表高さを取得（最近傍法）
groundY = heights[row × cols + col]

// 衝突判定
needsRespawn = (nextPos.y <= groundY) || (|nextPos.x| > halfW) || (|nextPos.z| > halfD)
```

heightInfo がない場合は `groundY = 0` にフォールバックする。

### 4. リスポーン（GPU）

衝突または範囲外になった雨粒は天頂（`topY`）のランダム位置に再配置される。`select()` で分岐なく切り替え。

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

- **最近傍法**: 高さサンプリングはバイリニア補間ではなく最近傍。パフォーマンス優先
- **分岐回避**: GPU 上で `select()` を使い、SIMD 実行を妨げない
- **疑似乱数**: `sin/cos` ベースの決定論的ノイズで GPU 親和的に実装
- **WORKGROUP_SIZE = 64**: 典型的な GPU アーキテクチャに最適化
- **メモリレイアウト**: Row-major で CPU-GPU 間のデータ互換性を確保

## 関連ファイル

- `src/layers/RainLayer.jsx` — 雨パーティクル + スプラッシュの描画・compute 呼び出し
- `src/compute/runRainCompute.js` — GPU compute shader の定義（衝突判定の核心）
- `src/layers/TerrainLayer.jsx` — GeoTIFF 読み込み・heightInfo 生成
- `src/Scene.jsx` — heightInfo の state 管理・コンポーネント間の接続
