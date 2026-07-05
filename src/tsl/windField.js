import { Fn, cos, float, sin, vec3 } from 'three/tsl'

/*
  3D ノイズ風場の共有部品（plan.md R4）。

  runRainCompute から切り出した「位置 + 時間 → 風力 vec3」のファクトリ。
  sin/cos 手展開の 3 オクターブ FBM + 突風で、空間的に変化する乱流を作る。
  雨・雪・火の粉など複数のパーティクル系で同じ風場を共有する。

  パラメータは uniform ノードでも JS 数値でも渡せる（uniform なら再コンパイル
  なしで実行時調整できる）。octave 構成や空間スケールは生成時に焼き込む。

  竜巻（plan.md D4）はここに vortex 項（中心 vec2 / 半径 / 接線速度 / 吸引 /
  上昇気流の uniform）を追加し、FBM と合成する拡張を予定している。

  @param {object} o
  @param {Node|number} o.turbScale     ノイズの空間周波数（小さい = 大きなうねり）
  @param {Node|number} o.turbStrength  乱流の強さ
  @param {Node|number} o.gustFrequency 突風の時間変動周波数
  @param {Node|number} o.gustStrength  突風の追加強度
  @param {number}      o.timeScale     ノイズの時間変化速度
  @param {number}      o.yDamping      Y 方向の風の減衰
  @param {{x,z}}       o.gustSpatialScale 突風の空間変動スケール
  @param {Array}       o.octaves       [{ freq, amp }] × 3 想定
  @returns {{ windAt: Fn }} windAt([pos(vec3), time(float)]) → 風力 vec3
                            （フレームスケールは呼び出し側で乗じる）
*/

export const DEFAULT_WIND_OCTAVES = [
  { freq: 1.0, amp: 1.0 },  // オクターブ 1: 大きなうねり
  { freq: 2.3, amp: 0.4 },  // オクターブ 2: 中程度の渦
  { freq: 4.7, amp: 0.15 }, // オクターブ 3: 細かい乱流
]

export function createWindField({
  turbScale,
  turbStrength,
  gustFrequency,
  gustStrength,
  timeScale = 0.5,
  yDamping = 0.1,
  gustSpatialScale = { x: 0.03, z: 0.04 },
  octaves = DEFAULT_WIND_OCTAVES,
}) {
  const windAt = Fn(([pos, t]) => {
    const noiseX = pos.x.mul(turbScale).toVar()
    const noiseY = pos.y.mul(turbScale).toVar()
    const noiseZ = pos.z.mul(turbScale).toVar()
    const noiseT = t.mul(timeScale).toVar()

    const windFX = float(0).toVar()
    const windFY = float(0).toVar()
    const windFZ = float(0).toVar()

    // オクターブ 1
    const f1 = float(octaves[0].freq)
    const a1 = float(octaves[0].amp)
    windFX.addAssign(sin(noiseX.mul(f1).mul(1.7).add(noiseZ.mul(2.3)).add(noiseT.mul(1.1))).mul(a1))
    windFY.addAssign(cos(noiseY.mul(f1).mul(1.3).add(noiseX.mul(1.9)).add(noiseT.mul(0.7))).mul(a1).mul(yDamping))
    windFZ.addAssign(sin(noiseZ.mul(f1).mul(2.1).add(noiseY.mul(1.7)).add(noiseT.mul(0.9))).mul(a1))

    // オクターブ 2
    const f2 = float(octaves[1].freq)
    const a2 = float(octaves[1].amp)
    windFX.addAssign(cos(noiseX.mul(f2).mul(3.1).add(noiseY.mul(4.7)).add(noiseT.mul(1.9))).mul(a2))
    windFY.addAssign(sin(noiseZ.mul(f2).mul(2.7).add(noiseX.mul(3.3)).add(noiseT.mul(1.3))).mul(a2).mul(yDamping))
    windFZ.addAssign(cos(noiseZ.mul(f2).mul(3.7).add(noiseY.mul(2.9)).add(noiseT.mul(1.7))).mul(a2))

    // オクターブ 3
    const f3 = float(octaves[2].freq)
    const a3 = float(octaves[2].amp)
    windFX.addAssign(sin(noiseX.mul(f3).mul(5.3).add(noiseZ.mul(7.1)).add(noiseT.mul(2.7))).mul(a3))
    windFY.addAssign(cos(noiseY.mul(f3).mul(4.9).add(noiseZ.mul(6.3)).add(noiseT.mul(2.1))).mul(a3).mul(yDamping))
    windFZ.addAssign(sin(noiseZ.mul(f3).mul(6.7).add(noiseX.mul(5.9)).add(noiseT.mul(2.9))).mul(a3))

    // 突風: 時間 + 位置で変動する位相からブースト量と方向を作る
    const gustPhase = t.mul(gustFrequency).add(
      pos.x.mul(gustSpatialScale.x).add(pos.z.mul(gustSpatialScale.z))
    ).toVar()
    const gustFactor = sin(gustPhase).mul(0.5).add(0.5).toVar()
    const gustBoost = gustFactor.mul(gustStrength).toVar()

    return vec3(
      windFX.mul(turbStrength).add(gustBoost.mul(sin(gustPhase.mul(1.3)))),
      windFY.mul(turbStrength),
      windFZ.mul(turbStrength).add(gustBoost.mul(cos(gustPhase.mul(0.9))))
    )
  })

  return { windAt }
}
