import { compress, type Settings } from './compress';
self.onmessage = async ({ data }: MessageEvent<{ file: File; settings: Settings }>) => {
  try { self.postMessage({ output: await compress(data.file, data.settings, (done, total) => self.postMessage({ progress: { done, total } })) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Local compression failed.' }); }
};
