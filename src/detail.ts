/** Add contrast along coherent edges, within the original neighborhood range. */
export function restoreDetail(data: Uint8ClampedArray, width: number, height: number) {
  const light = new Uint8Array(width * height);
  for (let i = 0; i < light.length; i++) {
    const p = i * 4;
    light[i] = (54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2]) >> 8;
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const p = i * 4;
      if (data[p + 3] !== 255 || data[p - 1] !== 255 || data[p + 7] !== 255 ||
          data[p - width * 4 + 3] !== 255 || data[p + width * 4 + 3] !== 255) continue;
      const left = light[i - 1], right = light[i + 1];
      const above = light[i - width], below = light[i + width];
      const tl = light[i - width - 1], tr = light[i - width + 1];
      const bl = light[i + width - 1], br = light[i + width + 1];
      const gx = right - left, gy = below - above;
      const acrossX = Math.abs(gx) >= Math.abs(gy);
      const gradient = acrossX ? gx : gy;
      const flankA = acrossX ? tr - tl : bl - tl;
      const flankB = acrossX ? br - bl : br - tr;
      if (Math.abs(gradient) < 8 || gradient * flankA <= 0 || gradient * flankB <= 0) continue;
      const strength = Math.min(1, Math.abs(gradient) / 32, 48 / Math.abs(gradient));
      const a = acrossX ? left : above, b = acrossX ? right : below;
      const value = light[i];
      const delta = (value - (a + b) / 2) * strength * 0.85;
      const low = Math.min(0, a - value, b - value);
      const high = Math.max(0, a - value, b - value);
      const adjustment = Math.max(-14, low, -Math.min(data[p], data[p + 1], data[p + 2]),
        Math.min(14, high, 255 - Math.max(data[p], data[p + 1], data[p + 2]), delta));
      data[p] += adjustment;
      data[p + 1] += adjustment;
      data[p + 2] += adjustment;
    }
  }
}

/** Soften weak local luminance variations without blurring strong edges. */
export function softenJpegArtifacts(data: Uint8ClampedArray, width: number, height: number) {
  const light = new Uint8Array(width * height);
  for (let i = 0; i < light.length; i++) {
    const p = i * 4;
    light[i] = (54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2]) >> 8;
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = light[i];
      const left = light[i - 1] - value, right = light[i + 1] - value;
      const above = light[i - width] - value, below = light[i + width] - value;
      const contrast = Math.max(Math.abs(left), Math.abs(right), Math.abs(above), Math.abs(below));
      if (contrast > 16) continue;
      const change = Math.max(-3, Math.min(3, Math.round((left + right + above + below) / 8)));
      const p = i * 4;
      data[p] += change;
      data[p + 1] += change;
      data[p + 2] += change;
    }
  }
}
