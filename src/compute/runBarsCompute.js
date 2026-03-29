/*
  このファイルの処理の流れを先に要約すると、次の順序になる。

  1. `createBarsComputeRunner(inputValues)` が呼ばれ、WebGPU の adapter と device を取得する
  2. 入力用、出力用、uniform 用、readback 用の buffer を作る
  3. WGSL shader から compute pipeline と bind group を組み立てる
  4. `run(time)` が呼ばれるたびに uniform buffer へ `length` と `time` を書く
  5. compute pass を実行して outputBuffer に結果を書き込む
  6. 結果を readbackBuffer にコピーし、`mapAsync()` で CPU 側へ読み戻して配列に変換する
  7. 不要になったら `destroy()` で GPU resource を解放する

  つまりこのファイルは、
  「GPU 上で配列を計算する仕組みそのもの」を担当していて、
  その結果をどう表示するかは `Scene.jsx` 側に委ねている。
*/
const WORKGROUP_SIZE = 64

/*
  このファイルは「WebGPU compute を実行して、その結果を JavaScript 配列として返す」
  ための最小 runner を定義している。

  役割を分けると次の 2 つになる。

  1. 初期化フェーズ
     - adapter / device を取得する
     - 入力・出力・uniform・readback 用の buffer を作る
     - WGSL shader module と compute pipeline を組み立てる
     - bind group を作り、shader に buffer を結びつける

  2. 実行フェーズ
     - uniform buffer に `time` や `length` を書く
     - command encoder で compute pass を組み立てる
     - `dispatchWorkgroups()` で shader を実行する
     - 結果を readback buffer にコピーして `mapAsync()` で CPU 側へ読む

  このサンプルは、
  「GPU で数値配列を更新し、その結果を React 側へ戻す」
  という流れを理解するための形に絞っている。
*/
const shaderCode = `
struct Data {
  values: array<f32>,
};

struct Params {
  length: u32,
  _pad0: u32,
  _pad1: u32,
  time: f32,
};

@group(0) @binding(0) var<storage, read> inputData: Data;
@group(0) @binding(1) var<storage, read_write> outputData: Data;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;

  if (i >= params.length) {
    return;
  }

  let phase = params.time * 2.0 + f32(i) * 0.45;
  let wave = 1.15 + sin(phase) * 0.35;

  outputData.values[i] = inputData.values[i] * wave;
}
`

export async function createBarsComputeRunner(inputValues) {
  // WebGPU 自体が使えない環境では、adapter/device の取得以前に止める。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  // adapter は「利用可能な GPU 実装を選ぶ入口」。
  const adapter = await navigator.gpu.requestAdapter()

  if (!adapter) {
    throw new Error('GPUAdapter を取得できませんでした')
  }

  // device は実際に buffer や pipeline を作る本体。
  const device = await adapter.requestDevice()

  // 入力配列を GPU 側の storage buffer に渡す。
  // `mappedAtCreation` にしているので、作成直後だけ CPU から直接書き込める。
  const inputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(inputBuffer.getMappedRange()).set(inputValues)
  inputBuffer.unmap()

  // shader の計算結果を書き込む先。
  // まだ CPU では直接読まず、あとで readbackBuffer にコピーする。
  const outputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })

  // GPU の結果を CPU 側へ戻す専用 buffer。
  // WebGPU では「計算結果を書いた storage buffer をそのまま読む」のではなく、
  // `MAP_READ` 可能な buffer にコピーしてから読むのが基本パターン。
  const readbackBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  // shader に毎フレーム変わるパラメータを渡すための uniform buffer。
  // 今回は配列長 `length` と経過時間 `time` を入れている。
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // WGSL 文字列から shader module を作る。
  // shaderCode では各要素ごとに波形係数を掛けて outputData へ書いている。
  const shaderModule = device.createShaderModule({
    code: shaderCode,
  })

  // compute pipeline は「この shader を compute として実行する」という定義。
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: shaderModule,
      entryPoint: 'main',
    },
  })

  // bind group は WGSL 側の binding 番号と、実際の buffer の対応表。
  // binding(0): inputBuffer
  // binding(1): outputBuffer
  // binding(2): uniformBuffer
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ],
  })

  const paramsBuffer = new ArrayBuffer(16)
  const paramsView = new DataView(paramsBuffer)

  let destroyed = false

  function writeParams(time) {
    // uniform の実データを CPU 側で 16 byte のバッファに詰める。
    // 今回の WGSL `Params` 構造体に合わせて、
    // 先頭に `length`、末尾に `time` を入れてから GPU へ転送する。
    paramsView.setUint32(0, inputValues.length, true)
    paramsView.setUint32(4, 0, true)
    paramsView.setUint32(8, 0, true)
    paramsView.setFloat32(12, time, true)
    device.queue.writeBuffer(uniformBuffer, 0, paramsBuffer)
  }

  return {
    async run(time) {
      // 破棄後に使うと GPU resource が無効なので明示的に止める。
      if (destroyed) {
        throw new Error('compute runner は破棄済みです')
      }

      // まず今回フレーム用の `time` を uniform に書く。
      writeParams(time)

      // command encoder は GPU に送る命令列を組み立てる箱。
      const encoder = device.createCommandEncoder()

      // render pass とは別に、compute 専用の pass を開始する。
      const pass = encoder.beginComputePass()

      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)

      // 1 workgroup あたり 64 スレッドなので、
      // 必要な workgroup 数だけ切り上げて起動する。
      pass.dispatchWorkgroups(Math.ceil(inputValues.length / WORKGROUP_SIZE))
      pass.end()

      // compute 結果を CPU が読める readbackBuffer に転送する。
      encoder.copyBufferToBuffer(
        outputBuffer,
        0,
        readbackBuffer,
        0,
        inputValues.byteLength
      )

      // ここで初めて、上で組み立てた命令列を GPU queue に送る。
      device.queue.submit([encoder.finish()])

      // GPU が readbackBuffer を読み出し可能な状態にするまで待つ。
      await readbackBuffer.mapAsync(GPUMapMode.READ)

      try {
        // `getMappedRange()` で読み出した ArrayBuffer を JS の数値配列へ変換する。
        const copy = readbackBuffer.getMappedRange().slice(0)
        return Array.from(new Float32Array(copy))
      } finally {
        // 次回の実行で再び map できるように unmap する。
        readbackBuffer.unmap()
      }
    },

    destroy() {
      if (destroyed) {
        return
      }

      // component の unmount 時などに GPU resource をまとめて解放する。
      destroyed = true
      inputBuffer.destroy()
      outputBuffer.destroy()
      readbackBuffer.destroy()
      uniformBuffer.destroy()
    },
  }
}
