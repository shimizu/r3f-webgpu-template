const WORKGROUP_SIZE = 64

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
  if (!navigator.gpu) {
    throw new Error('このブラウザは WebGPU compute に未対応です')
  }

  const adapter = await navigator.gpu.requestAdapter()

  if (!adapter) {
    throw new Error('GPUAdapter を取得できませんでした')
  }

  const device = await adapter.requestDevice()

  const inputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(inputBuffer.getMappedRange()).set(inputValues)
  inputBuffer.unmap()

  const outputBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })

  const readbackBuffer = device.createBuffer({
    size: inputValues.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const shaderModule = device.createShaderModule({
    code: shaderCode,
  })

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: shaderModule,
      entryPoint: 'main',
    },
  })

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
    paramsView.setUint32(0, inputValues.length, true)
    paramsView.setUint32(4, 0, true)
    paramsView.setUint32(8, 0, true)
    paramsView.setFloat32(12, time, true)
    device.queue.writeBuffer(uniformBuffer, 0, paramsBuffer)
  }

  return {
    async run(time) {
      if (destroyed) {
        throw new Error('compute runner は破棄済みです')
      }

      writeParams(time)

      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()

      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(inputValues.length / WORKGROUP_SIZE))
      pass.end()

      encoder.copyBufferToBuffer(
        outputBuffer,
        0,
        readbackBuffer,
        0,
        inputValues.byteLength
      )

      device.queue.submit([encoder.finish()])

      await readbackBuffer.mapAsync(GPUMapMode.READ)

      try {
        const copy = readbackBuffer.getMappedRange().slice(0)
        return Array.from(new Float32Array(copy))
      } finally {
        readbackBuffer.unmap()
      }
    },

    destroy() {
      if (destroyed) {
        return
      }

      destroyed = true
      inputBuffer.destroy()
      outputBuffer.destroy()
      readbackBuffer.destroy()
      uniformBuffer.destroy()
    },
  }
}
