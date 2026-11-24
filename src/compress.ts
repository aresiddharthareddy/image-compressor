import { restoreDetail, softenJpegArtifacts } from './detail';
import { tiledPng } from './tiled-png';

export type Settings = { limit: number; edge?: number; upscale?: 2 | 4; cleanup?: boolean; ai?: 'photo' | 'light' };
export type Output = { blob: Blob; width: number; height: number; cleaned?: Blob };

function inspect(bytes: ArrayBuffer) {
  const v = new DataView(bytes);
  const tag = (p: number, n = 4) => String.fromCharCode(...new Uint8Array(bytes, p, n));
  if (v.byteLength >= 33 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a && tag(12) === 'IHDR') {
    for (let p = 8; p + 12 <= v.byteLength;) {
      if (tag(p + 4) === 'acTL') throw new Error('Choose a still image.');
      p += 12 + v.getUint32(p);
    }
    return { width: v.getUint32(16), height: v.getUint32(20), type: 'image/png' };
  }
  if (v.byteLength >= 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const kind = tag(12);
    if (kind === 'VP8X') {
      if (v.getUint8(20) & 2) throw new Error('Choose a still image.');
      const size = (p: number) => 1 + v.getUint16(p, true) + 65536 * v.getUint8(p + 2);
      return { width: size(24), height: size(27), type: 'image/webp' };
    }
    if (kind === 'VP8L') {
      const bits = v.getUint32(21, true);
      return { width: 1 + (bits & 16383), height: 1 + ((bits >>> 14) & 16383), type: 'image/webp' };
    }
    if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 16383, height: v.getUint16(28, true) & 16383, type: 'image/webp' };
  }
  if (v.byteLength >= 4 && v.getUint16(0) === 0xffd8) {
    for (let p = 2; p + 4 <= v.byteLength;) {
      if (v.getUint8(p++) !== 255) break;
      while (p < v.byteLength && v.getUint8(p) === 255) p++;
      if (p + 3 > v.byteLength) break;
      const marker = v.getUint8(p++);
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && p + 7 <= v.byteLength) {
        return { width: v.getUint16(p + 5), height: v.getUint16(p + 3), type: 'image/jpeg' };
      }
      const length = v.getUint16(p);
      if (length < 2 || marker === 218) break;
      p += length;
    }
  }
  throw new Error('Choose a valid JPEG, PNG, or WebP.');
}

function surface(width: number, height: number, options?: CanvasRenderingContext2DSettings) {
  if (typeof document === 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', options)!, encode: (type: string, quality: number) => canvas.convertToBlob({ type, quality }) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    canvas,
    context: canvas.getContext('2d', options)!,
    encode: (type: string, quality: number) => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), type, quality);
    }),
  };
}

async function decode(blob: Blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob, { imageOrientation: 'from-image' });
  if (typeof document === 'undefined') throw new Error('Local decoding is unavailable.');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { close() {} });
  } finally { URL.revokeObjectURL(url); }
}

async function fit(encode: ReturnType<typeof surface>['encode'], type: string, limit: number) {
  let low = 0.08, high = 0.98;
  let candidate: Blob | undefined;
  for (let i = 0; i < (type === 'image/png' ? 1 : 7); i++) {
    const quality = i === 0 ? high : i === 1 ? low : (low + high) / 2;
    const blob = await encode(type, quality);
    if (blob.type !== type) break;
    if (blob.size <= limit) {
      candidate = blob;
      low = quality;
      if (i === 0) break;
    } else {
      high = quality;
      if (i === 1) break;
    }
  }
  return candidate;
}

export async function compress(file: File, settings: Settings, onProgress?: (done: number, total: number) => void): Promise<Output> {
  const meta = inspect(await file.arrayBuffer());
  if (!meta.width || !meta.height) throw new Error('This image has invalid dimensions.');
  const original = await decode(file.slice(0, file.size, meta.type));
  const { width, height } = original;
  try {
    if (settings.upscale) {
      const w = width * settings.upscale, h = height * settings.upscale;
      if (settings.ai && (settings.upscale !== 2 || width * height > 2_000_000 || Math.max(w, h) > 8192)) {
        throw new Error('AI 2× accepts images up to 2 megapixels and 4,096 pixels per side. Choose Standard for larger images.');
      }
      if (w * h > 24_000_000 || Math.max(w, h) > 8192) {
        const blob = await tiledPng(original, w, h, (width, height) => surface(width, height, { willReadFrequently: true }));
        return { blob, width: w, height: h };
      }
      const { canvas, context, encode } = surface(w, h, { willReadFrequently: true });
      try {
        if (settings.ai === 'photo') {
          const { enhancePhoto } = await import('./photo-ai');
          const scratch = surface(128, 128, { willReadFrequently: true });
          try {
            await enhancePhoto(original, width, height, context, scratch.context, onProgress);
          } finally { scratch.canvas.width = scratch.canvas.height = 1; }
        } else if (settings.ai === 'light') {
          const { upscaleWithAI } = await import('./super-resolution');
          const scratch = surface(76, 76, { willReadFrequently: true });
          await upscaleWithAI(original, width, height, context, scratch.context);
        } else {
          context.imageSmoothingQuality = 'high';
          context.drawImage(original, 0, 0, w, h);
          const pixels = context.getImageData(0, 0, w, h);
          restoreDetail(pixels.data, w, h);
          context.putImageData(pixels, 0, 0);
        }
        let blob = await encode('image/webp', 0.9);
        // Some canvas implementations silently fall back to PNG.
        if (blob.type === 'image/webp' && blob.size > file.size * 2) {
          for (const quality of [0.84, 0.78]) {
            const candidate = await encode('image/webp', quality);
            if (candidate.type === 'image/webp' && candidate.size < blob.size) blob = candidate;
            if (blob.size <= file.size * 2) break;
          }
        }
        return { blob, width: w, height: h };
      } finally { canvas.width = canvas.height = 1; }
    }
    async function withCleanup(output: Output): Promise<Output> {
      const { width: w, height: h } = output;
      if (!settings.cleanup || meta.type !== 'image/jpeg' || w * h > 24_000_000 || Math.max(w, h) > 8192) return output;
      try {
        const { canvas, context, encode } = surface(w, h, { willReadFrequently: true });
        try {
          context.imageSmoothingQuality = 'high';
          context.drawImage(original, 0, 0, w, h);
          const image = context.getImageData(0, 0, w, h);
          softenJpegArtifacts(image.data, w, h);
          context.putImageData(image, 0, 0);
          const cleaned = await fit(encode, output.blob.type, Math.min(settings.limit, file.size - 1));
          return cleaned?.size ? { ...output, cleaned } : output;
        } finally { canvas.width = canvas.height = 1; }
      } catch {
        return output;
      }
    }
    if (file.size <= settings.limit && Math.max(width, height) <= (settings.edge ?? Infinity)) {
      return await withCleanup({ blob: file.slice(0, file.size, meta.type), width, height });
    }
    // Bound the encoding canvas, rather than rejecting high-resolution input.
    const longEdge = Math.max(width, height);
    const ratio = Math.min(1, (settings.edge ?? Infinity) / longEdge,
      Math.sqrt(24_000_000 / (width * height)), 8192 / longEdge);
    const base = Math.max(1, Math.floor(Math.max(width, height) * ratio));
    const compareRatio = Math.min(ratio, 640 / Math.max(width, height));
    const { canvas: preview, context } = surface(Math.max(1, Math.round(width * compareRatio)), Math.max(1, Math.round(height * compareRatio)), { willReadFrequently: true });
    const pixels = (source: CanvasImageSource) => {
      context.clearRect(0, 0, preview.width, preview.height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, preview.width, preview.height);
      return context.getImageData(0, 0, preview.width, preview.height).data;
    };
    const reference = pixels(original);
    let best: Output | undefined;
    let bestScore = Infinity;
    async function consider(blob: Blob, w: number, h: number) {
      const bitmap = await decode(blob);
      try {
        const sample = pixels(bitmap);
        let error = 0;
        for (let i = 0; i < sample.length; i += 4) {
          const alpha = reference[i + 3] / 255;
          for (let c = 0; c < 3; c++) error += alpha * (sample[i + c] - reference[i + c]) ** 2;
          error += 3 * (sample[i + 3] - reference[i + 3]) ** 2;
        }
        const score = error / sample.length + (blob.type === meta.type ? 0 : 0.15) + 2 * (1 - Math.max(w, h) / base);
        if (score < bestScore) { bestScore = score; best = { blob, width: w, height: h }; }
      } finally { bitmap.close(); }
    }
    for (let step = 0; step < 9; step++) {
      const scale = Math.max(1, Math.floor(base * 0.78 ** step)) / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const { canvas, encode, context: drawing } = surface(w, h);
      drawing.imageSmoothingQuality = 'high';
      drawing.drawImage(original, 0, 0, w, h);
      const types = meta.type === 'image/webp' ? [meta.type] : [meta.type, 'image/webp'];
      for (const type of types) {
        const candidate = await fit(encode, type, settings.limit);
        if (candidate) await consider(candidate, w, h);
      }
      canvas.width = canvas.height = 1;
      if (best || (w === 1 && h === 1)) break;
    }
    if (!best) throw new Error('This image could not fit the selected limit locally.');
    return await withCleanup(best);
  } finally { original.close(); }
}
