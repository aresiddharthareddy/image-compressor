import { restoreDetail } from './detail';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  view.setUint32(bytes.length - 4, crc ^ 0xffffffff);
  return bytes;
}

export async function tiledPng(
  original: CanvasImageSource,
  width: number,
  height: number,
  createSurface: (width: number, height: number) => {
    canvas: HTMLCanvasElement | OffscreenCanvas;
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  },
) {
  if (width > 0x7fffffff || height > 0x7fffffff) throw new Error('The requested dimensions exceed the PNG format.');
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6], 8); // 8-bit RGBA.
  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  const tile = 2048;
  const stride = width * 4 + 1;
  const bandHeight = Math.max(1, Math.min(128, Math.floor(2_000_000 / stride)));
  const { canvas, context } = createSurface(Math.min(width, tile + 2), Math.min(height, bandHeight + 2));
  let top = 0;
  const previous = new Uint8Array(stride - 1);
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (top >= height) { controller.close(); return; }
      const rows = Math.min(bandHeight, height - top);
      const band = new Uint8Array(stride * rows);
      for (let left = 0; left < width; left += tile) {
        const columns = Math.min(tile, width - left);
        // Include adjacent output pixels so enhancement crosses tile boundaries.
        const x = Math.max(0, left - 1), y = Math.max(0, top - 1);
        const w = Math.min(width, left + columns + 1) - x;
        const h = Math.min(height, top + rows + 1) - y;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(original, -x, -y, width, height);
        const { data } = context.getImageData(0, 0, w, h);
        restoreDetail(data, w, h);
        for (let row = 0; row < rows; row++) {
          const start = ((top - y + row) * w + left - x) * 4;
          band.set(data.subarray(start, start + columns * 4), row * stride + left * 4 + 1);
        }
      }
      for (let offset = 0; offset < band.length; offset += stride) {
        const row = band.subarray(offset + 1, offset + stride);
        let subCost = 0, upCost = 0;
        for (let i = 0; i < row.length; i++) {
          const sub = Math.abs(row[i] - (i >= 4 ? row[i - 4] : 0));
          const up = Math.abs(row[i] - previous[i]);
          subCost += Math.min(sub, 256 - sub);
          upCost += Math.min(up, 256 - up);
        }
        const useUp = upCost < subCost;
        band[offset] = useUp ? 2 : 1;
        for (let i = row.length - 1; i >= 0; i--) {
          const value = row[i];
          row[i] -= useUp ? previous[i] : i >= 4 ? row[i - 4] : 0;
          previous[i] = value;
        }
      }
      controller.enqueue(band);
      top += rows;
    },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      parts.push(chunk('IDAT', result.value));
    }
    parts.push(chunk('IEND', new Uint8Array()));
    return new Blob(parts, { type: 'image/png' });
  } finally {
    reader.releaseLock();
    canvas.width = canvas.height = 1;
  }
}
