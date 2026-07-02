# GPU First GIS 実装タスク

## 方針

このタスク一覧は [plan.md](/home/shimizu/_playground/three-fiber/r3f-webgpu-template/plan.md) を実装に落とすためのもの。基準は一貫している。

- CPU は受信、最小限のパッキング、UI 制御に限定する
- GPU は投影、補間、トレイル、ベクトル場粒子を担う
- 「普通の地図アプリ」を作るのではなく、「GPU でしか成立しにくい地理空間可視化基盤」を作る

## 達成済み・対象外

- **M1（GPU 投影で大量移動体を表示）/ M2（GPU 補間で移動を再生）は達成済み**（`createInterpolationPass.js` + `MovingEntitiesLayer.jsx` + `mockObservations.js`、件数は leva で実行時調整可）。旧タスク 0〜6（compute 基盤分割、バッファ仕様 = `observationLayout.js`、Projection Pass、projected state 参照描画、ダミーデータ、Interpolation Pass、Base Map Layer = `GeojsonLayer.jsx`）も完了のため削除
- **旧 M5（集約 / LOD 表示）は plan.md の方針転換で対象外**となったため削除

## マイルストーン

### M3: GPU トレイルを付与する

成功条件:

- 各移動体に短い軌跡を表示できる
- CPU で履歴ポリラインを生成していない

### M4: ベクトル場粒子を重ねる

成功条件:

- 風または海流のダミー場に従って粒子が流れる
- 移動体レイヤーと同じ地図空間で重ねて表示できる

## 実装タスク

## 0. 補間パスの既知バグを解消する（前提タスク）

優先度: P0

トレイルは補間パスの出力を土台にするため、着手前に review.md の High タスクを潰す。

作業:

- 日付変更線をまたぐ lon 補間の修正（H2）
- timestamp 機構の恒等式化・0 除算の修正（H2）
- compute 系 `destroy()` の StorageBufferAttribute 解放（H1）

完了条件:

- antimeridian をまたぐ移動体が正しい方向に動く
- レイヤーのマウント/アンマウント繰り返しで GPU メモリが増え続けない

## 1. GPU トレイルを実装する

優先度: P1

作業:

- 固定長の trail ring buffer を設計する
- Trail Update Pass を作る（`src/compute/createTrailUpdatePass.js`）
- トレイル描画コンポーネントを追加する（`src/layers/TrailLayer.jsx`）
- age ベースのフェードを shader 側で行う

完了条件:

- 各移動体に短い軌跡が付く
- CPU で polyline 更新をしていない

## 2. ベクトル場データ仕様を決める

優先度: P1

作業:

- `u/v` 格子のデータ構造を決める
- `buffer` と `texture` のどちらを使うか決める
- 座標範囲、解像度、欠損値の扱いを決める

成果物:

- ベクトル場の仕様メモ
- モックデータ生成関数（`src/data/mockVectorField.js`）

完了条件:

- flow particle の compute 実装に必要な入力形式が固まる

## 3. Vector Field Advection Pass を実装する

優先度: P1

作業:

- 粒子位置からベクトル場をサンプリングする
- 粒子の移流、寿命、再生成を GPU で更新する（`src/compute/createFlowAdvectionPass.js`）
- 速度に応じて色を変える
- 粒子密度の調整 UI を入れる（`src/layers/FlowFieldLayer.jsx`）

完了条件:

- 風または海流が粒子流として視認できる
- 移動体レイヤーと重ねても座標系が崩れない

## 4. デバッグ HUD を強化する

優先度: P1

FPS は `FpsStats.jsx`（stats-gl）で表示済み。残りの項目を確認できる UI を追加する。

- 現在件数
- 投影方式
- 補間の再生時刻
- トレイル長
- 粒子数

対象:

- `src/App.jsx`
- `src/Scene.jsx`

完了条件:

- GPU 実装のボトルネックを目視で追える
- モード切り替えが検証しやすい

## 5. パフォーマンス検証タスクを入れる

優先度: P1

作業:

- 10 万件、50 万件、100 万件の段階で描画確認
- Interpolation Pass 単体の負荷確認
- Interpolation と Trail を重ねたときの変化確認
- ベクトル場粒子と併用時の変化確認

完了条件:

- どこから破綻するかを定量的に把握できる
- 次に最適化すべき箇所が明確になる

## 実装順

推奨順序:

1. 補間パスのバグ解消（review.md H1 / H2）
2. Trail Update Pass + TrailLayer
3. ベクトル場データ仕様策定
4. Vector Field Advection Pass + FlowFieldLayer
5. デバッグ HUD
6. パフォーマンス検証

## 完了の定義

第一段階完了の条件のうち、「GPU 投影で表示」「GPU 補間で動く」「CPU が個体ごとの毎フレーム処理をしていない」は達成済み。残条件は以下。

- GPU トレイルが出る
- ベクトル場粒子を重ねられる
