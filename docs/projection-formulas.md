# Projection Formulas (d3-geo-projection)

このドキュメントでは、`reference/d3-geo-projection/` から抽出した主要な地図投影法の前方投影（経緯度から平面座標への変換）の数式をまとめています。これらの数式は、WebGPU (TSL) での投影パス実装に利用できます。

> [!NOTE]
> すべての式において、`λ` (lambda) は経度（中心経度からの相対値）、`φ` (phi) は緯度を表し、単位は **ラジアン** です。

---

## 1. Sinusoidal (正弦曲線図法)
もっとも単純な等積図法の一つ。経線が正弦曲線となる。

**Formula:**
```js
x = λ * cos(φ)
y = φ
```

---

## 2. Mollweide (モルワイデ図法)
世界地図によく使われる等積図法。

**Formula:**
まず、中間変数 `θ` (theta) を収束計算（ニュートン法）で求める。
`π * sin(φ) = 2θ + sin(2θ)`

TSL での実装例（簡易版/反復 10回程度）:
```js
// θ の初期値として φ を使用
let theta = phi;
for (let i = 0; i < 10; i++) {
  let delta = (theta + sin(theta) - PI * sin(phi)) / (1.0 + cos(theta));
  theta -= delta;
}
theta /= 2.0;

x = (sqrt(8) / PI) * λ * cos(theta)
y = sqrt(2) * sin(theta)
```

---

## 3. Robinson (ロビンソン図法)
面積も角度も正確ではないが、世界地図としてのバランスが良い妥協図法。

**Formula:**
緯度 `φ` に応じた係数テーブル（5度刻み）を補間して求める。

```js
// K 表 (の一部)
// [x_scale, y_scale]
const K = [
  [1.0000, 0.0000], // 0 deg
  [0.9986, 0.0620], // 5 deg
  [0.9954, 0.1240], // 10 deg
  // ... (詳細は src/robinson.js 参照)
];

// φ(rad) をインデックスに変換
i = abs(phi) * 180 / PI / 5;
i0 = floor(i);
di = i - i0;

// 線形または二次補間
x = λ * interpolate(K[i0].x, K[i1].x, K[i2].x, di)
y = sign(phi) * interpolate(K[i0].y, K[i1].y, K[i2].y, di) * 1.59341579
```

---

## 4. Natural Earth (ナチュラル・アース図法)
ロビンソン図法に似た、見た目の良さを重視した図法。多項式で近似されるため、TSL との相性が非常に良い。

**Formula:**
```js
phi2 = φ * φ;
phi4 = phi2 * phi2;
phi6 = phi2 * phi4;

x = λ * (0.84719 - 0.13063 * phi2 + phi6 * phi6 * (-0.04515 + 0.05494 * phi2 - 0.02326 * phi4 + 0.00331 * phi6))
y = φ * (1.01183 + phi4 * phi4 * (-0.02625 + 0.01926 * phi2 - 0.00396 * phi4))
```

---

## 5. Winkel Tripel (ヴィンケル第3図法)
ナショナル ジオグラフィック協会が採用している図法。Aitoff 図法と正距円筒図法の平均。

**Formula:**
```js
// Aitoff projection (中間値)
cos_phi = cos(φ)
cos_lambda_half = cos(λ / 2)
α = acos(cos_phi * cos_lambda_half)
sincia = (α == 0) ? 1.0 : α / sin(α)

aitoff_x = 2.0 * cos_phi * sin(λ / 2.0) * sincia
aitoff_y = sin(φ) * sincia

// Winkel Tripel
x = (aitoff_x + λ / (PI / 2.0)) / 2.0
y = (aitoff_y + φ) / 2.0
```

---

## 6. Hammer (ハンマー図法)
ランベルト正積方位図法を横に引き伸ばした等積図法。

**Formula:**
```js
cos_phi = cos(φ)
d = sqrt(1.0 + cos_phi * cos(λ / 2.0))
x = (2.0 * sqrt(2.0) * cos_phi * sin(λ / 2.0)) / d
y = (sqrt(2.0) * sin(φ)) / d
```

---

## TSL 実装へのヒント
1. **正規化**: 入力の `lon` は `centerLon` を引いた後に `-PI` 〜 `PI` にラップする必要があります。
2. **スケーリング**: これらの式で得られる `x, y` は単位球（半径1）に基づいています。プロジェクトの `worldScale` を掛けて実際のワールド座標に変換してください。
3. **高速化**: 
   - `Natural Earth` のような多項式ベースは `pow` や `sin/cos` を多用する図法より GPU で高速です。
   - `Mollweide` の収束計算は、GPU ではループ回数を固定（例: 4〜8回）にすることで安定します。
