/**
 * offscreen.js — on-device AI-image detector.
 * Runs the ONNX model with onnxruntime-web (WebAssembly). Nothing leaves the device.
 * Only handles messages addressed to { target: 'offscreen' }.
 */
'use strict';

const CACHE_NAME = 'pav-model-v1';
let cfg = null;
let session = null;
let loading = null;
let queue = Promise.resolve();   // run inferences one at a time

ort.env.wasm.wasmPaths = chrome.runtime.getURL('libs/ort/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'DETECT') {
    queue = queue
      .then(() => detectAll(msg.images || []))
      .then(r => respond({ ok: true, ...r }))
      .catch(e => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg.type === 'MODEL_STATUS') {
    respond({ ready: !!session, loading: !!loading && !session, name: cfg?.name || null });
    return false;
  }
  if (msg.type === 'WARMUP') {
    ensureModel().then(() => respond({ ok: true }), e => respond({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});

// ── Model loading ────────────────────────────────────────────────────────────
async function loadConfig() {
  if (cfg) return cfg;
  const r = await fetch(chrome.runtime.getURL('models/model.json'));
  cfg = await r.json();
  return cfg;
}

async function loadModelBytes(c) {
  // 1. Bundled with the extension (preferred: offline, no network call)
  try {
    const r = await fetch(chrome.runtime.getURL(c.file));
    if (r.ok) {
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 64) return buf;
    }
  } catch (_) { /* not bundled */ }

  // 2. Previously downloaded copy
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(c.remoteUrl);
  if (hit) return hit.arrayBuffer();

  // 3. One-time download, then cached
  const r = await fetch(c.remoteUrl);
  if (!r.ok) throw new Error(`Model download failed (${r.status})`);
  const buf = await r.arrayBuffer();
  await cache.put(c.remoteUrl, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  return buf;
}

function ensureModel() {
  if (session) return Promise.resolve(session);
  if (!loading) {
    loading = (async () => {
      const c = await loadConfig();
      const bytes = await loadModelBytes(c);
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      return session;
    })().catch(e => { loading = null; throw e; });
  }
  return loading;
}

// ── Inference ────────────────────────────────────────────────────────────────
async function detectAll(images) {
  const s = await ensureModel();
  const scores = [];
  const errors = [];
  for (const src of images.slice(0, 8)) {
    try {
      const bmp = await toBitmap(src);
      scores.push(await runOne(s, bmp));
      bmp.close?.();
    } catch (e) {
      errors.push(String(e?.message || e));
    }
  }
  return { scores, errors, model: cfg.name };
}

async function toBitmap(src) {
  // src is a data: URL (captured in page) or an https URL (fetched with host permission)
  const res = await fetch(src, src.startsWith('http') ? { credentials: 'omit' } : undefined);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/') && blob.size < 100) throw new Error('not an image');
  return createImageBitmap(blob);
}

function preprocess(bmp) {
  const size  = cfg.inputSize;
  const short = cfg.resizeShortSide || size;
  const scale = short / Math.min(bmp.width, bmp.height);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // resize shorter side, then centre-crop size×size
  ctx.drawImage(bmp, -(w - size) / 2, -(h - size) / 2, w, h);
  const px = ctx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const out = new Float32Array(3 * n);
  const [m0, m1, m2] = cfg.mean, [s0, s1, s2] = cfg.std;
  for (let i = 0; i < n; i++) {
    out[i]         = (px[i * 4]     / 255 - m0) / s0;
    out[i + n]     = (px[i * 4 + 1] / 255 - m1) / s1;
    out[i + 2 * n] = (px[i * 4 + 2] / 255 - m2) / s2;
  }
  return new ort.Tensor('float32', out, [1, 3, size, size]);
}

async function runOne(s, bmp) {
  const input = preprocess(bmp);
  const out = await s.run({ [s.inputNames[0]]: input });
  const data = Array.from(out[s.outputNames[0]].data);
  if (data.length === 1) return cfg.outputIsLogits ? 1 / (1 + Math.exp(-data[0])) : data[0];
  let probs = data;
  if (cfg.outputIsLogits) {
    const mx = Math.max(...data);
    const ex = data.map(v => Math.exp(v - mx));
    const sum = ex.reduce((a, b) => a + b, 0);
    probs = ex.map(v => v / sum);
  }
  return probs.length === 1 ? probs[0] : probs[cfg.fakeIndex];
}
