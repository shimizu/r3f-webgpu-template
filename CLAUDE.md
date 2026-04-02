# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

React Three Fiber + WebGPU による GPU ファーストの GIS 可視化テンプレート。大量の地理エンティティ（船舶・航空機）をリアルタイムに GPU 上で補間・投影し描画する。

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

### ソースコード構成

- `src/App.jsx` — Canvas シェル、エンティティ数 UI、WebGPU レンダラー初期化
- `src/Scene.jsx` — 3D シーン構成、HUD、レイヤー合成
- `src/layers/` — レイヤーコンポーネント（BaseMapLayer: GeoJSON地図、MovingEntitiesLayer: GPU移動体）
- `src/compute/` — GPU コンピュートパス（projection / interpolation）
- `src/gis/` — 投影ヘルパー、ビュー定義
- `src/data/` — モックデータ生成

### 観測データレイアウト

`observationLayout.js` で定義。OBSERVATION_STRIDE = 12 floats/エンティティ:
lon, lat, alt, timestamp, prevLon, prevLat, prevAlt, prevTimestamp, speed, heading, type, status

### 投影方式

- CPU側: `projectLonLatToWorld([lon, lat], view)` — 等距円筒図法
- GPU側: compute shader 内で同等の投影 + 日付変更線ラッピング

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
- `AGENTS.md` — リポジトリガイドライン（コミット規約、PR要件等）

## 言語

開発者は日本人。応答・レビュー・進捗報告は日本語で行う。コード・ファイル名・コマンド・API識別子は英語のまま。
