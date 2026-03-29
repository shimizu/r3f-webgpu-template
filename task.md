# GPU First GIS 実装タスク

## 方針

このタスク一覧は [plan.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/plan.md) を実装に落とすためのもの。基準は一貫している。

- CPU は受信、最小限のパッキング、UI 制御に限定する
- GPU は投影、補間、トレイル、ベクトル場粒子、集約を担う
- 「普通の地図アプリ」を作るのではなく、「GPU でしか成立しにくい地理空間可視化基盤」を作る

## マイルストーン

### M1: GPU 投影で大量移動体を表示する

成功条件:

- `lon/lat` を持つ 10 万件以上のダミー移動体を GPU で投影して表示できる
- 既存の正方グリッド粒子ではなく、地理座標由来の位置で描画される

### M2: GPU 補間で移動を再生する

成功条件:

- `prev` と `next` の観測点を GPU で補間して動かせる
- 再生時刻を変えると全体の移動が追従する

### M3: GPU トレイルを付与する

成功条件:

- 各移動体に短い軌跡を表示できる
- CPU で履歴ポリラインを生成していない

### M4: ベクトル場粒子を重ねる

成功条件:

- 風または海流のダミー場に従って粒子が流れる
- 移動体レイヤーと同じ地図空間で重ねて表示できる

### M5: 集約表示へ落とせる

成功条件:

- 低ズーム時に個体描画から集約表示へ切り替えられる
- 100 万件級を見据えた構造になっている

## 実装タスク

## 0. 現状の compute 基盤を分割する

優先度: P0

作業:

- `src/compute/runBarsCompute.js` の責務を洗い出す
- GIS 用に再利用できる部分と捨てる部分を分ける
- compute パスを単機能ファイルへ分割する

追加候補ファイル:

- `src/compute/createProjectionPass.js`
- `src/compute/createInterpolationPass.js`
- `src/compute/createTrailUpdatePass.js`
- `src/compute/createVectorFieldAdvectionPass.js`
- `src/compute/createAggregationPass.js`

完了条件:

- ランダムウォーク専用ロジックが今後の実装ブロッカーにならない
- Projection Pass を追加できる構造になっている

## 1. 生データバッファ仕様を決める

優先度: P0

作業:

- 移動体データの packed layout を決める
- 1 レコードの stride を明文化する
- `Float32Array` と `Uint32Array` の責務を分ける
- `id`, `type`, `status` をどう持つか決める

決めるべき項目:

- `lon`, `lat`, `alt`
- `prevLon`, `prevLat`, `prevAlt`
- `timestamp`, `prevTimestamp`
- `speed`, `heading`
- `type`, `status`, `id`

成果物:

- `docs` か `reference` にバッファ仕様メモ
- 実装用のモック生成関数

完了条件:

- CPU から GPU へ渡す構造が固定できる
- Projection Pass と Interpolation Pass が同じ前提で作れる

## 2. Projection Pass を実装する

優先度: P0

作業:

- `lon/lat` を GPU 上でラジアン化する
- `rotateLambda` 相当を GPU で実装する
- 初期投影として `equirectangularRaw` を入れる
- 続いて `mercatorRawSafe` を実装できる形にする
- `u/v` を `worldX/worldZ` に変換する

参照:

- [reference/projection.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/reference/projection.md)

注意:

- `toScreen` をそのまま持ち込まない
- 2D pixel 空間ではなく 3D scene 座標へ落とす
- Mercator では `phi` clamp を必ず入れる

完了条件:

- ダミーの `lon/lat` 点群が GPU 投影で地図上に並ぶ
- カメラを動かしても位置関係が破綻しない

## 3. 描画パスを projected state 参照型に変更する

優先度: P0

作業:

- `Scene.jsx` の表示ロジックを見直す
- 既存の `particleSeed` 前提をやめる
- `InstancedMesh` が `projectedStateBuffer` を読むようにする
- 色、サイズ、向きを style/state buffer から参照できるようにする

対象:

- `src/Scene.jsx`
- 新しい layer component

追加候補ファイル:

- `src/layers/MovingEntitiesLayer.jsx`

完了条件:

- 既存のランダム粒子ではなく、投影済み移動体が描画される
- 今後の補間やトレイルを載せられる描画構造になる

## 4. ダミー移動体データ生成を追加する

優先度: P0

作業:

- 東京湾や首都圏空域のような限定領域を想定したダミーデータを作る
- `prev` と `next` の観測点を持つ形式にする
- 最低 10 万件を生成できるようにする
- 件数切り替え UI を用意する

追加候補ファイル:

- `src/data/mockObservations.js`

完了条件:

- Projection Pass と描画パスの負荷確認ができる
- 小規模と大規模の差を比較できる

## 5. Interpolation Pass を実装する

優先度: P1

作業:

- `prevTimestamp` と `timestamp` の間で blend factor を計算する
- GPU 上で位置を補間する
- heading と速度の更新方針を決める
- 再生時刻 uniform を導入する

完了条件:

- 再生時刻の変更で全移動体が滑らかに動く
- CPU で個体ごとの補間処理をしていない

## 6. Base Map Layer を最小構成で入れる

優先度: P1

作業:

- GeoJSON のパース処理を追加する
- 画面ごとに再計算せず、頂点列を GPU バッファ化する
- 海岸線か行政界を最低 1 レイヤー表示する

追加候補ファイル:

- `src/layers/BaseMapLayer.jsx`
- `src/data/mockTokyoBayGeo.json`

完了条件:

- 移動体がどこを動いているか文脈が分かる
- 地図レイヤーが移動体レイヤーの座標系と一致する

## 7. GPU トレイルを実装する

優先度: P1

作業:

- 固定長の trail ring buffer を設計する
- Trail Update Pass を作る
- トレイル描画コンポーネントを追加する
- age ベースのフェードを shader 側で行う

追加候補ファイル:

- `src/layers/TrailLayer.jsx`

完了条件:

- 各移動体に短い軌跡が付く
- CPU で polyline 更新をしていない

## 8. ベクトル場データ仕様を決める

優先度: P1

作業:

- `u/v` 格子のデータ構造を決める
- `buffer` と `texture` のどちらを使うか決める
- 座標範囲、解像度、欠損値の扱いを決める

成果物:

- ベクトル場の仕様メモ
- モックデータ生成関数

完了条件:

- flow particle の compute 実装に必要な入力形式が固まる

## 9. Vector Field Advection Pass を実装する

優先度: P1

作業:

- 粒子位置からベクトル場をサンプリングする
- 粒子の移流、寿命、再生成を GPU で更新する
- 速度に応じて色を変える
- 粒子密度の調整 UI を入れる

追加候補ファイル:

- `src/layers/VectorFieldLayer.jsx`
- `src/data/mockVectorField.js`

完了条件:

- 風または海流が粒子流として視認できる
- 移動体レイヤーと重ねても座標系が崩れない

## 10. 集約と LOD の最小実装を入れる

優先度: P2

作業:

- ズーム値か画面密度に応じた表示モード判定を作る
- 個体描画と集約描画を切り替える
- 集約セルバッファを GPU で更新する

追加候補ファイル:

- `src/layers/AggregationLayer.jsx`

完了条件:

- 低ズーム時に個体表示が過密で破綻しない
- 100 万件級を見据えた入り口ができる

## 11. デバッグ HUD を強化する

優先度: P1

作業:

- 現在件数
- FPS
- 投影方式
- 補間の再生時刻
- トレイル長
- 粒子数
- 表示モード

を確認できる UI を追加する

対象:

- `src/App.jsx`
- `src/Scene.jsx`
- `src/App.css`

完了条件:

- GPU 実装のボトルネックを目視で追える
- モード切り替えが検証しやすい

## 12. パフォーマンス検証タスクを入れる

優先度: P1

作業:

- 10 万件、50 万件、100 万件の段階で描画確認
- Projection Pass 単体の負荷確認
- Interpolation と Trail を重ねたときの変化確認
- ベクトル場粒子と併用時の変化確認

完了条件:

- どこから破綻するかを定量的に把握できる
- 次に最適化すべき箇所が明確になる

## 実装順

推奨順序:

1. compute 基盤分割
2. 生データバッファ仕様策定
3. Projection Pass
4. projected state 参照描画
5. ダミー移動体データ
6. Interpolation Pass
7. Base Map Layer
8. Trail Update Pass
9. Vector Field Advection Pass
10. Aggregation Layer
11. デバッグ HUD
12. パフォーマンス検証

## 今すぐ着手するタスク

最初に着手するべき具体作業は以下。

- `src/compute/runBarsCompute.js` の責務分離方針を決める
- `rawObservationBuffer` のレイアウトを決める
- `createProjectionPass.js` を作る
- `MovingEntitiesLayer.jsx` の最小描画を作る
- 10 万件のダミー移動体を表示する

## 完了の定義

このタスク群の第一段階完了は、単に GeoJSON が出ることではない。以下を満たした時点を第一段階の完了とする。

- 緯度経度ベースの大量移動体が GPU 投影で表示される
- GPU 補間で動く
- GPU トレイルが出る
- ベクトル場粒子を重ねられる
- CPU が個体ごとの毎フレーム処理をしていない
