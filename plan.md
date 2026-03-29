# GPU First GIS 可視化計画

## 前提

このプロジェクトの目的は、CPU で十分に処理できる可視化を作ることではない。目的は、CPU が主役では成立しにくい規模と表現を、WebGPU compute を中心に成立させることにある。

したがって、GIS 的な拡張も以下の思想で進める。

- CPU はデータ受信、最小限のパッキング、UI 制御に限定する
- GPU は座標変換、状態更新、補間、粒子移流、トレイル生成、描画属性更新を担う
- 「GeoJSON を CPU で描く地図アプリ」には寄せない
- 「地理空間データを GPU 上で処理する可視化基盤」として再設計する

## ゴール

この計画で狙うゴールは以下。

- 緯度経度を持つ大量移動体を GPU 上で投影・更新・描画できる
- 船舶や航空機のトレイルを GPU 上で保持・更新できる
- 風や海流などのベクトル場を高密度粒子で可視化できる
- ズームレベルや表示モードに応じて個体表示と集約表示を切り替えられる
- 将来的に毎秒 10 万から 100 万件規模の入力へ伸ばせる構造にする

## 現状の評価

現状実装の価値:

- `src/compute/runBarsCompute.js` に WebGPU compute の最小基盤がある
- `InstancedMesh` と `MeshBasicNodeMaterial` による GPU 主体描画の土台がある
- `Scene.jsx` で compute 更新とレンダリングの接続が既にできている

現状実装の限界:

- 入力が「正方グリッドの匿名粒子」固定
- 緯度経度や時刻を持つデータモデルがない
- compute がランダムウォーク専用
- 移動体、トレイル、ベクトル場、LOD の概念がない
- GPU 上での投影や集約を前提にしたバッファ構造になっていない

## 基本設計

このプロジェクトでは、表示を以下の 4 層に分ける。

1. 生データ層
2. GPU 状態更新層
3. 描画層
4. 集約・LOD 層

重要なのは、地理データを CPU のオブジェクト配列として長く保持しないこと。生データは可能な限り早く packed buffer 化し、GPU の storage buffer または texture に載せる。

## データフロー

理想的なデータフローは以下。

1. CPU が移動体データやベクトル場データを受信する
2. CPU は最小限の整形だけして typed array に詰める
3. GPU に `raw geospatial buffer` を転送する
4. compute で `lon/lat -> projected world position` を実行する
5. compute で速度、向き、補間状態、寿命、トレイル位置を更新する
6. 描画は GPU バッファを直接参照して行う
7. 低ズームでは別 compute で集約し、個体ではなく密度やセル単位で描画する

## CPU と GPU の責務

### CPU がやること

- データソースからの受信
- 最低限のパッキング
- ストリームのバッファリング
- レイヤーの ON/OFF
- 表示モードの切り替え
- ズームや時刻操作などの UI

### GPU がやること

- 緯度経度から描画座標への投影
- 現在位置と目標位置の補間
- 速度と向きの更新
- トレイル頂点の更新
- 風や海流の流線粒子の移流
- 速度や属性に応じた色・サイズ・不透明度の更新
- 可視領域抽出やセル集約の下準備

## 緯度経度の扱い

このプロジェクトでは、緯度経度の座標変換も GPU 処理対象とする。

理由:

- 毎秒 10 万から 100 万件規模では、CPU 投影を常態化させる設計に意味が薄い
- 投影と状態更新を同じ compute パス群に置くと責務が明確になる
- GPU 上でズーム、中心移動、投影パラメータ変更に追従しやすい

想定する流れ:

- `lon`, `lat`, `alt`, `timestamp` を packed buffer で保持
- 投影用 uniform として `centerLon`, `centerLat`, `scale`, `projectionType` を渡す
- compute で `worldX`, `worldY`, `worldZ` を生成

初期段階では投影法は単純化してよい。

- Phase 1: equirectangular または局所平面近似
- Phase 2: 必要なら Web Mercator

重要なのは、投影法の正確さよりも、GPU 上で一貫して扱えること。

## レイヤー構成

### 1. Base Map Layer

GeoJSON は背景として使うが、主役ではない。GeoJSON 自体のパースは CPU でもよいが、描画用頂点は最終的に GPU へ載せる。

役割:

- 海岸線
- 行政界
- 航路、空路
- 港湾や空港の補助ライン

注意点:

- 大規模 GeoJSON を毎フレーム CPU で処理しない
- 頂点列に正規化したら GPU バッファ化して使い回す

### 2. Moving Entity Layer

船舶や航空機は GPU 上の「意味を持つインスタンス群」として扱う。

1 インスタンスあたり最低限必要な属性:

- `id`
- `lon`, `lat`, `alt`
- `prevLon`, `prevLat`, `prevAlt`
- `timestamp`
- `prevTimestamp`
- `speed`
- `heading`
- `type`
- `status`

GPU でやる処理:

- 観測点間の時間補間
- 投影
- 可視化座標更新
- 色やサイズの決定
- 向きの更新

描画:

- 点または小型 billboard
- 必要なら機種・船種ごとに別 shape
- 選択時だけ CPU 側で詳細 UI を出す

### 3. Trail Layer

トレイルは CPU でポリラインを作るのではなく、GPU リングバッファで管理する。

必要な考え方:

- 各移動体に固定長の履歴スロットを持たせる
- 現在位置更新時に最新トレイル頂点を書き込む
- 古い頂点は循環上書きする
- フェードは age ベースで shader 側計算

これにより、大量個体でも CPU 側で履歴配列をこね回さなくて済む。

### 4. Vector Field Particle Layer

風や海流は、このプロジェクトで最も GPU 価値が出る領域。

入力:

- `u/v` グリッド
- 範囲情報
- 格子解像度
- 欠損値情報

GPU でやる処理:

- 粒子位置からベクトル場をサンプリング
- 粒子移流
- 寿命更新
- リスポーン
- 速度に応じた色変更

このレイヤーは現状の `runBarsCompute.js` を置き換える主対象になる。

### 5. Aggregation Layer

100 万件級では、常に全件を個体として描画するのは非現実的。ズームアウト時は個体描画から集約描画へ落とす必要がある。

集約方式候補:

- グリッド集約
- ヒートマップ
- 密度テクスチャ
- 方向付きセルベクトル

GPU でやる理由:

- 可視領域ごとに高速に集約できる
- ズーム変更時に CPU 再集計を避けられる

## バッファ設計

この計画で重要なのは、バッファを用途別に分けること。

### 移動体向け

- `rawObservationBuffer`
  - `lon`, `lat`, `alt`, `timestamp`, `id`, `type`
- `projectedStateBuffer`
  - `worldPosition`, `velocity`, `heading`, `visibility`
- `interpolationBuffer`
  - `prevObservation`, `nextObservation`, `blendFactor`
- `styleBuffer`
  - `color`, `size`, `opacity`
- `trailBuffer`
  - 履歴点列

### 風・海流向け

- `vectorFieldBuffer` または `vectorFieldTexture`
  - `u`, `v`
- `flowParticleStateBuffer`
  - `position`, `life`, `seed`, `speed`
- `flowParticleRenderBuffer`
  - 色やサイズなど描画属性

### 集約向け

- `screenGridBuffer`
  - セル単位の件数や平均速度
- `densityTexture`
  - 低ズーム用ヒートマップ

## Compute パス設計

1 本の巨大 compute に全部詰めるのではなく、用途別に分ける。

### Pass 1: Projection Pass

責務:

- `lon/lat/alt` から `worldPosition` を生成

入力:

- `rawObservationBuffer`
- 投影用 uniform

出力:

- `projectedStateBuffer`

### Pass 2: Interpolation Pass

責務:

- 観測点間の補間
- 現在時刻に対する位置更新
- 進行方向更新

入力:

- `interpolationBuffer`
- 再生時刻 uniform

出力:

- `projectedStateBuffer`

### Pass 3: Trail Update Pass

責務:

- 現在位置をトレイルリングバッファに書き込む
- age や強度を更新する

### Pass 4: Vector Field Advection Pass

責務:

- ベクトル場に従って粒子を移流する
- 速度や寿命に応じて粒子を更新する

### Pass 5: Aggregation Pass

責務:

- ズームアウト時に個体をセルへ集約する
- 密度、平均速度、方向分布を計算する

## 実装フェーズ

### Phase 1: Compute 基盤の再構成

目的:

- 現状のランダムウォーク専用 compute を GIS 用の基盤へ置き換える

作業:

- `src/compute/runBarsCompute.js` を役割ごとに分割する
- `Projection Pass` と `Interpolation Pass` の最小構成を作る
- 緯度経度入力を受けられるストレージバッファ形式を決める

完了条件:

- ダミーの `lon/lat` 入力を GPU で投影して表示できる

### Phase 2: 大量移動体の GPU 描画

目的:

- 船舶や航空機を GPU 上で補間しながら描画する

作業:

- moving entity 用のバッファ群を追加
- instancing 描画の shader 入力を projected state に切り替える
- 速度、進行方向、種別に応じた見た目制御を追加

完了条件:

- 数万から数十万件の移動体を GPU 補間で描画できる

### Phase 3: GPU トレイル

目的:

- 個体の軌跡を CPU なしで保持し、視認性を上げる

作業:

- trail ring buffer を導入
- トレイル描画コンポーネントを追加
- フェードと強調ルールを shader で処理

完了条件:

- 大量移動体でもトレイルを滑らかに描ける

### Phase 4: ベクトル場粒子

目的:

- 風や海流を高密度パーティクルで可視化する

作業:

- vector field バッファ形式を追加
- advection compute を作る
- 描画用の flow particle layer を追加

完了条件:

- 風向と風速が粒子流として読める

### Phase 5: GPU 集約と LOD

目的:

- 100 万件級の表示に耐える

作業:

- Aggregation Pass を追加
- ズームに応じて `entity mode` と `aggregate mode` を切り替える
- ヒートマップまたはセル可視化を追加

完了条件:

- 低ズームでも可視化が破綻しない

## 推奨ファイル構成

- `src/compute/createProjectionPass.js`
- `src/compute/createInterpolationPass.js`
- `src/compute/createTrailUpdatePass.js`
- `src/compute/createVectorFieldAdvectionPass.js`
- `src/compute/createAggregationPass.js`
- `src/layers/MovingEntitiesLayer.jsx`
- `src/layers/TrailLayer.jsx`
- `src/layers/VectorFieldLayer.jsx`
- `src/layers/AggregationLayer.jsx`
- `src/layers/BaseMapLayer.jsx`
- `src/data/mockObservations.js`
- `src/data/mockVectorField.js`

## 最初のマイルストーン

最初の到達点は、地図 SDK 的な完成度ではなく、GPU でしか意味がない最小実証に置く。

- 緯度経度を持つ 10 万件以上のダミー移動体を GPU 投影で表示
- 再生時刻に応じて GPU 補間で移動
- 各移動体に短い GPU トレイルを付ける
- 風ベクトル場に従う粒子を別レイヤーで重ねる
- UI から件数、トレイル長、粒子密度、表示モードを変えられる

この段階で初めて、このプロジェクトは「WebGPU 粒子デモ」ではなく「GPU First な地理空間可視化基盤」になる。

## 実装着手順

着手順は以下を推奨する。

1. 既存の `runBarsCompute.js` を分割し、ランダムウォーク依存を外す
2. `Projection Pass` を追加して `lon/lat` 入力を GPU 投影する
3. instancing 描画を projected state buffer 参照型へ切り替える
4. `Interpolation Pass` を追加し、時刻ベース再生を成立させる
5. `Trail Update Pass` を追加して GPU トレイルを出す
6. `Vector Field Advection Pass` を追加する
7. 最後に `Aggregation Pass` を入れて大規模表示へ伸ばす

## 判断基準

実装中の判断基準は明確にする。

- CPU でやった方が楽でも、毎フレーム大量処理なら GPU に寄せる
- 逆に、初回ロード時 1 回だけの静的前処理なら CPU を許容する
- 個体、軌跡、風場、集約を同じ責務に混ぜない
- 「このプロジェクトでしか成立しない規模か」を常に基準にする

## 補足

GeoJSON は必要だが、主役ではない。主役は以下。

- 大量移動体の GPU 投影
- GPU 補間
- GPU トレイル
- ベクトル場粒子
- GPU 集約

この順序を崩すと、普通の地図可視化アプリに近づいてしまい、このリポジトリを使う意味が薄れる。
