import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import wasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import moduleUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const inputSize = 128;
const nativeScale = 4;
const nativeSize = inputSize * nativeScale;
const border = 24;
const core = inputSize - 2 * border;
let session: Promise<InferenceSession> | undefined;

function loadSession() {
  env.wasm.numThreads = 1;
  env.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.href).href, mjs: new URL(moduleUrl, location.href).href };
  session ??= InferenceSession.create(`${import.meta.env.BASE_URL}real-esrgan-general-x4v3.onnx`, {
    executionProviders: ['wasm'],
  }).catch(error => {
    session = undefined;
    throw error;
  });
  return session;
}

export async function enhancePhoto(
  image: CanvasImageSource, width: number, height: number, output: Context, scratch: Context,
  onProgress?: (done: number, total: number) => void,
) {
  const model = await loadSession();
  const input = new Float32Array(3 * inputSize * inputSize);
  const plane = inputSize * inputSize;
  const outputPlane = nativeSize * nativeSize;
  const total = Math.ceil(width / core) * Math.ceil(height / core);
  let done = 0;
  // Keep the original alpha and color for partially transparent pixels.
  output.imageSmoothingQuality = 'high';
  output.drawImage(image, 0, 0, width * 2, height * 2);
  for (let y = 0; y < height; y += core) {
    for (let x = 0; x < width; x += core) {
      const left = Math.max(0, x - border), top = Math.max(0, y - border);
      const sw = Math.min(width - left, x - border + inputSize - left);
      const sh = Math.min(height - top, y - border + inputSize - top);
      scratch.clearRect(0, 0, sw, sh);
      scratch.drawImage(image, left, top, sw, sh, 0, 0, sw, sh);
      const rgba = scratch.getImageData(0, 0, sw, sh).data;
      for (let row = 0; row < inputSize; row++) {
        const sy = Math.max(0, Math.min(sh - 1, y - border + row - top));
        for (let col = 0; col < inputSize; col++) {
          const sx = Math.max(0, Math.min(sw - 1, x - border + col - left));
          const pixel = (sy * sw + sx) * 4;
          const index = row * inputSize + col;
          for (let c = 0; c < 3; c++) input[c * plane + index] = rgba[pixel + c] / 255;
        }
      }
      const tensor = new Tensor('float32', input, [1, 3, inputSize, inputSize]);
      try {
        const result = await model.run({ [model.inputNames[0]]: tensor });
        const enhanced = result[model.outputNames[0]];
        try {
          const values = enhanced.data as Float32Array;
          const w = Math.min(core, width - x) * 2, h = Math.min(core, height - y) * 2;
          const pixels = output.getImageData(x * 2, y * 2, w, h);
          const inset = border * nativeScale;
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const pixel = (row * w + col) * 4;
              if (pixels.data[pixel + 3] !== 255) continue;
              const at = (inset + row * 2) * nativeSize + inset + col * 2;
              for (let c = 0; c < 3; c++) {
                const p = c * outputPlane + at;
                pixels.data[pixel + c] = 63.75 * (values[p] + values[p + 1] + values[p + nativeSize] + values[p + nativeSize + 1]);
              }
            }
          }
          output.putImageData(pixels, x * 2, y * 2);
        } finally { enhanced.dispose(); }
      } finally { tensor.dispose(); }
      onProgress?.(++done, total);
    }
  }
}
