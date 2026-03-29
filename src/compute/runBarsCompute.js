/*
  このファイルは「WebGPU の compute shader を 1 回実行して、
  JavaScript で扱える数値配列として結果を返すまで」の流れを担当する。

  処理の順序は次の通り。

  1. `navigator.gpu` から adapter と device を取得する
     - adapter は利用可能な GPU 実装の入口
     - device は buffer や pipeline を作る本体

  2. 入力・出力・読み戻し用の GPU buffer を用意する
     - inputBuffer: CPU の配列を GPU に渡す
     - outputBuffer: compute shader が結果を書き込む
     - readbackBuffer: GPU の結果を CPU 側へ戻す

  3. WGSL で compute shader を作る
     - 各スレッドが 1 要素ずつ担当し
     - 入力値を 2 倍して出力 buffer へ書き込む

  4. compute pipeline と bind group を作る
     - pipeline は「どの shader をどう実行するか」
     - bind group は「shader の binding にどの buffer を渡すか」

  5. command encoder / compute pass で命令列を組み立てる
     - dispatchWorkgroups() で必要な workgroup 数だけ起動する

  6. outputBuffer を readbackBuffer へコピーして mapAsync() で読む
     - これで GPU 上の計算結果を JS の配列へ戻せる

  7. 最後に unmap / destroy で resource を解放する

  つまり、このファイルは scene や React には依存せず、
  「compute を実行して結果を返す」ことだけに責務を絞っている。
*/
const WORKGROUP_SIZE = 64

function createShaderCode(length) {
  // WGSL を文字列で生成している。
  // 今回の shader は「入力配列の各要素を 2 倍して出力配列へ書く」だけの最小例。
  //
  // 重要な点:
  // - `@group(0) @binding(0)` が入力 buffer
  // - `@group(0) @binding(1)` が出力 buffer
  // - `@builtin(global_invocation_id)` で各スレッドの通し番号を受け取る
  // - `@workgroup_size(64)` は 1 workgroup あたり 64 スレッドで動く設定
  return `
struct Data {
  values: array<f32>,
};

@group(0) @binding(0) var<storage, read> inputData: Data;
@group(0) @binding(1) var<storage, read_write> outputData: Data;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;

  if (i >= ${length}u) {
    return;
  }

  outputData.values[i] = inputData.values[i] * 2.0;
}
  `
}

export async function runBarsCompute(inputValues) {
  // WebGPU 自体が使えない環境では compute 以前に進めない。
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  // adapter は「どの GPU 実装を使うか」の入口。
  const adapter = await navigator.gpu.requestAdapter()

  if (!adapter) {
    throw new Error('GPUAdapter を取得できませんでした')
  }

  // device は実際に buffer / pipeline / command encoder を作る本体。
  const device = await adapter.requestDevice()

  // 入力 buffer:
  // CPU 側の Float32Array を GPU から読める storage buffer に詰める。
  // `mappedAtCreation: true` で作成直後だけ CPU から直接書き込めるようにしている。
  const inputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(inputBuffer.getMappedRange()).set(inputValues)
  inputBuffer.unmap()

  // 出力 buffer:
  // compute shader が書き込む先。あとで readbackBuffer へコピーする。
  const outputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })

  // 読み戻し用 buffer:
  // storage buffer はそのまま JS で読みやすい形ではないので、
  // COPY_DST | MAP_READ を持つ専用 buffer に転送してから読む。
  const readbackBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  try {
    // WGSL 文字列から shader module を作る。
    const shaderModule = device.createShaderModule({
      code: createShaderCode(inputValues.length),
    })

    // compute pipeline は「どの shader を compute として実行するか」をまとめたもの。
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    })

    // bind group は「shader の binding 番号に、どの GPU resource を差し込むか」の対応表。
    // ここで binding 0 に inputBuffer、binding 1 に outputBuffer を渡している。
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: outputBuffer } },
      ],
    })

    // command encoder は GPU に送る命令列を組み立てる箱。
    const encoder = device.createCommandEncoder()
    // compute pass は render pass とは別物で、描画ではなく計算専用。
    const pass = encoder.beginComputePass()

    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    // dispatchWorkgroups() は「何 workgroup 起動するか」を決める。
    // 今回は 64 スレッド単位なので、要素数を 64 で割って切り上げている。
    pass.dispatchWorkgroups(Math.ceil(inputValues.length / WORKGROUP_SIZE))
    pass.end()

    // GPU 計算結果を CPU が読める buffer へコピーする。
    encoder.copyBufferToBuffer(
      outputBuffer,
      0,
      readbackBuffer,
      0,
      inputValues.byteLength
    )

    // ここで初めて GPU に命令列を送る。
    device.queue.submit([encoder.finish()])

    // GPU 側の処理完了を待ってから、CPU 側で値を読む。
    await readbackBuffer.mapAsync(GPUMapMode.READ)
    const copy = readbackBuffer.getMappedRange().slice(0)
    return Array.from(new Float32Array(copy))
  } finally {
    // map 状態と GPU resource を最後に片付ける。
    // 学習用サンプルでも cleanup は入れておいた方が流れを理解しやすい。
    readbackBuffer.unmap()
    inputBuffer.destroy()
    outputBuffer.destroy()
    readbackBuffer.destroy()
  }
}
