# LightningLayer

ポアソン過程で落雷する稲妻レイヤー。ボルト・フラッシュライト・雲内発光を同期駆動。

## 概要

低頻度の落雷を CPU で生成する稲妻レイヤー。主幹はミッドポイント変位（再帰分割 + 横ずれ）のジグザグで作り、途中から確率で枝ボルトを生やす。ジオメトリは view 向きに vertex で billboard するリボンで、加算ブレンド + 白飛びコアにより postfx（Bloom）なしでも自立して見える。落雷は 3 段エンベロープ（リーダー伸長 → 本閃光 → 残光減衰）で明滅し、落雷点は `heightInfo` から標高の高い候補を選ぶ（稜線に落ちやすい）。落雷頻度 `rate`（回/分）が 0 のときは完全 idle。

## 前提・依存

- 配置前提: `HeightFieldProvider` 配下（`useHeightField()` の `heightInfo` から落雷点を抽選）。`heightInfo` が無い間は落雷しない
- 連携: フラッシュは 2 系統を同じエンベロープで駆動する — (1) 落雷点のポイントライト（地形を照らす、シャドウなし・減衰あり）、(2) `flashUniform`（Scene 経由で CloudLayer の雲内発光に接続）

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| `position` | `[x,y,z]` | `[0, 0, 0]` | レイヤーの配置位置 |
| `rate` | `number` | `0` | 落雷頻度（回/分）。0 で完全 idle |
| `topY` | `number` | `4.5` | ボルト始点の高さ（雲底、レイヤーローカル） |
| `flashUniform` | `uniform \| null` | `null` | CloudLayer の雲内発光と共有する uniform ノード。安定参照で渡すこと |

## 使用例

Scene.jsx では `heightInfo` が揃ってからマウントし、`topY` を雲高さに合わせ、`flashUniform` に `useMemo` で生成した安定参照 uniform を渡している。

```jsx
// Scene 上部で一度だけ生成（安定参照必須。CloudLayer のシェーダ再構築を避ける）
const lightningFlash = useMemo(() => uniform(0), [])

{heightInfo && (
  <LightningLayer
    position={[0, 0.5, 0]}
    rate={inputs.lightningRate}      // 天候フォルダ「雷（回/分）」由来
    topY={region.cloudHeight - 1.2}  // 雲底に始点を合わせる
    flashUniform={lightningFlash}    // 同じ uniform を CloudLayer にも渡す
  />
)}

// CloudLayer 側
<CloudLayer ... flashNode={lightningFlash} />
```

## 調整のポイント

- 落雷頻度は `rate`（回/分）で調整。0 なら idle でコストほぼゼロ
- `flashUniform` は必ず安定参照（`useMemo`）で渡すこと。毎レンダー新規参照だと CloudLayer のシェーダが再構築される
- 雲内発光を連動させたい場合は、LightningLayer の `flashUniform` と CloudLayer の `flashNode` に同一 uniform を渡す
- ボルト形状（再帰深さ・変位量・幅・枝数）やエンベロープ（各段の時間・時定数）、ライト強度・色はファイル冒頭の `BOLT` / `ENVELOPE` 定数で固定（props ではない）
- ボルトは CPU 生成（毎フレーム compute しない）。落雷点候補数は `HIGH_GROUND_CANDIDATES` で調整

## 関連

- ソース: `src/layers/LightningLayer.jsx`
- 依存: `src/gis/HeightFieldContext.jsx`、`src/tsl/sampleHeightField.js`（`cpuHeightAt`）
- 関連: `CloudLayer`（`flashNode` で雲内発光を共有）
