# SkyLayer

室内・卓上トーンの空ドームを描く背景レイヤー。

## 概要

シーンを内側から包む大きな球（BackSide）の内面に、静的なグラデーションと fBM ノイズによる控えめな雲を GPU（TSL）で描画する。大気散乱モデルではなく、天井のベージュ・壁面・床のブラウンといった「室内／卓上」トーンで箱庭ステージの背景を作る。雲はほぼ動かず（speed=0.005）、天井のムラ程度の質感。lookdev の背景として常時マウントして使う。

## 前提・依存

- 配置前提: なし（`<Coordinate>` 配下でなくてよい）
- 連携: `material.fog = false` なので HeightFogLayer 等のシーンフォグの影響を受けない。`depthWrite: false` で常に最背面に描かれる

## Props

| prop | 型 | 既定値 | 説明 |
|------|-----|--------|------|
| radius | number | 200 | 空ドーム球の半径。カメラの可動範囲（MapControls maxDistance 等）を十分に包む大きさにする |

雲色・グラデーション色・雲量などはモジュール内定数（`SKY_COLORS` / `CLOUD` / `DOME`）で定義されており props では変更できない。調整時はソースの定数を編集する。

## 使用例

```jsx
import SkyLayer from './layers/SkyLayer'

// 既定（radius=200）で背景として配置
<SkyLayer />

// ドームを大きくする場合
<SkyLayer radius={300} />
```

## 調整のポイント

- 空の色味は `SKY_COLORS`（zenith / horizon / ground）、雲は `CLOUD`（coverage / sharpness / brightness / color 等）をソース側で調整する
- 雲は地平線より上のみ・天頂付近は薄く表示されるよう altitude マスクがかかっている
- BackSide 球なので `normalLocal.y` がそのまま高度（-1 真下 〜 +1 真上）として使われる
- material は `useMemo` で 1 度だけ生成し、アンマウント時に `dispose()` される

## 関連

- ソース: `src/layers/SkyLayer.jsx`
- 関連: 体積雲は別レイヤー `CloudLayer`。シーンフォグは `HeightFogLayer`
