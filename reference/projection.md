# Projection Notes

`src/projection` の実装を、D3 に依存しない形で座標変換の観点から整理したメモ。
目的は「緯度経度 `[lon, lat]` を画面座標 `[x, y]` に変換する処理を、別環境で再実装する」ための参考情報を残すこと。

## 1. 変換の全体像

`d3-geo` の投影処理は、概ね次の 4 段に分かれる。

1. 緯度経度を degrees から radians に変換する
2. 地球上の回転を適用する
3. 投影ごとの数式で、球面座標 `(lambda, phi)` を平面座標 `(u, v)` に変換する
4. 拡大縮小、平行移動、必要なら画面上での回転や反転を適用して `(x, y)` にする

式で書くと次の通り。

```txt
[lon, lat] degrees
-> [lambda, phi] radians
-> rotate(lambda, phi)
-> project(lambda, phi) = [u, v]
-> affine(u, v) = [x, y]
```

ここで:

- `lon`, `lat` は経度・緯度
- `lambda`, `phi` はラジアン化後の経度・緯度
- `project` は投影ごとの生変換
- `affine` は scale / translate / angle / reflect の画面変換

## 2. 最小実装で必要なもの

別実装で最低限必要なのは次の 3 つだけ。

1. `degreesToRadians`
2. `rotateSphere`
3. `projectRaw` と `toScreen`

最小構成の JavaScript 例:

```js
const DEG2RAD = Math.PI / 180;

function toRadians([lon, lat]) {
  return [lon * DEG2RAD, lat * DEG2RAD];
}

function toScreen(u, v, {
  scale = 150,
  translateX = 480,
  translateY = 250,
  angle = 0,
  reflectX = false,
  reflectY = false
} = {}) {
  const sx = reflectX ? -1 : 1;
  const sy = reflectY ? -1 : 1;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const uu = u * sx;
  const vv = v * sy;

  const rx = scale * (cosA * uu - sinA * vv);
  const ry = scale * (sinA * uu + cosA * vv);

  return [translateX + rx, translateY - ry];
}

function projectPoint(lonLat, {
  rotate = rotateIdentity,
  projectRaw,
  scale,
  translateX,
  translateY,
  angle,
  reflectX,
  reflectY
}) {
  const [lambda, phi] = toRadians(lonLat);
  const [rotLambda, rotPhi] = rotate(lambda, phi);
  const [u, v] = projectRaw(rotLambda, rotPhi);
  return toScreen(u, v, {
    scale,
    translateX,
    translateY,
    angle,
    reflectX,
    reflectY
  });
}
```

## 3. 回転の扱い

投影前の回転は「地球を回してから投影する」処理。
これを入れておくと、任意の地域を中央に持ってきやすい。

最小限なら、まずは経度だけの回転を実装すれば十分なことが多い。

```js
const TAU = Math.PI * 2;

function wrapLambda(lambda) {
  if (Math.abs(lambda) > Math.PI) {
    lambda -= Math.round(lambda / TAU) * TAU;
  }
  return lambda;
}

function rotateIdentity(lambda, phi) {
  return [lambda, phi];
}

function rotateLambda(deltaLambda) {
  return function(lambda, phi) {
    return [wrapLambda(lambda + deltaLambda), phi];
  };
}
```

緯度方向やロールも含む完全な球面回転が必要なら、`src/rotation.js` の `rotateRadians` 相当を移植すればよい。
ただし多くの用途では、最初は `deltaLambda` のみでも足りる。

## 4. 画面座標化の扱い

`d3-geo` の画面変換で重要なのは、Y 軸が下向きになる点。

```txt
x = translateX + scale * projectedX
y = translateY - scale * projectedY
```

この `- projectedY` によって、通常の数学座標系の上向き Y を画面座標系に変換している。

画面上の回転 `angle` を入れるなら:

```txt
rx = scale * ( cos(angle) * u - sin(angle) * v )
ry = scale * ( sin(angle) * u + cos(angle) * v )

x = translateX + rx
y = translateY - ry
```

## 5. 代表的な raw projection

ここでの `lambda`, `phi` はラジアン。
戻り値 `(u, v)` は、まだ画面座標ではない。

### Equirectangular

もっとも単純。

```js
function equirectangularRaw(lambda, phi) {
  return [lambda, phi];
}
```

### Mercator

```js
function mercatorRaw(lambda, phi) {
  return [lambda, Math.log(Math.tan((Math.PI / 2 + phi) / 2))];
}
```

注意:

- 極に近いと `tan` と `log` が発散する
- 実用上は `phi` を少し制限した方が安全

例:

```js
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mercatorRawSafe(lambda, phi) {
  const limit = 1.4844222297453324;
  const p = clamp(phi, -limit, limit);
  return [lambda, Math.log(Math.tan((Math.PI / 2 + p) / 2))];
}
```

### Orthographic

地球儀をそのまま見たような投影。

```js
function orthographicRaw(lambda, phi) {
  return [
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi)
  ];
}
```

この投影では、裏側に回った点を描画しない判定も必要になることが多い。
簡易には `Math.cos(phi) * Math.cos(lambda) > 0` を可視条件として使える。

### Cylindrical Equal Area

```js
function cylindricalEqualAreaRaw(phi0) {
  const cosPhi0 = Math.cos(phi0);
  return function(lambda, phi) {
    return [lambda * cosPhi0, Math.sin(phi) / cosPhi0];
  };
}
```

`phi0` は標準緯線。

## 6. 投影を切り替えられる設計

再実装するなら、「投影固有の数式」と「画面変換」を分けると扱いやすい。

```js
function createProjection({
  raw,
  rotate = rotateIdentity,
  scale = 150,
  translateX = 480,
  translateY = 250,
  angle = 0,
  reflectX = false,
  reflectY = false
}) {
  return function(lon, lat) {
    const [lambda, phi] = [lon * DEG2RAD, lat * DEG2RAD];
    const [rLambda, rPhi] = rotate(lambda, phi);
    const [u, v] = raw(rLambda, rPhi);
    return toScreen(u, v, {
      scale,
      translateX,
      translateY,
      angle,
      reflectX,
      reflectY
    });
  };
}
```

使用例:

```js
const mercator = createProjection({
  raw: mercatorRaw,
  scale: 152.63,
  translateX: 480,
  translateY: 250
});

const [x, y] = mercator(139.6917, 35.6895);
```

## 7. center を持つ実装にしたい場合

`d3-geo` は `center([lon, lat])` をそのまま使うのではなく、「その中心点が translate の位置へ来るように」投影後の原点ずれを補正している。

考え方は次の通り。

1. `centerLonLat` をラジアン化する
2. 回転と raw projection を通して `(cu, cv)` を得る
3. その中心が画面中央へ来るように平行移動を補正する

```js
function createProjectionWithCenter({
  raw,
  rotate = rotateIdentity,
  center = [0, 0],
  scale = 150,
  translateX = 480,
  translateY = 250
}) {
  const [centerLambda, centerPhi] = [center[0] * DEG2RAD, center[1] * DEG2RAD];
  const [rCenterLambda, rCenterPhi] = rotate(centerLambda, centerPhi);
  const [cu, cv] = raw(rCenterLambda, rCenterPhi);

  return function(lon, lat) {
    const [lambda, phi] = [lon * DEG2RAD, lat * DEG2RAD];
    const [rLambda, rPhi] = rotate(lambda, phi);
    const [u, v] = raw(rLambda, rPhi);
    return [
      translateX + scale * (u - cu),
      translateY - scale * (v - cv)
    ];
  };
}
```

最初の一歩としては、この方式で十分。

## 8. 実装時の注意点

- 入力の経度・緯度はたいてい degrees なので、raw projection には必ず radians を渡す
- 多くの式は極付近や反対側で発散・不連続になる
- 可視範囲の判定は投影ごとに必要になることがある
- `scale` の既定値は投影ごとに見た目合わせの定数で、数学的に必須ではない
- 線やポリゴンを描く場合は、点変換だけではなく日付変更線またぎや補間が必要になる

最後の点は重要で、`d3-geo` の `resample` や `clip` は主にこのために存在する。
ただし「点を描く」「マーカーを置く」「重心だけ求める」程度なら、このメモの範囲で十分なことが多い。

## 9. 再実装の優先順

別環境へ移植するなら、次の順で作るのが現実的。

1. `equirectangularRaw` と `mercatorRaw` を実装する
2. `toScreen` と `center` 補正を実装する
3. 必要なら `rotateLambda` を入れる
4. それでも不足するなら完全な球面回転を入れる
5. 線やポリゴンを扱うときだけ clip / resample を追加する

まず点の変換を正しく動かし、その後に境界処理を足す方が実装負荷を抑えやすい。

## 10. 元コードとの対応

このメモの対応先は主に以下。

- 共通変換: `src/projection/index.js`
- 球面回転: `src/rotation.js`
- 関数合成: `src/compose.js`
- 投影ごとの生変換: `src/projection/*Raw`

特に `src/projection/index.js` の要点は次の 2 つ。

1. 入力点を radians に変換してから `projectRotateTransform` に渡している
2. `projectRotateTransform` は「rotate -> raw projection -> scale/translate/angle/reflect」の合成になっている

つまり、別実装では D3 の API 自体を真似る必要はなく、この合成順序だけ守ればよい。
