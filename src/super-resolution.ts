type Layer = { kernel: number; inputs: number; outputs: number; weights: Float32Array; bias: Float32Array; slope?: Float32Array };

export function readModel(buffer: ArrayBuffer) {
  if (buffer.byteLength !== 33988) throw new Error('The AI model could not be loaded.');
  const view = new DataView(buffer);
  let offset = 0;
  const take = (count: number) => Float32Array.from({ length: count }, () => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  });
  const dimensions = [[5, 1, 56], [1, 56, 12], [3, 12, 12], [3, 12, 12],
    [3, 12, 12], [3, 12, 12], [1, 12, 56], [1, 56, 4]];
  return dimensions.map(([kernel, inputs, outputs], index): Layer => ({
    kernel, inputs, outputs, weights: take(kernel * kernel * inputs * outputs),
    bias: take(index === dimensions.length - 1 ? 1 : outputs),
    slope: index === dimensions.length - 1 ? undefined : take(outputs),
  }));
}

// Apply the exported TensorFlow layers in NHWC order with SAME padding.
export function predict(input: Float32Array, width: number, height: number, layers: Layer[]) {
  for (const { kernel, inputs, outputs, weights, bias, slope } of layers) {
    const result = new Float32Array(width * height * outputs);
    const sums = new Float64Array(outputs);
    const pad = kernel >> 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        sums.fill(0);
        for (let ky = Math.max(0, pad - y); ky < Math.min(kernel, height + pad - y); ky++) {
          for (let kx = Math.max(0, pad - x); kx < Math.min(kernel, width + pad - x); kx++) {
            const pixel = ((y + ky - pad) * width + x + kx - pad) * inputs;
            let weight = (ky * kernel + kx) * inputs * outputs;
            for (let c = 0; c < inputs; c++) {
              const value = input[pixel + c];
              for (let o = 0; o < outputs; o++) sums[o] += value * weights[weight++];
            }
          }
        }
        const pixel = (y * width + x) * outputs;
        for (let o = 0; o < outputs; o++) {
          const value = sums[o] + bias[slope ? o : 0];
          result[pixel + o] = slope && value < 0 ? value * slope[o] : value;
        }
      }
    }
    input = result;
  }
  return input;
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const luminance = (rgba: Uint8ClampedArray, i: number) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];

export async function upscaleWithAI(
  original: CanvasImageSource, width: number, height: number, output: Context, scratch: Context,
) {
  const response = await fetch(`${import.meta.env.BASE_URL}fsrcnn-x2.bin`);
  if (!response.ok) throw new Error('The local AI model could not be loaded.');
  const model = readModel(await response.arrayBuffer());
  const tile = 64;
  const halo = 6;
  output.imageSmoothingQuality = 'high';
  output.drawImage(original, 0, 0, width * 2, height * 2);
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x), h = Math.min(tile, height - y);
      const left = Math.max(0, x - halo), top = Math.max(0, y - halo);
      const tw = Math.min(width, x + w + halo) - left, th = Math.min(height, y + h + halo) - top;
      scratch.clearRect(0, 0, tw, th);
      scratch.drawImage(original, left, top, tw, th, 0, 0, tw, th);
      const source = scratch.getImageData(0, 0, tw, th).data;
      const input = Float32Array.from({ length: tw * th }, (_, i) => luminance(source, i * 4) / 255);
      const refined = predict(input, tw, th, model);
      const pixels = output.getImageData(x * 2, y * 2, w * 2, h * 2);
      for (let j = 0; j < h * 2; j++) {
        for (let i = 0; i < w * 2; i++) {
          const p = (j * w * 2 + i) * 4;
          if (pixels.data[p + 3] !== 255) continue;
          const index = (((j >> 1) + y - top) * tw + (i >> 1) + x - left) * 4;
          const predicted = refined[index + (j % 2) * 2 + i % 2] * 255;
          const change = Math.max(-48, Math.min(48, predicted - luminance(pixels.data, p)));
          pixels.data[p] += change;
          pixels.data[p + 1] += change;
          pixels.data[p + 2] += change;
        }
      }
      output.putImageData(pixels, x * 2, y * 2);
      if (typeof document !== 'undefined') await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
