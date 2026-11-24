import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Output, Settings } from './compress';
import CompressionWorker from './worker?worker';
import './style.css';

const preset = 999_999;
const icons = {
  image: 'M21 19V5c0-1.1-.9-2-2-2H5C3.9 3 3 3.9 3 5v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2ZM5 5h14v14H5Zm1 12h12l-3.6-4.8-2.5 3L10 13Z',
  download: 'M5 20h14v-2H5Zm7-3 5-5h-3V4h-4v8H7Z',
  close: 'm18.3 5.7-1.4-1.4L12 10.6 5.7 4.3 4.3 5.7l6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3Z',
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d={icons[name]}/></svg>;
}
type Row = { id: number; file: File; output?: Output; error?: string; settings?: Settings };
const bytes = (value: number) => value.toLocaleString() + ' B';
function filename(row: Row) {
  const extension = row.output?.blob.type.split('/')[1].replace('jpeg', 'jpg');
  return row.file.name.replace(/\.[^.]+$/, '') + (row.settings?.upscale ? `-${row.settings.upscale}x` : '') + '.' + extension;
}
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function workerCompression(file: File, settings: Settings, onProgress: (done: number, total: number) => void): Promise<Output> {
  return new Promise((resolve, reject) => {
    const worker = new CompressionWorker();
    function complete(data: { output?: Output; error?: string }) {
      clearTimeout(timer);
      worker.terminate();
      if (data.output) resolve(data.output);
      else reject(new Error(data.error || 'Local compression failed.'));
    }
    const timer = settings.upscale ? undefined : setTimeout(() => complete({ error: 'Local compression timed out.' }), 60_000);
    worker.onmessage = event => {
      const progress = event.data.progress;
      if (progress) onProgress(progress.done, progress.total);
      else complete(event.data);
    };
    worker.onerror = () => complete({ error: 'Local compression is unavailable.' });
    worker.postMessage({ file, settings });
  });
}
async function local(file: File, settings: Settings, onProgress: (done: number, total: number) => void): Promise<Output> {
  try {
    return await workerCompression(file, settings, onProgress);
  } catch (error) {
    if (settings.ai === 'photo') throw error;
    const { compress } = await import('./compress');
    return compress(file, settings);
  }
}
function Compare({ row, close }: { row: Row; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [urls, setUrls] = useState<string[]>([]);
  const [actual, setActual] = useState(false);
  const [showCleanup, setShowCleanup] = useState(false);
  const output = row.output!;
  const resultLabel = row.settings?.ai === 'photo' ? 'Photo AI 2×' : row.settings?.ai ? 'Light AI 2×' : row.settings?.upscale ? 'Upscaled' : 'Optimized';
  useEffect(() => {
    const sources = [row.file, output.blob, ...(output.cleaned ? [output.cleaned] : [])].map(blob => URL.createObjectURL(blob));
    setUrls(sources);
    dialog.current?.showModal();
    return () => sources.forEach(url => URL.revokeObjectURL(url));
  }, [row, output]);
  const labels = showCleanup ? ['Optimized', 'JPEG cleanup'] : [
    row.settings?.upscale ? 'Original, enlarged for comparison' : 'Original', resultLabel,
  ];
  const comparison = showCleanup ? urls.slice(1) : urls.slice(0, 2);
  return <dialog ref={dialog} onClose={close}><header><h2>Compare images</h2><button onClick={() => dialog.current?.close()} aria-label="Close comparison"><Icon name="close"/></button></header>
    <label className="zoom"><input type="checkbox" checked={actual} onChange={event => setActual(event.target.checked)}/> 100% zoom</label>
    {output.cleaned && <label className="zoom"><input type="checkbox" checked={showCleanup} onChange={event => setShowCleanup(event.target.checked)}/> Compare JPEG cleanup</label>}
    <div className="compare">{comparison.map((url, index) => <figure key={url}><figcaption>{labels[index]}{showCleanup && ` · ${bytes(index ? output.cleaned!.size : output.blob.size)}`}</figcaption><div onScroll={event => {
      const pane = event.currentTarget;
      const peer = pane.parentElement?.parentElement?.querySelectorAll('figure > div')[1 - index];
      if (peer && peer.scrollLeft !== pane.scrollLeft) peer.scrollLeft = pane.scrollLeft;
      if (peer && peer.scrollTop !== pane.scrollTop) peer.scrollTop = pane.scrollTop;
    }}><img src={url} alt={`${labels[index]} image`} style={{ width: actual ? output.width : '100%', maxWidth: actual ? 'none' : output.width }}/></div></figure>)}</div>
    {showCleanup && output.cleaned && <button className="cleanup-download" onClick={() => save(output.cleaned!, filename(row).replace(/\.(?=[^.]+$)/, '-cleaned.'))}>Download cleanup version</button>}
  </dialog>;
}
function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [size, setSize] = useState('1');
  const [unit, setUnit] = useState('MB');
  const [strict, setStrict] = useState(true);
  const [edge, setEdge] = useState('');
  const [mode, setMode] = useState<'compress' | 'upscale'>('compress');
  const [scale, setScale] = useState<2 | 4>(2);
  const [method, setMethod] = useState<'photo' | 'light' | 'standard'>('photo');
  const [cleanup, setCleanup] = useState(false);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [compare, setCompare] = useState<Row>();
  const id = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const limit = strict ? preset : Math.floor(Number(size) * (unit === 'MB' ? 1_000_000 : 1000));
  const valid = Number.isSafeInteger(limit) && limit > 0 && (!edge || (Number.isSafeInteger(Number(edge)) && Number(edge) > 0));
  const successful = rows.filter(row => row.output);
  function add(files: FileList | null) {
    if (!files || busy) return;
    const added = Array.from(files, file => ({ file, id: ++id.current }));
    setRows(previous => [...previous, ...added]);
  }
  async function run(batch: Row[], server = false) {
    setBusy(true);
    setNotice('');
    try {
      for (const [index, row] of batch.entries()) {
        setProgress(`Processing ${index + 1} of ${batch.length}`);
        const settings: Settings = server ? row.settings! : mode === 'upscale'
          ? { limit: Infinity, upscale: method === 'standard' ? scale : 2, ai: method === 'standard' ? undefined : method }
          : { limit, cleanup, edge: edge ? Number(edge) : undefined };
        let next: Row = { id: row.id, file: row.file, settings };
        try {
          let output: Output;
          if (server) {
            const form = new FormData();
            form.set('image', row.file);
            form.set('limit', String(settings.limit));
            if (settings.edge) form.set('edge', String(settings.edge));
            const response = await fetch('/api/compress', { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(response.status === 404 || response.status >= 500 ? 'Server compression is unavailable.' : await response.text());
            output = { blob: await response.blob(), width: Number(response.headers.get('X-Image-Width')), height: Number(response.headers.get('X-Image-Height')) };
          } else output = await local(row.file, settings, (done, total) => {
            setProgress(`Image ${index + 1} of ${batch.length} · ${Math.round(100 * done / total)}%`);
          });
          if (!output.blob.type.match(/^image\/(jpeg|png|webp)$/) || !output.blob.size || output.blob.size > settings.limit || output.width < 1 || output.height < 1) throw new Error('No valid image fits this limit.');
          next = { ...next, output };
        } catch (error) { next.error = error instanceof Error ? error.message : 'Image processing failed.'; }
        setRows(previous => previous.map(item => item.id === row.id ? next : item));
      }
    } finally { setBusy(false); setProgress(''); }
  }
  async function downloadZip() {
    setBusy(true);
    setNotice('');
    try {
      const { zipSync } = await import('fflate');
      const entries: Record<string, Uint8Array> = Object.create(null);
      const used = new Set<string>();
      for (const row of successful) {
        const original = filename(row).replace(/[\\/]/g, '_');
        let name = original;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = original.replace(/(\.[^.]+)$/, `-${n}$1`);
        used.add(name.toLowerCase());
        entries[name] = new Uint8Array(await row.output!.blob.arrayBuffer());
      }
      save(new Blob([new Uint8Array(zipSync(entries, { level: 0 }))], { type: 'application/zip' }), 'images.zip');
    } catch { setNotice('Could not create the ZIP. Individual downloads are still available.'); }
    finally { setBusy(false); }
  }
  return <main>
    <h1>Image Compressor</h1>
    <div className="controls mode" aria-label="Image operation" role="group">
      <button className="preset" disabled={busy} aria-pressed={mode === 'compress'} onClick={() => setMode('compress')}>Optimize</button>
      <button className="preset" disabled={busy} aria-pressed={mode === 'upscale'} onClick={() => setMode('upscale')}>Upscale</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if ((mode === 'upscale' || valid) && rows.length && !busy) void run(rows); }}>
      <button type="button" className={drag ? 'drop active' : 'drop'} disabled={busy} onClick={() => picker.current?.click()}
        onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={event => { event.preventDefault(); setDrag(false); add(event.dataTransfer.files); }}>
        <span className="image-icon"><Icon name="image"/></span><strong>Choose or drop images</strong><span>JPEG, PNG or WebP</span>
      </button>
      <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => { add(event.currentTarget.files); event.currentTarget.value = ''; }}/>
      {mode === 'compress' ? <div className="settings">
        <label htmlFor="size">Size limit per image</label>
        <div className="controls">
          <div className="size"><input id="size" type="number" min="0.001" step="any" value={size} onChange={event => { setStrict(false); setSize(event.target.value); }}/>
          <select aria-label="Size unit" value={unit} onChange={event => { setStrict(false); setUnit(event.target.value); }}><option>MB</option><option>KB</option></select></div>
          <button type="button" className="preset" aria-pressed={strict} onClick={() => { setSize('1'); setUnit('MB'); setStrict(true); }}>Under 1 MB</button>
        </div>
        <details><summary>Resize</summary><label htmlFor="edge">Maximum long edge (px)</label><input id="edge" type="number" min="1" step="1" placeholder="Original dimensions" value={edge} onChange={event => setEdge(event.target.value)}/></details>
        <label className="zoom"><input type="checkbox" checked={cleanup} onChange={event => setCleanup(event.target.checked)}/> Try JPEG artifact cleanup</label>
      </div> : <div className="settings">
        <label htmlFor="method">Upscaling method</label>
        <select id="method" value={method} onChange={event => {
          const value = event.target.value;
          setMethod(value === 'photo' || value === 'light' ? value : 'standard');
        }}>
          <option value="photo">Photo AI 2×</option><option value="light">Light AI 2×</option><option value="standard">Standard</option>
        </select>
        {method !== 'standard' ? <small>{method === 'photo' ? 'On-device photo restoration. Large images can take several minutes.' : 'Faster on-device upscaling.'} Up to 2 megapixels.</small> : <>
          <label htmlFor="scale">Enlarge by</label><select id="scale" value={scale} onChange={event => setScale(event.target.value === '4' ? 4 : 2)}><option value="2">2×</option><option value="4">4×</option></select>
        </>}
      </div>}
      <button className="primary" disabled={!rows.length || (mode === 'compress' && !valid) || busy}>{mode === 'upscale' ? 'Upscale images' : 'Optimize images'}</button>
    </form>
    <p className="private">Images stay on your device by default.</p>
    {progress && <p role="status">{progress}</p>}
    {notice && <p role="alert">{notice}</p>}
    {rows.length > 0 && <ul className="results">{rows.map(row => <li key={row.id}>
      <div className="row-main"><div className="file-info"><strong title={row.file.name}>{row.file.name}</strong><small>{bytes(row.file.size)}{row.output && ` → ${bytes(row.output.blob.size)} · ${row.output.width} × ${row.output.height}${row.settings?.upscale ? ' · ' + row.output.blob.type.split('/')[1].toUpperCase() : ''}`}</small></div>
        {row.output && <><button onClick={() => setCompare(row)}>Compare</button><button aria-label={`Download ${row.file.name}`} onClick={() => save(row.output!.blob, filename(row))}><Icon name="download"/></button></>}
        <button disabled={busy} aria-label={`Remove ${row.file.name}`} onClick={() => setRows(previous => previous.filter(item => item.id !== row.id))}><Icon name="close"/></button>
      </div>
      {row.error && <div className="error">{row.error} {!row.settings?.upscale && <button disabled={busy} onClick={() => void run([row], true)}>Upload and try server</button>}</div>}
      {row.output && row.settings?.cleanup && !row.output.cleaned && /\.(jpe?g)$/i.test(row.file.name) && <small>Cleanup version unavailable at this size.</small>}
    </li>)}</ul>}
    {successful.length > 1 && <button disabled={busy} className="zip" onClick={() => void downloadZip()}><Icon name="download"/> Download ZIP</button>}
    {compare && <Compare row={compare} close={() => setCompare(undefined)}/>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
