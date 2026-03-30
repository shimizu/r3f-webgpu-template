# GPU First GIS パーティクルシステム入門

このドキュメントは、このリポジトリのパーティクルシステムを入門者向けに説明するためのものです。

対象:

- いまの実装が何をしているか知りたい
- なぜ CPU ではなく GPU で処理しているのか知りたい
- 将来的にランダム粒子ではなく、緯度経度を持つ実データセットへ差し替えたい
- そのときに CPU から GPU へどうデータを渡せばよいか知りたい

## 1. まず全体像

このプロジェクトは、単なる見た目の粒子デモではなく、GPU First な GIS 可視化基盤を目指しています。

考え方はかなり明確です。

- CPU は受信、最小限のパッキング、UI 制御を担当する
- GPU は投影、補間、位置更新、将来のトレイルや風場粒子を担当する
- 大量データを JavaScript のオブジェクト配列として毎フレームこね回さない

つまり「CPU で座標を全部計算してから描画する」のではなく、「CPU はデータを GPU に渡し、GPU が大量件数をまとめて処理する」構造です。

## 2. 現在のアーキテクチャ

現在の主要ファイルは次のとおりです。

- [src/Scene.jsx](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/Scene.jsx)
- [src/layers/MovingEntitiesLayer.jsx](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/layers/MovingEntitiesLayer.jsx)
- [src/layers/BaseMapLayer.jsx](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/layers/BaseMapLayer.jsx)
- [src/data/mockObservations.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/data/mockObservations.js)
- [src/compute/observationLayout.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/observationLayout.js)
- [src/compute/createProjectionPass.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/createProjectionPass.js)
- [src/compute/createInterpolationPass.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/createInterpolationPass.js)

大まかな流れはこうです。

1. `Scene.jsx` が背景地図と移動体レイヤーを表示する
2. `MovingEntitiesLayer.jsx` が観測データを受け取り、compute pass を初期化する
3. `mockObservations.js` が観測データを `Float32Array` として作る
4. `createInterpolationPass.js` が GPU 上で補間と投影を実行する
5. `InstancedMesh` が compute 結果の位置バッファをそのまま読んで描画する

重要なのは、描画直前の位置を CPU が 1 件ずつ計算していないことです。

## 3. なぜ typed array を使うのか

GPU に大量データを渡すとき、JavaScript の配列やオブジェクトのままでは扱いづらく、無駄も多くなります。

例えば次のような配列は、人間には読みやすいですが GPU 向きではありません。

```js
[
  { lon: 139.76, lat: 35.68, speed: 12.4 },
  { lon: 140.01, lat: 35.55, speed: 9.1 },
]
```

GPU に渡したいのは、むしろ次のような連続した数値配列です。

```js
Float32Array([
  lon0, lat0, alt0, timestamp0, prevLon0, prevLat0, prevAlt0, prevTimestamp0, speed0, heading0, type0, status0,
  lon1, lat1, alt1, timestamp1, prevLon1, prevLat1, prevAlt1, prevTimestamp1, speed1, heading1, type1, status1,
])
```

この方式の利点:

- メモリ上で連続しているので GPU へ渡しやすい
- レコード幅が固定なので compute shader から読みやすい
- CPU 側の余計なオブジェクト処理を減らせる

## 4. 現在の観測データレイアウト

[src/compute/observationLayout.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/observationLayout.js) では、1 レコードのレイアウトを固定しています。

現在の構造:

- `lon`
- `lat`
- `alt`
- `timestamp`
- `prevLon`
- `prevLat`
- `prevAlt`
- `prevTimestamp`
- `speed`
- `heading`
- `type`
- `status`

`OBSERVATION_STRIDE = 12` なので、1 エンティティあたり 12 個の `float` を使います。

compute shader は `instanceIndex * OBSERVATION_STRIDE` を基準にして、このレコードを読み出します。

## 5. 現在の描画フロー

### 5-1. CPU 側

CPU 側の役割はかなり小さいです。

- 件数を決める
- モック観測データを作る
- view 情報を渡す
- 再生時刻 `playbackTime` を更新する

### 5-2. GPU 側

GPU 側では主に次をやっています。

- `prevLon/prevLat` と `lon/lat` の線形補間
- view 中心からの差分計算
- ラジアン変換
- equirectangular ベースの簡易投影
- world 座標への書き込み

### 5-3. 描画側

描画側では `InstancedMesh` が compute 結果を直接読みます。

- 各インスタンスの位置は `system.positionNode.element(instanceIndex)` を使う
- billboard 化して常にカメラを向かせる
- 色は type に応じて切り替える

この構造だと、CPU が毎フレーム `mesh.position.set(...)` を大量件数ぶん呼ぶ必要がありません。

## 6. Projection Pass と Interpolation Pass の役割分担

### Projection Pass

[src/compute/createProjectionPass.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/createProjectionPass.js) は、観測点をそのまま投影したいときの基礎です。

役割:

- `lon/lat` を読む
- view 中心との差分を取る
- 経度の折り返しを処理する
- `worldX/worldY/worldZ` を計算する

### Interpolation Pass

[src/compute/createInterpolationPass.js](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/src/compute/createInterpolationPass.js) は、現在の移動体表示で使っている中核 pass です。

役割:

- `prevTimestamp -> timestamp` の間の進行率を計算する
- `prevLon/prevLat` と `lon/lat` を補間する
- 補間後の位置を投影する

つまり現在の移動体表示は、「補間してから投影する」を 1 つの compute pass でやっています。

## 7. 実データへ拡張するときの基本方針

今後、ランダム粒子ではなく、実際の緯度経度を持ったデータセットを元に動かすことになります。

そのときの原則は次です。

- CPU で 1 件ずつ投影しない
- CPU で 1 件ずつ毎フレーム補間しない
- まずデータを packed buffer にする
- packed buffer を GPU に渡す
- 補間と投影は GPU で行う

つまり、実データになっても「CPU 側でやることが増える」のではなく、「CPU の入力生成が mock から real data に変わるだけ」という形に寄せるのが理想です。

## 8. 緯度経度データセットを GPU に渡す方法

ここが今後もっとも重要になります。

### 推奨の流れ

1. 外部データを受信する
2. 必要な項目だけ抽出する
3. `Float32Array` または `Uint32Array` に詰める
4. それを `StorageBufferAttribute` に載せる
5. compute pass で読む

### CPU 側で保持したい形

実データを受け取った直後は JSON でもかまいませんが、長くそのまま持たない方がよいです。

例えば入力がこうだとします。

```js
const rows = [
  {
    id: 'ship-001',
    lon: 139.76,
    lat: 35.61,
    timestamp: 1710000060,
    speed: 14.2,
    heading: 93,
    type: 'vessel',
  },
]
```

これを描画直前までオブジェクトで持ち続けるのではなく、早い段階で buffer 化します。

```js
const rawObservationBuffer = new Float32Array(entityCount * OBSERVATION_STRIDE)
```

そして 1 レコードずつ決められた offset に詰めます。

```js
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lon] = row.lon
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lat] = row.lat
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.timestamp] = row.timestamp
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLon] = prevRow.lon
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLat] = prevRow.lat
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevTimestamp] = prevRow.timestamp
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.speed] = row.speed
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.heading] = row.heading
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.type] = typeCode
rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.status] = statusCode
```

ここで大事なのは、CPU が「投影後座標」を入れるのではなく、「生の地理座標」を入れることです。

## 9. 実データに切り替えるときに必要な最小項目

最低限、次の情報があると GPU 補間に移行しやすいです。

- `lon`
- `lat`
- `timestamp`
- `prevLon`
- `prevLat`
- `prevTimestamp`

高度や見た目制御もしたいなら、さらに次を持たせます。

- `alt`
- `prevAlt`
- `speed`
- `heading`
- `type`
- `status`

## 10. prev/current 形式にする理由

GPU 補間を使いたいなら、単一時点だけでは足りません。

例えば次の 2 点が必要です。

- 前回観測
- 現在観測

その 2 点と時刻を持っていれば、GPU は次のように補間できます。

- `blend = (playbackTime - prevTimestamp) / (timestamp - prevTimestamp)`
- `lon = mix(prevLon, lon, blend)`
- `lat = mix(prevLat, lat, blend)`

つまり、CPU が毎フレーム「この船はいまここ」と計算しなくても、GPU が再生時刻に応じて位置を出せます。

## 11. 実運用データでの CPU 側パッキング戦略

実データでは、ソースから受け取る形式がまちまちです。ですが GPU へ渡す前の形は固定した方がよいです。

おすすめは、CPU 側で次の 2 段階に分けることです。

### 段階 1: 受信と正規化

- API やファイルからデータを読む
- 項目名の違いを吸収する
- 座標や時刻の欠損を弾く
- 型を数値へそろえる

### 段階 2: packed buffer 化

- エンティティ数を確定する
- `Float32Array` を必要サイズで 1 回確保する
- offset に従って連続書き込みする

この構造にすると、データソースが変わっても GPU 側の pass はほぼ変えずに済みます。

## 12. どのデータを Float32Array に入れるべきか

原則として、compute shader で大量に読む数値は typed array 化します。

`Float32Array` に向くもの:

- `lon`
- `lat`
- `alt`
- `timestamp`
- `speed`
- `heading`

数値コード化して `Float32Array` に入れてもよいもの:

- `type`
- `status`

将来的に分離を検討してよいもの:

- `id`
- 表示名
- IMO 番号や flight number のような文字列

文字列や詳細属性は、選択 UI 用に CPU 側の辞書として別保持する方がよいです。

## 13. GPU に渡すときの実装イメージ

今の構造に沿うなら、実データ導入時の入口は `createMockObservationBuffer` の差し替えです。

いま:

- `createMockObservationBuffer(entityCount)` がランダム観測を返す

将来:

- `createObservationBufferFromDataset(rows)` が実データを返す

イメージ:

```js
export function createObservationBufferFromDataset(rows) {
  const entityCount = rows.length
  const rawObservationBuffer = new Float32Array(entityCount * OBSERVATION_STRIDE)

  for (let index = 0; index < entityCount; index += 1) {
    const row = rows[index]
    const prev = row.prev
    const baseIndex = index * OBSERVATION_STRIDE

    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lon] = row.lon
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.lat] = row.lat
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.alt] = row.alt ?? 0
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.timestamp] = row.timestamp
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLon] = prev.lon
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevLat] = prev.lat
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevAlt] = prev.alt ?? 0
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.prevTimestamp] = prev.timestamp
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.speed] = row.speed ?? 0
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.heading] = row.heading ?? 0
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.type] = encodeType(row.type)
    rawObservationBuffer[baseIndex + OBSERVATION_OFFSET.status] = encodeStatus(row.status)
  }

  return {
    entityCount,
    rawObservationBuffer,
  }
}
```

この形にしておけば、`MovingEntitiesLayer.jsx` 側では mock か real data かをあまり意識せずに扱えます。

## 14. どこまで CPU でやってよいか

CPU に残してよいもの:

- データ受信
- JSON パース
- 欠損除去
- 単位変換
- typed array へのパッキング
- UI 制御

CPU に寄せない方がよいもの:

- 毎フレームの個体補間
- 毎フレームの `lon/lat -> screen` 変換
- 毎フレームのトレイル更新
- ベクトル場粒子の移流

ここを曖昧にすると、件数が増えたときにすぐ CPU ボトルネックへ戻ります。

## 15. 実データ対応で気をつけること

### 時刻の単位をそろえる

`timestamp` と `prevTimestamp` は、同じ単位で入れる必要があります。

例えば次は避けるべきです。

- `timestamp` は秒
- `prevTimestamp` はミリ秒

単位が混ざると補間率が壊れます。

### 欠損値を放置しない

次のような値は CPU 側で弾くか補正した方が安全です。

- `NaN`
- `undefined`
- 緯度が `-90..90` の範囲外
- 経度が `-180..180` の範囲外

### ID と表示情報を同じバッファに詰め込みすぎない

GPU は文字列を扱う場所ではありません。

例えば次は分けた方がよいです。

- GPU バッファ: 位置、時刻、速度、種別コード
- CPU 側辞書: ラベル、詳細情報、選択 UI 用メタデータ

## 16. 将来の拡張ポイント

このアーキテクチャは次の拡張に向いています。

### GPU トレイル

各移動体に固定長の履歴スロットを持たせ、位置更新のたびにリングバッファへ書き込みます。

必要になるもの:

- trail 用 storage buffer
- trail write index
- age ベースのフェード

### ベクトル場粒子

風や海流のグリッドを別バッファまたは texture として GPU に渡し、粒子位置からサンプリングします。

必要になるもの:

- flow field の格子データ
- 粒子の寿命
- リスポーン処理

### 集約表示

ズームアウト時に個体描画を減らし、密度グリッドやセル集約へ切り替えます。

必要になるもの:

- aggregation pass
- cell index 計算
- 集約結果の描画レイヤー

## 17. 入門者向けの最初の拡張手順

もし最初に「実データ対応」をやるなら、次の順で進めるのが安全です。

1. `mockObservations.js` と同じ出力形式の `createObservationBufferFromDataset.js` を作る
2. 小さな固定データセット 100 件程度で表示確認する
3. `prev/current` と `timestamp` の整合を確認する
4. mock と real data を切り替える props または loader を入れる
5. 件数を増やして性能を確認する

この順序なら、GPU 側の pass を壊さずに実データ導入を進められます。

## 18. このプロジェクトで覚えておくべき一文

この基盤では、

`CPU はデータを整えて渡す、GPU は大量件数を計算して描画へつなぐ`

という責務分離を最後まで崩さないことが重要です。

実データ対応でも、やるべきことは「CPU に計算を戻す」ことではなく、「GPU が読みやすい形でデータを渡す」ことです。
