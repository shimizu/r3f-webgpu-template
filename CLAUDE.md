# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

React Three Fiber + WebGPU による GPU ファーストの GIS 可視化テンプレート。大量の地理エンティティ（船舶・航空機）をリアルタイムに GPU 上で補間・投影し描画する。現在はジオラマ風ステージ上にマテリアルサンプル・水面シミュレーション・パーティクルシステムを配置した lookdev 環境として機能している。

## 開発コマンド

```bash
npm install          # 依存パッケージのインストール（lockfile使用）
npm run dev          # Vite開発サーバー起動
npm run build        # 本番ビルド（dist/）
npm run preview      # ビルド済みアプリの確認
npm run lint         # ESLintチェック（PR前に必須）
```

自動テストは未構成。品質ゲートは lint + 手動確認 + build成功。

## アーキテクチャ

### データフロー: CPU → GPU → 描画

```
CPU(受信・パック) → GPU(投影・補間) → Draw(インスタンス描画)
```

- **CPU**: 観測データを TypedArray にパックするのみ。per-frame の個別エンティティ更新は行わない
- **GPU**: TSL (Three.js Shader Language) compute shader で投影・補間を実行
- **描画**: InstancedMesh + ビルボードクアッドでレンダリング

### シーン構成

`App.jsx` → `Scene.jsx` → 各レイヤー の階層構造:

- `App.jsx` — Canvas シェル、WebGPU レンダラー初期化
- `Scene.jsx` — シーン合成の入口。背景色、カメラ操作（MapControls）、ライティング、レイヤー群を組み立てる
- `StudioEnvironment.jsx` — RoomEnvironment による IBL（PMREM 生成）。PBR マテリアルの環境反射に使用
- `LightingRig.jsx` — ambient / hemisphere / directional（シャドウ付き）/ spot のスタジオ照明セット

### レイヤー構成（`src/layers/`）

レイヤーは独立した React コンポーネントとして実装し、Scene.jsx で合成する:

- `StageLayer` — チェッカーボード床。InstancedMesh + 頂点カラーで 16×10 タイルを描画。meshPhysicalMaterial（clearcoat）
- `ExtrudedGridLayer` — マテリアルサンプル球体5種（Matte / Semi Gloss / Metal / Mirror / Glass）と水面ボックスを配置。Mirror は CubeCamera でリアルタイム反射
- `WaterBoxLayer` — TSL による水面シミュレーション。MeshPhysicalNodeMaterial + Perlin noise + sin 波で波高・フレネル反射・深度カラーをGPU計算
- `GeojsonLayer` — GeoJSON 地図描画
- `MovingEntitiesLayer` — GPU 移動体（船舶・航空機）の描画
- `stageDimensions.js` — FLOOR_COLUMNS, FLOOR_ROWS, TILE_SIZE 等の共有定数

### マテリアルベースライン

ExtrudedGridLayer の5つのマテリアルサンプルが lookdev の基準:

左から `Matte` → `Semi Gloss` → `Metal` → `Mirror` → `Glass`

マテリアル調整の指示（「もっとマット」「ガラスっぽく」等）は、これら5プリセットからの相対調整を優先する。新規マテリアルをゼロから作るより、最も近いプリセットから調整すること。

### GPU コンピュート（`src/compute/`）

- `runBarsCompute.js` — パーティクルシステム。StorageBufferAttribute で位置・速度・寿命を管理し、TSL compute node で毎フレーム GPU 更新（バウンス、ジッター、リスポーン）
- `createProjectionPass.js` / `createInterpolationPass.js` — GIS エンティティの投影・補間コンピュートパス
- `observationLayout.js` — 観測データレイアウト定義。OBSERVATION_STRIDE = 12 floats/エンティティ: lon, lat, alt, timestamp, prevLon, prevLat, prevAlt, prevTimestamp, speed, heading, type, status

### 投影方式

- CPU側: `projectLonLatToWorld([lon, lat], view)` — 等距円筒図法
- GPU側: compute shader 内で同等の投影 + 日付変更線ラッピング

### TSL パターン

このプロジェクトでは Three.js Shader Language (TSL) を多用する。典型的なパターン:

- `MeshPhysicalNodeMaterial` に対して `positionNode`, `colorNode`, `normalNode` 等をノードグラフで構築
- `mx_noise_float` 等のビルトインノイズ関数で手続き的テクスチャ生成
- `uniform()` でCPU↔GPU間のパラメータ連携
- compute shader は `Fn()` + `compute()` で定義し、`renderer.computeAsync()` で実行

## コーディングスタイル

- 2スペースインデント、シングルクォート
- React コンポーネント: PascalCase
- 変数・ヘルパー: camelCase
- ESLint設定で Three.js 固有プロパティ（args, attach, intensity, material, position）を許可済み

## セッションフック

作業開始前に必ず `working-memory.md` を読むこと。作業終了時には同ファイルの内容が現状と一致しているか確認し、ドリフトがあれば更新すること。

## 参考ドキュメント

- `docs/gpu-gis-particle-architecture.md` — GPU-GIS アーキテクチャ詳細ガイド（18セクション）
- `docs/webgpu-particles-tutorial.md` — WebGPU パーティクル入門チュートリアル
- `docs/r3f-computeshader_llm.md` — R3F + ComputeShader の実装リファレンス
- `AGENTS.md` — リポジトリガイドライン（コミット規約、PR要件等）

## 言語

開発者は日本人。応答・レビュー・進捗報告は日本語で行う。コード・ファイル名・コマンド・API識別子は英語のまま。
