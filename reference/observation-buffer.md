# Observation Buffer Notes

GPU 投影と補間の起点になる生データレイアウト。

## float buffer

1 entity あたり `Float32Array` 12 要素で保持する。

```txt
0  lon
1  lat
2  alt
3  timestamp
4  prevLon
5  prevLat
6  prevAlt
7  prevTimestamp
8  speed
9  heading
10 type
11 status
```

## stride

- `OBSERVATION_STRIDE = 12`

## 意図

- Projection Pass は `lon`, `lat`, `alt` を読む
- Interpolation Pass は `prev*`, `timestamp`, `prevTimestamp` を読む
- Style や filtering は `speed`, `heading`, `type`, `status` を読む

## 補足

- `id` は将来的に `Uint32Array` 側へ分離する想定
- 初期段階では float buffer だけで Projection Pass の最小実装を成立させる
