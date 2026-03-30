/*
  このファイルの処理の流れ

  1. OBSERVATION_STRIDE を決める
     1 エンティティぶんの観測データを Float32Array に何要素で詰めるかを固定する。

  2. OBSERVATION_OFFSET を定義する
     lon / lat / timestamp など各項目が、1 レコード内の何番目に入るかを決める。

  3. ENTITY_TYPE / ENTITY_STATUS を定義する
     文字列ではなく数値で状態を表せるようにして、
     CPU 側のパッキングと GPU 側の読み出しを軽くする。

  つまりこのファイルは、
  「観測データをどんな順番でバッファに詰めるか」を固定し、
  CPU と GPU の両方が同じレイアウトを共有するための定数定義を担当している。
*/
// 1 観測レコードを Float32Array に詰めるときの総要素数。
// つまり 1 エンティティぶんのバッファ幅を表す。
export const OBSERVATION_STRIDE = 12

// 各項目が「1 レコードの何番目に入るか」を固定する定義。
// CPU 側で値を書き込むときも、GPU 側で読み出すときも、この表を共有する。
export const OBSERVATION_OFFSET = {
  lon: 0,
  lat: 1,
  alt: 2,
  timestamp: 3,
  prevLon: 4,
  prevLat: 5,
  prevAlt: 6,
  prevTimestamp: 7,
  speed: 8,
  heading: 9,
  type: 10,
  status: 11,
}

// 可読性のための列挙値。
// 実際のバッファには文字列ではなく数値を入れている。
export const ENTITY_TYPE = {
  vessel: 1,
  aircraft: 2,
}

export const ENTITY_STATUS = {
  cruising: 1,
  approach: 2,
}
