/**
 * background.js — Pause & Verify v5.0
 * Detection runs fully on-device (offscreen document + ONNX model). No API key, no server.
 */
'use strict';

const STORE_KEY = 'pav_reactions';
const TTL_MS    = 7 * 24 * 60 * 60 * 1000;
const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const IDLE_CLOSE_MIN = 10;               // free the model's memory after 10 idle minutes
const DEFAULT_HIGH = 0.7, DEFAULT_MED = 0.4;

// ── Alarms ────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() =>
  chrome.alarms.create('pav-cleanup', { periodInMinutes: 120 })
);
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'pav-cleanup') cleanupOld();
  if (a.name === 'pav-offscreen-idle') closeOffscreen();
  if (a.name === 'pav-scroll-limit') {
    chrome.tabs.query({ url: 'https://*.facebook.com/*' }, tabs =>
      tabs.forEach(t =>
        chrome.tabs.sendMessage(t.id, { type: 'PAV_SCROLL_TIME_UP' }).catch(() => {})
      )
    );
  }
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target === 'offscreen') return false;   // meant for the detector page

  if (msg.type === 'ANALYZE_POST') {
    let done = false;
    const finish = r => { if (!done) { done = true; respond(r); } };
    const timer = setTimeout(() =>
      finish({ ...heuristicResult(msg.payload?.text || '', msg.payload?.metaLabel, null), method: 'timeout' })
    , 45000);
    analyzePost(msg.payload || {})
      .then(r  => { clearTimeout(timer); finish(r); })
      .catch(e => {
        clearTimeout(timer);
        console.warn('[PAV] analyzePost error:', e);
        finish(heuristicResult(msg.payload?.text || '', msg.payload?.metaLabel, null));
      });
    return true;
  }

  if (msg.type === 'WARMUP') {
    respond({ ok: true });
    warmup().catch(() => {});
    return false;
  }

  if (msg.type === 'GET_MODEL_STATUS') {
    getModelStatus().then(respond);
    return true;
  }

  if (msg.type === 'STORE_REACTION') {
    respond({ ok: true });
    storeReaction(msg.payload).catch(e => console.warn('[PAV] store error:', e));
    return false;
  }

  if (msg.type === 'GET_REACTIONS') {
    chrome.storage.local.get([STORE_KEY], r => respond(r[STORE_KEY] || []));
    return true;
  }

  if (msg.type === 'CLEAR_REACTIONS') {
    chrome.storage.local.set({ [STORE_KEY]: [] }, () => respond({ ok: true }));
    return true;
  }

  if (msg.type === 'SET_ACTIVE') {
    chrome.storage.local.set({ pav_active: msg.value }, () => {
      chrome.tabs.query({ url: 'https://*.facebook.com/*' }, tabs =>
        tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'PAV_ACTIVE_CHANGED', value: msg.value }).catch(() => {}))
      );
      respond({ ok: true });
    });
    return true;
  }

  if (msg.type === 'GET_ACTIVE') {
    chrome.storage.local.get(['pav_active'], r => respond({ active: r.pav_active !== false }));
    return true;
  }

  if (msg.type === 'SET_SETTING') {
    chrome.tabs.query({ url: 'https://*.facebook.com/*' }, tabs =>
      tabs.forEach(t =>
        chrome.tabs.sendMessage(t.id, { type: 'SET_SETTING', key: msg.key, value: msg.value }).catch(() => {})
      )
    );
    respond({ ok: true });
    return false;
  }

  // ── Scroll time limit ──────────────────────────────────────────────────────
  if (msg.type === 'SET_SCROLL_LIMIT') {
    const ms  = msg.value || 0;
    const now = Date.now();
    chrome.alarms.clear('pav-scroll-limit');
    chrome.storage.local.set({
      pav_scroll_limit_ms: ms,
      pav_session_start:   ms > 0 ? now : null
    }, () => {
      if (ms > 0) chrome.alarms.create('pav-scroll-limit', { when: now + ms });
      respond({ ok: true });
    });
    return true;
  }

  if (msg.type === 'GET_SCROLL_STATUS') {
    chrome.storage.local.get(['pav_scroll_limit_ms', 'pav_session_start'], r => {
      const limitMs      = r.pav_scroll_limit_ms || 0;
      const sessionStart = r.pav_session_start   || null;
      const elapsed      = sessionStart ? Date.now() - sessionStart : 0;
      const remaining    = limitMs > 0 && sessionStart ? Math.max(0, limitMs - elapsed) : null;
      respond({ limitMs, sessionStart, remaining, expired: remaining !== null && remaining <= 0 });
    });
    return true;
  }

  if (msg.type === 'RESET_SCROLL_SESSION') {
    chrome.storage.local.get(['pav_scroll_limit_ms'], r => {
      const ms = r.pav_scroll_limit_ms || 0;
      chrome.alarms.clear('pav-scroll-limit');
      if (ms > 0) {
        const now = Date.now();
        chrome.storage.local.set({ pav_session_start: now }, () => {
          chrome.alarms.create('pav-scroll-limit', { when: now + ms });
          chrome.tabs.query({ url: 'https://*.facebook.com/*' }, tabs =>
            tabs.forEach(t =>
              chrome.tabs.sendMessage(t.id, { type: 'PAV_SCROLL_RESET' }).catch(() => {})
            )
          );
          respond({ ok: true });
        });
      } else {
        respond({ ok: true });
      }
    });
    return true;
  }

  if (msg.type === 'EXTEND_SCROLL_SESSION') {
    const extraMs = msg.value || 15 * 60 * 1000;
    chrome.storage.local.get(['pav_scroll_limit_ms', 'pav_session_start'], r => {
      const limitMs      = r.pav_scroll_limit_ms || 0;
      const sessionStart = r.pav_session_start   || Date.now();
      if (limitMs > 0) {
        const newLimit = limitMs + extraMs;
        chrome.alarms.clear('pav-scroll-limit');
        chrome.storage.local.set({ pav_scroll_limit_ms: newLimit }, () => {
          chrome.alarms.create('pav-scroll-limit', { when: sessionStart + newLimit });
          respond({ ok: true });
        });
      } else {
        respond({ ok: true });
      }
    });
    return true;
  }

  return false;
});

// ── Offscreen detector management ────────────────────────────────────────────
let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return ctx.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Runs the on-device AI-image detection model on image blobs captured from posts.'
    }).catch(e => {
      if (!String(e?.message).includes('single offscreen')) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function closeOffscreen() {
  try { if (await hasOffscreen()) await chrome.offscreen.closeDocument(); } catch (_) {}
}

function bumpIdleTimer() {
  chrome.alarms.create('pav-offscreen-idle', { delayInMinutes: IDLE_CLOSE_MIN });
}

async function sendToOffscreen(message, attempts = 3) {
  await ensureOffscreen();
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
      if (r !== undefined) return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    await new Promise(res => setTimeout(res, 150 * (i + 1)));   // page still booting
  }
  throw new Error('Detector did not respond');
}

async function warmup() {
  bumpIdleTimer();
  return sendToOffscreen({ type: 'WARMUP' });
}

async function getModelStatus() {
  try {
    if (!(await hasOffscreen())) return { ready: false, loading: false, sleeping: true };
    return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'MODEL_STATUS' });
  } catch (_) {
    return { ready: false, loading: false, sleeping: true };
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────
async function analyzePost(payload) {
  const { text = '', images = [], kind = 'none', metaLabel = false } = payload;
  let visual = null, frameScores = [], modelError = null;

  if (images.length) {
    bumpIdleTimer();
    try {
      const r = await sendToOffscreen({ type: 'DETECT', images });
      if (r?.ok && r.scores.length) {
        frameScores = r.scores;
        visual = kind === 'video'
          ? mean(frameScores)              // video: average over frames (robust to one odd frame)
          : Math.max(...frameScores);      // image post: any AI image flags the post
      } else if (r && !r.ok) {
        modelError = r.error;
      } else if (r?.errors?.length) {
        modelError = r.errors[0];
      }
    } catch (e) {
      modelError = String(e?.message || e);
    }
    if (modelError) console.warn('[PAV] detector:', modelError);
  }

  const res = heuristicResult(text, metaLabel, visual);
  res.media_kind   = images.length ? kind : 'none';
  res.frames       = frameScores.length;
  res.frame_scores = frameScores.map(r2);
  if (visual !== null) {
    res.method = 'on-device';
    const what = kind === 'video' ? 'video' : 'image';
    if (visual >= 0.5) {
      res.flags.unshift(`AI-like ${what}: ${pct(visual)}${kind === 'video' ? ` (${frameScores.length} frame${frameScores.length === 1 ? '' : 's'})` : ''}`);
      res.categories.unshift(kind === 'video' ? 'Possible AI Video' : 'Possible AI Image');
    }
  } else if (images.length && modelError) {
    res.model_error = /fetch|download|network/i.test(modelError)
      ? 'AI model not downloaded yet: needs internet once'
      : modelError;
  }
  return finalize(res);
}

function heuristicResult(text, metaLabel, visual) {
  const h = text.length > 10 ? heuristicText(text) : { score: 0, flags: [], categories: [] };
  const flags = [...h.flags], categories = [...h.categories];

  // Visual score is the main signal; text cues can only nudge it (damped noisy-OR).
  let combined;
  if (visual !== null) combined = visual + (1 - visual) * h.score * 0.5;
  else                 combined = h.score * 0.6;

  if (metaLabel) {
    combined = Math.max(combined, 0.97);
    flags.unshift('Facebook labelled this as AI');
    categories.unshift('Labelled AI by Meta');
  }

  return {
    image_score: visual !== null ? r2(visual) : null,
    text_score:  text.length > 10 ? r2(h.score) : null,
    combined_score: r2(Math.min(1, Math.max(0, combined))),
    meta_label: !!metaLabel,
    method: 'heuristics',
    flags, categories
  };
}

async function finalize(res) {
  const { pav_settings: s = {} } = await getStorage(['pav_settings']);
  const hi  = Number(s.highThresh) || DEFAULT_HIGH;
  const med = Number(s.medThresh)  || DEFAULT_MED;
  const c = res.combined_score;
  res.label = c >= hi ? 'HIGH_RISK' : c >= Math.min(med, hi) ? 'MEDIUM_RISK' : 'LOW_RISK';
  // Media couldn't be checked: don't show a reassuring green result.
  if (res.model_error && res.label === 'LOW_RISK') res.label = 'UNKNOWN';
  res.flags = [...new Set(res.flags)];
  res.categories = [...new Set(res.categories)];
  return res;
}

function heuristicText(text) {
  const flags = [], categories = [];
  const lo = text.toLowerCase();
  let score = 0;
  if (/\bai[- ]generated\b|\bai[- ]video\b|\bdeepfake\b|\bsynthetic video\b/.test(lo))
    { score += 0.55; flags.push('Caption mentions AI'); categories.push('AI-Generated'); }
  if (/made with ai|created (by|with) ai|\bsora\b|\bveo ?\d?\b|\bkling\b|\bmidjourney\b|\bdall-?e\b|\bstable diffusion\b|\brunway\b|\bhailuo\b/.test(lo))
    { score += 0.50; flags.push('AI tool mentioned'); categories.push('AI-Generated'); }
  if (/#ai\b|#aiart\b|#aivideo\b|#aigenerated\b|#artificialintelligence|#deepfake|#sora\b/.test(lo))
    { score += 0.45; flags.push('AI hashtag'); categories.push('AI-Generated'); }
  if (['share before', 'must share', 'forward this', 'everyone needs to see', 'before they delete'].some(p => lo.includes(p)))
    { score += 0.25; flags.push('Share-bait wording'); categories.push('Viral Manipulation'); }
  if (["they don't want", 'deep state', 'plandemic', 'wake up sheeple', 'false flag'].some(p => lo.includes(p)))
    { score += 0.30; flags.push('Conspiracy wording'); categories.push('Questionable Claims'); }
  if (['miracle cure', "doctors don't want", 'doctors hate'].some(p => lo.includes(p)))
    { score += 0.30; flags.push('Miracle-cure wording'); categories.push('Questionable Claims'); }
  const caps = (text.match(/\b[A-Z]{4,}\b/g) || []).length;
  if (caps > 4) { score += Math.min(caps * 0.025, 0.12); flags.push(`${caps} ALL-CAPS words`); }
  return { score: Math.min(1, Math.max(0, score)), flags, categories };
}

// ── Storage ───────────────────────────────────────────────────────────────────
function slimPost(post = {}) {
  // Never persist image/frame data — keeps storage small and private.
  return {
    text:   String(post.text || '').slice(0, 600),
    author: String(post.author || '').slice(0, 80),
    media:  post.media || (post.videoFrameData ? 'video' : post.imageData ? 'image' : 'none')
  };
}

function storeReaction(entry) {
  const clean = { id: entry.id, ts: entry.ts, reaction: entry.reaction, post: slimPost(entry.post), analysis: entry.analysis || null };
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORE_KEY], result => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const list = result[STORE_KEY] || [];
      const idx  = list.findIndex(e => e.id === clean.id);
      if (idx !== -1) list[idx] = clean; else list.unshift(clean);
      chrome.storage.local.set({ [STORE_KEY]: list.slice(0, 500) }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

function cleanupOld() {
  chrome.storage.local.get([STORE_KEY], r => {
    const now = Date.now();
    const fresh = (r[STORE_KEY] || []).filter(e => now - e.ts < TTL_MS);
    chrome.storage.local.set({ [STORE_KEY]: fresh });
  });
}

function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function r2(n)   { return Math.round(n * 100) / 100; }
function pct(n)  { return Math.round(n * 100) + '%'; }
