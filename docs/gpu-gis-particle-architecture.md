# GPU First GIS 可視化アーキテクチャガイド

本ドキュメントは、WebGPU Compute Shader を活用した GIS 可視化システムの設計パターンを解説する。対象読者は設計者・アーキテクト。

扱う範囲:

- GPU-first で大量の地理エンティティを可視化するための設計思想
- CPU/GPU 間のデータレイアウトと責務分離
- GPU 上での地理座標投影と時間ベース補間の設計パターン
- 実データ対応と将来拡張に向けた設計指針

---

## 1. GPU-first GIS の設計思想

大量の移動体（船舶、航空機、車両など）をリアルタイムに地図上へ描画する場合、CPU で 1 件ずつ座標変換や補間を行う方式はスケールしない。件数が数千〜数万に達すると、JavaScript のメインスレッドがボトルネックになり、フレームレートが維持できなくなる。

GPU-first の設計では、責務を次のように分離する。

**CPU の責務:**

- 外部データの受信と JSON パース
- 欠損値の除去と単位の正規化
- typed array へのパッキング
- UI 制御（再生速度、表示切替など）

**GPU の責務:**

- 地理座標から画面座標への投影（毎フレーム）
- 時間ベースの線形補間（毎フレーム）
- 将来的なトレイル更新、ベクトル場粒子の移流

「CPU で座標を全部計算してから描画する」方式を避ける理由は明快で、件数 N に対して毎フレーム O(N) の JavaScript ループが走ることになり、GC 圧力とメインスレッド占有が同時に発生するためである。GPU であれば数万件の並列処理を 1 回の dispatch で完了できる。

---

## 2. Stride ベースの観測データレイアウト設計

### なぜ typed array を使うのか

GPU に大量データを渡す場合、JavaScript のオブジェクト配列は適さない。

```js
// 人間には読みやすいが GPU 向きではない
[
  { lon: 139.76, lat: 35.68, speed: 12.4 },
  { lon: 140.01, lat: 35.55, speed: 9.1 },
]
```

オブジェクト配列の問題点:

- プロパティアクセスのたびにハッシュ探索が発生する
- メモリが連続していないため GPU へ一括転送できない
- GC 対象のオブジェクトが大量に生まれる

`Float32Array` であれば、メモリ上で連続した数値列として GPU バッファへ直接マッピングできる。

### STRIDE + OFFSET パターン

1 エンティティあたりのフィールド数を定数 `STRIDE` として定義し、各フィールドの位置を `OFFSET` オブジェクトで管理する。この定数を CPU 側のパッキングコードと GPU 側の読み出しコードの双方で共有することで、レイアウトの不整合を防ぐ。

```js
const OBSERVATION_STRIDE = 12
const OBSERVATION_OFFSET = {
  lon: 0, lat: 1, alt: 2, timestamp: 3,
  prevLon: 4, prevLat: 5, prevAlt: 6, prevTimestamp: 7,
  speed: 8, heading: 9, type: 10, status: 11,
}
```

バッファの物理的な並びは次のようになる。

```
[entity0: lon, lat, alt, ts, pLon, pLat, pAlt, pTs, spd, hdg, type, status,
 entity1: lon, lat, alt, ts, pLon, pLat, pAlt, pTs, spd, hdg, type, status,
 ...]
```

### 整数値を float としてパックする理由

`type` や `status` のような整数カテゴリ値も `Float32Array` に格納する。これは GPU 側で読み出すバッファを 1 本に統一し、stride ベースのアクセスを崩さないためである。Float32 は整数として 2^24 まで正確に表現できるため、カテゴリコードには十分な精度がある。

---

## 3. GPU 上での地理座標投影パターン

### 等距円筒図法の GPU 実装

等距円筒図法（Equirectangular Projection）は、経度・緯度をそのまま x・y にマッピングする最もシンプルな地図投影法である。GPU 上で実装する場合の手順は次のとおり。

1. 経度・緯度を度からラジアンへ変換する
2. view 中心座標との差分を取る
3. 経度方向に `cos(centerLat)` を掛けて高緯度での歪みを補正する
4. ワールドスケールを掛けて画面座標にする

```js
function createProjectedNode(lonNode, latNode, worldScaleNode, centerLonNode, centerLatNode, cosCenterLatNode) {
  const lambda = lonNode.sub(centerLonNode).mul(DEG2RAD).toVar()
  const phi = latNode.sub(centerLatNode).mul(DEG2RAD).toVar()
  const wrappedPositive = select(lambda.greaterThan(float(PI)), lambda.sub(float(TAU)), lambda).toVar()
  const wrappedLambda = select(wrappedPositive.lessThan(float(-PI)), wrappedPositive.add(float(TAU)), wrappedPositive).toVar()
  return vec3(
    wrappedLambda.mul(cosCenterLatNode).mul(worldScaleNode),
    phi.mul(worldScaleNode),
    float(0)
  )
}
```

### 日付変更線ラッピング

経度差分 `lambda` が `-PI..PI` の範囲を超える場合、日付変更線を跨いでいる。`select` パターンで `TAU` を加減算し、最短経路側に正規化する。これにより、太平洋上の移動体が地図の端から端へワープする問題を防げる。

### cos(centerLat) の事前計算

`cos(centerLat)` は view 中心が変わらない限り定数である。毎フレーム GPU 側で三角関数を計算するのではなく、CPU 側で事前に算出して uniform として渡す方が効率的である。

### CPU/GPU 投影の数式統一

ピッキング（マウス座標 → 地理座標の逆変換）やデバッグ表示で CPU 側にも投影関数が必要になることがある。このとき、CPU 側と GPU 側で同じ数式を使うことが重要である。数式が乖離すると、「CPU で計算した座標と GPU の描画位置がずれる」という追跡困難なバグが発生する。

---

## 4. GPU 上での時間ベース線形補間パターン

### prev/current 2 点保持の必要性

GPU で移動体の中間位置を算出するには、少なくとも前回観測と現在観測の 2 点が必要である。単一時点のスナップショットだけでは、フレーム間の滑らかな移動を GPU 側で生成できない。

2 点の時刻と座標があれば、任意の再生時刻に対する内挿位置を GPU が自律的に計算できる。CPU が毎フレーム「この船はいまここ」と伝える必要がなくなる。

### 補間の計算フロー

1. `playbackTime` を `loopDuration` で正規化し、再生全体における進行率を得る
2. 正規化した進行率から、各エンティティの `prevTimestamp`〜`timestamp` 間でのブレンド率を算出する
3. `mix()` で経度・緯度を線形補間する

```js
const normalizedPlayback = playbackTimeNode.div(loopDurationNode).toVar()
const playbackTimestamp = mix(prevTimestamp, timestamp, normalizedPlayback).toVar()
const timestampSpan = timestamp.sub(prevTimestamp).toVar()
const blend = clamp(
  playbackTimestamp.sub(prevTimestamp).div(timestampSpan),
  float(0), float(1)
).toVar()
const currentLon = mix(prevLon, lon, blend).toVar()
const currentLat = mix(prevLat, lat, blend).toVar()
```

`clamp(0, 1)` により、タイムスタンプ範囲外の外挿を防止している。

### 補間 → 投影のワンパス実行

補間で得た `currentLon / currentLat` をそのまま投影関数に渡すことで、「補間 → 投影」を 1 回の compute dispatch で完了できる。中間結果を一度バッファに書き戻して再読み込みする必要がないため、メモリ帯域を節約できる。

---

## 5. Projection Pass と Interpolation Pass の分離設計

用途に応じて compute pass を使い分ける設計が有効である。

### Projection Pass

静的な観測点（センサー設置位置、港湾、空港など）をそのまま投影する pass。補間は行わない。

処理内容:

- バッファから `lon / lat` を読む
- view 中心との差分を計算する
- 日付変更線ラッピングを適用する
- ワールド座標を出力する

### Interpolation Pass

移動体の補間と投影を 1 パスで実行する pass。

処理内容:

- バッファから `prevLon / prevLat / prevTimestamp` と `lon / lat / timestamp` を読む
- 再生時刻に基づくブレンド率を計算する
- 経度・緯度を線形補間する
- 補間後の座標を投影してワールド座標を出力する

### 選択指針

| ユースケース | 適切な pass |
|---|---|
| 固定地点の表示（観測所、基地局など） | Projection Pass |
| 移動体のリアルタイム追跡 | Interpolation Pass |
| 過去軌跡の再生 | Interpolation Pass |
| ヒートマップ用の静的点群 | Projection Pass |

GPU 側のバッファ読み出しは、いずれの pass でも同じ stride ベースのパターンを使う。

```js
const baseIndex = int(instanceIndex).mul(int(OBSERVATION_STRIDE)).toVar()
const lon = rawObservationNode.element(baseIndex.add(int(OBSERVATION_OFFSET.lon))).toVar()
const lat = rawObservationNode.element(baseIndex.add(int(OBSERVATION_OFFSET.lat))).toVar()
```

---

## 6. 実データへの拡張パターン

### CPU 側パッキング戦略

実データ導入時の CPU 側処理は、次の 2 段階に分離する。

**段階 1: 受信と正規化**

- API やファイルからデータを受信する
- 項目名の違いを吸収する（`longitude` → `lon` など）
- 座標や時刻の欠損を弾く
- 型を数値へ統一する

**段階 2: packed buffer 化**

- エンティティ数を確定する
- `Float32Array` を必要サイズで 1 回確保する
- STRIDE + OFFSET に従って連続書き込みする

```js
function packObservationBuffer(rows) {
  const entityCount = rows.length
  const buffer = new Float32Array(entityCount * OBSERVATION_STRIDE)
  for (let i = 0; i < entityCount; i++) {
    const row = rows[i]
    const base = i * OBSERVATION_STRIDE
    buffer[base + OBSERVATION_OFFSET.lon] = row.lon
    buffer[base + OBSERVATION_OFFSET.lat] = row.lat
    buffer[base + OBSERVATION_OFFSET.alt] = row.alt ?? 0
    buffer[base + OBSERVATION_OFFSET.timestamp] = row.timestamp
    buffer[base + OBSERVATION_OFFSET.prevLon] = row.prev.lon
    buffer[base + OBSERVATION_OFFSET.prevLat] = row.prev.lat
    buffer[base + OBSERVATION_OFFSET.prevAlt] = row.prev.alt ?? 0
    buffer[base + OBSERVATION_OFFSET.prevTimestamp] = row.prev.timestamp
    buffer[base + OBSERVATION_OFFSET.speed] = row.speed ?? 0
    buffer[base + OBSERVATION_OFFSET.heading] = row.heading ?? 0
    buffer[base + OBSERVATION_OFFSET.type] = encodeType(row.type)
    buffer[base + OBSERVATION_OFFSET.status] = encodeStatus(row.status)
  }
  return { entityCount, rawObservationBuffer: buffer }
}
```

この構造にしておけば、データソースが mock から実データに変わっても、GPU 側の compute pass は一切変更不要である。

### mock から real data への切り替え設計

切り替えの理想形は、パッキング関数の差し替えだけで完了する構造である。mock 用と実データ用のパッキング関数が同じ出力型（`{ entityCount, rawObservationBuffer }`)を返すようにしておけば、下流の compute pass 初期化コードは共通化できる。

### Float32Array に入れるべきデータ / CPU 側辞書に分離すべきデータ

**Float32Array に入れるもの:**

- 毎フレーム GPU が読む数値: `lon`, `lat`, `alt`, `timestamp`, `speed`, `heading`
- 整数コード化した分類値: `type`, `status`

**CPU 側辞書に分離するもの:**

- 文字列 ID（船名、便名など）
- 表示用ラベル
- 詳細属性（IMO 番号、運航会社名など）
- 選択 UI 用のメタデータ

GPU は文字列を扱う場所ではない。描画に直接必要な数値だけをバッファに載せ、UI 表示用の情報は CPU 側で別管理する。

### 最低限必要な項目

GPU 補間に移行するための最小フィールドセットは次の 6 項目である。

- `lon`, `lat`, `timestamp`（現在観測）
- `prevLon`, `prevLat`, `prevTimestamp`（前回観測）

高度、速度、見た目制御が必要な場合は `alt`, `prevAlt`, `speed`, `heading`, `type`, `status` を追加する。

---

## 7. CPU/GPU 責務分離の判断基準

### CPU に残してよいもの

- データ受信と JSON パース
- 欠損値の除去
- 単位変換（秒 → ミリ秒の統一など）
- typed array へのパッキング
- UI 制御（再生・停止、速度変更、表示フィルタ）

### GPU に寄せるべきもの

- 毎フレームの個体補間（N 件 × 毎フレーム）
- `lon/lat` → 画面座標変換（N 件 × 毎フレーム）
- トレイル更新（N 件 × 履歴長 × 毎フレーム）
- ベクトル場粒子の移流（粒子数 × 毎フレーム）

### 境界を曖昧にした場合のリスク

「とりあえず CPU で補間して position を set する」方式は、件数が少ないうちは問題なく動作する。しかし件数が増えたとき、次の問題が同時に発生する。

- メインスレッドの JavaScript ループが 16ms を超える
- `mesh.position.set()` の呼び出し回数に比例して CPU 時間が増加する
- GC がフレーム中に走り、スパイクが発生する

この境界を最初から明確にしておけば、件数が 10 倍になっても GPU 側の dispatch 回数は変わらず、CPU 側の負荷は定数的に維持される。

---

## 8. 実データ対応時の注意点

### 時刻の単位をそろえる

`timestamp` と `prevTimestamp` は同じ単位でバッファに格納する必要がある。秒とミリ秒が混在すると、補間のブレンド率が桁違いにずれ、エンティティが瞬間移動したり静止したりする。パッキング段階で統一するのが最も安全である。

### 欠損値の CPU 側フィルタリング

次のような値は、GPU に渡す前に CPU 側で除去または補正する。

- `NaN`, `undefined`
- 緯度が `-90..90` の範囲外
- 経度が `-180..180` の範囲外
- `prevTimestamp` が `timestamp` より大きい（時系列の逆転）

GPU 側の compute shader に防御コードを入れることも可能だが、条件分岐が増えると並列実行効率が下がる。入力データの品質保証は CPU 側の責務とする方が全体設計として健全である。

### ID・表示情報を GPU バッファに詰め込みすぎない

GPU バッファは毎フレーム compute shader が読み書きする高速メモリである。ここに描画に不要な情報を詰めると、stride が大きくなり、キャッシュ効率が低下する。

原則: GPU バッファには「毎フレームの計算に必要な数値」だけを入れる。

---

## 9. 将来の拡張ポイント

以下は、この設計パターンの上に追加可能な拡張の概要である。

### GPU トレイル

各エンティティに固定長の履歴スロット（リングバッファ）を持たせ、位置更新のたびに最新位置を書き込む。描画時には age（経過フレーム数）に応じてアルファをフェードさせることで、移動軌跡を表現する。

設計要素:

- trail 用 storage buffer（エンティティ数 × 履歴長 × vec3）
- write index の管理（リングバッファのヘッド位置）
- age ベースのフェード計算

### ベクトル場粒子

風速や海流のグリッドデータをテクスチャとして GPU に渡し、粒子位置からバイリニアサンプリングで流速を取得する。粒子は流速に従って移流し、寿命が尽きたらランダム位置にリスポーンする。

設計要素:

- flow field テクスチャ（u/v 成分を RG チャンネルに格納）
- 粒子の寿命管理と乱数によるリスポーン
- サンプリング座標の正規化（地理座標 → テクスチャ UV）

### 集約表示

ズームアウト時に個体描画からセル集約表示へ切り替える。compute pass でセルインデックスを計算し、セルごとのカウントや平均値を集約バッファに書き込む。

設計要素:

- aggregation pass（セル割り当て + atomic カウント）
- cell index 計算（地理座標 → グリッド行列）
- 集約結果の描画レイヤー（ヒートマップ、バブル等）
