/**
 * content.js — Pause & Verify v5.0
 *  - Detection is on-device (see src/offscreen). No API key.
 *  - Videos: frames are sampled while a video plays, so a share check uses several frames.
 *  - Reads Facebook's own "AI info" label when present.
 *  - Share popup / page badges respect the popup settings.
 */
(function () {
  'use strict';
  if (window.__pavLoaded) return;
  window.__pavLoaded = true;
  
  
  window.addEventListener('error', e => {
  if (e.message?.includes('Extension context invalidated')) {
    window.__pavLoaded = false; // allow re-injection on next load
  }
  });


  let isActive    = true;
  let bypassShare = false;   // prevents re-entry when "Share Anyway" fires a real click
  let lastKey = '', lastTs = 0;
  const REACTIONS = ['like','love','haha','wow','sad','angry','care'];


  // ── HCI feature state ────────────────────────────────────────────────────────
  let autoplaying         = true;   // Feature 1: allow video autoplay
  let grayscaleMode       = false;  // Feature 2: grayscale page
  let disableStoryAuto    = false;  // Feature 3: disable story auto-advance

  // Track the last genuine user input so we can tell user-initiated plays apart
  // from FB's programmatic autoplay calls.
  let lastUserInput = 0;
  const USER_PLAY_WINDOW_MS = 1200;
  const markUserInput = () => { lastUserInput = Date.now(); };
  document.addEventListener('pointerdown', markUserInput, { capture: true });
  document.addEventListener('keydown',     markUserInput, { capture: true });
  document.addEventListener('touchstart',  markUserInput, { capture: true, passive: true });

  // Videos we've already attached our "play" interceptor to.
  const patchedVideos = new WeakSet();

  function isExtensionValid() {
  try { return !!chrome.runtime?.id; } catch(e) { return false; }
  }

  function isUserInitiated() {
    return Date.now() - lastUserInput < USER_PLAY_WINDOW_MS;
  }

  function onVideoPlayIntercept(e) {
    // Only block programmatic/autoplay plays. Allow the user to press play manually.
    if (autoplaying) return;
    const v = e.target;
    if (isUserInitiated()) return;   // user just clicked — let it play
    try { v.pause(); } catch (_) {}
  }

  function patchVideo(v) {
    if (!v || patchedVideos.has(v)) return;
    patchedVideos.add(v);
    // Capture-phase listener so we can pause before FB's own handlers run.
    v.addEventListener('play', onVideoPlayIntercept, { capture: true });
  }

  function applyAutoplayState() {
    document.querySelectorAll('video').forEach(v => {
      patchVideo(v);
      if (!autoplaying) {
        if (!v.paused) { try { v.pause(); } catch (_) {} }
      } else {
        const r = v.getBoundingClientRect();
        const inView = r.top < window.innerHeight && r.bottom > 0;
        if (inView) v.play().catch(() => {});
      }
    });
    applyStoryAutoplayState();
  }

  // ── Feature 2: Grayscale ────────────────────────────────────────────────────
  function applyGrayscaleState() {
    document.documentElement.classList.toggle('pav-grayscale', grayscaleMode);
  }

  // ── Feature 3: Story autoplay ───────────────────────────────────────────────
  function isStoriesContext() {
    // Works for feed stories viewer and reels-as-stories
    return /\/stories\//.test(location.pathname) || /\/stories\//.test(location.href);
  }

  function applyStoryAutoplayState() {
    const onStories = isStoriesContext();
    // Toggle the CSS class that pauses progress-bar animations (image stories).
    document.documentElement.classList.toggle('pav-no-story-autoplay', disableStoryAuto && onStories);

    // For video stories: looping the video means its 'ended' event never fires,
    // which is what FB listens to when auto-advancing to the next story.
    if (onStories) {
      document.querySelectorAll('video').forEach(v => {
        if (disableStoryAuto) {
          v.loop = true;
        } else {
          // Only clear loop if we're the ones who set it (default Facebook videos aren't looped).
          // Safe to reset here — user explicitly turned the feature off.
          v.loop = false;
        }
      });
    }
  }

  // Re-apply whenever FB navigates (SPA). Content scripts can't hook the page's
  // history.pushState (isolated world), so poll the URL instead.
  (function watchUrlForStories() {
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        setTimeout(applyStoryAutoplayState, 50);
        setTimeout(applyStoryAutoplayState, 400);
      }
    }, 500);
  })();

  // Intercept new videos added by Facebook's infinite scroll
  const videoObserver = new MutationObserver(() => {
    const vids = document.querySelectorAll('video');
    vids.forEach(patchVideo);
    if (!autoplaying) {
      vids.forEach(v => { if (!v.paused && !isUserInitiated()) { try { v.pause(); } catch (_) {} } });
    }
    if (disableStoryAuto && isStoriesContext()) {
      vids.forEach(v => { v.loop = true; });
    }
  });
  videoObserver.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'SET_AUTOPLAY') {
    autoplaying = msg.value;
    applyAutoplayState();
    chrome.storage.local.set({ pav_autoplay: autoplaying });
    respond && respond({ ok: true });
  }
  if (msg.type === 'SET_GRAYSCALE') {
    grayscaleMode = !!msg.value;
    applyGrayscaleState();
    chrome.storage.local.set({ pav_grayscale: grayscaleMode });
    respond && respond({ ok: true });
  }
  if (msg.type === 'SET_STORY_AUTOPLAY') {
    // Incoming value = whether story autoplay is ALLOWED.
    // Our internal flag tracks whether it's DISABLED.
    disableStoryAuto = !msg.value;
    applyStoryAutoplayState();
    chrome.storage.local.set({ pav_story_autoplay: msg.value });
    respond && respond({ ok: true });
  }
  if (msg.type === 'PAV_ACTIVE_CHANGED') {
    isActive = msg.value;
    respond && respond({ ok: true });
  }
  if (msg.type === 'PAV_SCROLL_TIME_UP')  showScrollLimitOverlay();
  if (msg.type === 'PAV_SCROLL_RESET')    removeScrollLimitOverlay();
  if (msg.type === 'SET_SETTING') {
    // forward from background to content (pageBadges, shareOverlay, etc.)
    if (msg.key === 'shareOverlay') {
      // no-op here — shareOverlay is checked on click via isActive
    }
  }
});
// On load, read saved state for ALL HCI features
chrome.storage.local.get(['pav_autoplay', 'pav_grayscale', 'pav_story_autoplay'], r => {
  if (r.pav_autoplay === false)        { autoplaying      = false; }
  if (r.pav_grayscale === true)        { grayscaleMode    = true;  }
  if (r.pav_story_autoplay === false)  { disableStoryAuto = true;  }
  applyAutoplayState();
  applyGrayscaleState();
  applyStoryAutoplayState();
});
  // ── State sync ──────────────────────────────────────────────────────────────
  let uiSettings = { shareOverlay: true, pageBadges: true };
  chrome.storage.local.get(['pav_active', 'pav_settings'], r => {
    isActive = r.pav_active !== false;
    if (r.pav_settings) uiSettings = { ...uiSettings, ...r.pav_settings };
    if (isActive) safeSend({ type: 'WARMUP' });   // load the model early so the first check is quick
  });
  chrome.storage.onChanged.addListener(c => {
    if (c.pav_active !== undefined) isActive = c.pav_active.newValue !== false;
    if (c.pav_settings?.newValue) uiSettings = { ...uiSettings, ...c.pav_settings.newValue };
  });

  // Show time-limit overlay immediately if already expired when tab opens
  safeSend({ type: 'GET_SCROLL_STATUS' })
    .then(s => { if (s && s.expired) showScrollLimitOverlay(); })
    .catch(() => {});

  // ── Video frame sampling ────────────────────────────────────────────────────
  // While a video plays we keep a few recent frames, so the share check can look at
  // several moments of the video instead of one. Frames stay in memory only.
  const FRAME_EVERY_MS = 1500, MAX_FRAMES = 6;
  const frameStore = new WeakMap();   // <video> -> { frames: [dataURL], lastT: number }

  setInterval(() => {
    if (!isActive || document.hidden) return;
    document.querySelectorAll('video').forEach(v => {
      if (v.paused || v.ended || v.readyState < 2 || !isInView(v)) return;
      const st = frameStore.get(v) || { frames: [], lastT: -1 };
      if (Math.abs(v.currentTime - st.lastT) < 0.9) return;    // same moment, skip
      const f = captureElSafe(v);
      if (!f) return;
      st.frames.push(f);
      st.lastT = v.currentTime;
      if (st.frames.length > MAX_FRAMES) st.frames.shift();
      frameStore.set(v, st);
    });
  }, FRAME_EVERY_MS);

  function isInView(el) {
    const r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 80 && r.bottom > 0 && r.top < innerHeight;
  }

  // ── Share interception ──────────────────────────────────────────────────────
  document.addEventListener('click', onShareCapture, true);

  function onShareCapture(e) {
    if (!isActive || uiSettings.shareOverlay === false) return;
    if (bypassShare) return;   // our own programmatic re-click — let it through
    if (e.target?.closest?.('#pav-overlay')) return;
    const btn = walkUp(e.target, isShareBtn, 30);
    if (!btn) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    handleShare(btn);
  }

  async function handleShare(btn) {
    const post    = extractPost(btn);
    const entry   = { id: Date.now(), ts: Date.now(), reaction: 'share', post: slim(post), analysis: null };
    const overlay = showOverlay(post, null, true, btn);

    try {
      const analysis = await safeSend({ type: 'ANALYZE_POST', payload: payloadOf(post) });
      entry.analysis = analysis;
      safeSend({ type: 'STORE_REACTION', payload: entry });
      updateOverlay(overlay, post, analysis);
    } catch (_) {
      updateOverlay(overlay, post, null);
    }
  }

  function payloadOf(post) {
    return { text: post.text || '', images: post.images, kind: post.media, metaLabel: post.metaLabel };
  }
  function slim(post) {
    return { text: post.text, author: post.author, media: post.media };
  }

  // ── Reaction tracking ───────────────────────────────────────────────────────
  document.addEventListener('click',     onReaction, true);
  document.addEventListener('pointerup', onReaction, true);

  function onReaction(e) {
    if (!isActive) return;
    if (e.target?.closest?.('#pav-overlay')) return;
    if (walkUp(e.target, isShareBtn, 30)) return;
    const btn = walkUp(e.target, isReactionBtn, 30);
    if (!btn) return;
    const key = btnKey(btn), now = Date.now();
    if (key === lastKey && now - lastTs < 900) return;
    lastKey = key; lastTs = now;
    const reaction = getReactionType(btn);
    if (reaction) trackReaction(btn, reaction);
  }

  async function trackReaction(btn, reaction) {
    const post  = extractPost(btn);
    const entry = { id: Date.now(), ts: Date.now(), reaction, post: slim(post), analysis: null };
    await safeSend({ type: 'STORE_REACTION', payload: entry });
    try {
      const analysis = await safeSend({ type: 'ANALYZE_POST', payload: payloadOf(post) });
      if (!analysis) return;
      entry.analysis = analysis;
      await safeSend({ type: 'STORE_REACTION', payload: entry });
      if (uiSettings.pageBadges !== false &&
          (analysis.label === 'HIGH_RISK' || analysis.label === 'MEDIUM_RISK') &&
          post.container && !post.container.__pavBadge) {
        showBadge(post.container, analysis);
      }
    } catch (_) {}
  }

  // ── Button matchers ─────────────────────────────────────────────────────────
  function isShareBtn(n) {
    if (!n?.getAttribute) return false;
    const tag = (n.tagName||'').toUpperCase();
    if (['HTML','BODY','SCRIPT','STYLE','HEAD'].includes(tag)) return false;

    const al   = attr(n,'aria-label').toLowerCase().trim();
    const td   = attr(n,'data-testid').toLowerCase();
    const role = attr(n,'role').toLowerCase();

    // Only look at the node's own direct text, not all descendants
    const ownTx = Array.from(n.childNodes)
      .filter(nd => nd.nodeType === Node.TEXT_NODE)
      .map(nd => nd.textContent.trim().toLowerCase())
      .join('');
    // Span/div text for cases where the text node is one level down
    const tx = (n.textContent||'').trim().toLowerCase().slice(0, 30);

    // aria-label checks (covers locale variants + FB 2025 patterns)
    if (al === 'share') return true;
    if (al.startsWith('share ') || al.startsWith('share,')) return true;
    if (al.includes('share post') || al.includes('share video') || al.includes('share reel')) return true;
    if (al.includes('send this to friends')) return true;
    if (al.includes('share story') || al.includes('share to')) return true;

    // data-testid checks
    if (td === 'share' || td === 'share_button') return true;
    if (td.startsWith('share_') || td.endsWith('_share')) return true;

    // Role="button" (or <button>) whose visible text is exactly "share"
    if ((role === 'button' || tag === 'BUTTON') && (tx === 'share' || ownTx === 'share')) return true;

    return false;
  }

  function isReactionBtn(n) {
    if (!n?.getAttribute) return false;
    const tag = (n.tagName||'').toUpperCase();
    if (['HTML','BODY','MAIN','NAV','HEADER','FOOTER','SCRIPT','STYLE'].includes(tag)) return false;
    const al = attr(n,'aria-label').toLowerCase().trim();
    const td = attr(n,'data-testid').toLowerCase();
    if (REACTIONS.some(r => al===r||al===r+'.'||al.startsWith(r+' ')||al.startsWith(r+':'))) return true;
    if (attr(n,'aria-pressed')!==''&&REACTIONS.some(r=>al.includes(r))) return true;
    if (td==='like_def'||td==='like-button'||td.includes('reaction')) return true;
    return false;
  }

  function getReactionType(btn) {
    const al = attr(btn,'aria-label').toLowerCase().trim();
    for (const r of REACTIONS) {
      if (al===r||al===r+'.'||al.startsWith(r+' ')||al.startsWith(r+':')) return r;
    }
    if (attr(btn,'data-testid').toLowerCase().includes('like')||al.includes('like')) return 'like';
    return null;
  }

  // ── Post extraction ─────────────────────────────────────────────────────────
  // Anchor on the clicked button's own article so we never read an adjacent post.
  const META_AI_LABEL = /^(ai info|made with ai|ai[- ]generated|imagined with ai|generated with ai|ai[- ]modified|edited with ai|created with ai)$/i;

  function extractPost(btn) {
    const post = { text: '', author: '', images: [], media: 'none', metaLabel: false, container: null };

    let el = btn;
    for (let i = 0; i < 30 && el && el !== document.body; i++) {
      if (attr(el, 'role') === 'article') break;
      const pg = el.getAttribute?.('data-pagelet') || '';
      if (pg.includes('FeedUnit') || pg.includes('Feed')) break;
      el = el.parentElement;
    }
    post.container = el?.closest?.('[role="article"]') || el || btn.parentElement;
    const c = post.container;
    if (!c) return post;

    // Text
    const seen = new Set();
    const textSelectors = [
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
      '[dir="auto"]',
      'div[style*="text-align"]'
    ];
    for (const sel of textSelectors) {
      c.querySelectorAll(sel).forEach(n => {
        const t = (n.innerText || n.textContent || '').trim();
        if (t.length > 8) seen.add(t);
      });
    }
    post.text = [...seen].join(' ').slice(0, 1200);
    if (!post.text) post.text = (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);

    // Author
    const aEl = c.querySelector('strong a,h4 a,h3 a,[data-hovercard-prefer-name-as-target="2"]');
    if (aEl) post.author = (aEl.innerText || aEl.textContent || '').trim().slice(0, 80);

    // Facebook's own AI label ("AI info")
    post.metaLabel = hasMetaAiLabel(c);

    // Video: buffered frames + the current frame
    const vids = [...c.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 80);
    const vid = vids.find(v => !v.paused) || vids[0];
    if (vid) {
      const frames = [...(frameStore.get(vid)?.frames || [])];
      const now = vid.readyState >= 2 ? captureElSafe(vid) : null;
      if (now) frames.push(now);
      if (!frames.length && vid.poster) frames.push(vid.poster);   // thumbnail fallback
      if (frames.length) { post.images = frames.slice(-MAX_FRAMES); post.media = 'video'; }
    }

    // Images: up to 3 large post images
    if (!post.images.length) {
      const imgs = [...c.querySelectorAll('img')]
        .filter(i => i.naturalWidth >= 150 && i.naturalHeight >= 150 && !i.closest('a[href*="/stories/"]'))
        .filter(i => { const r = i.getBoundingClientRect(); return r.width >= 120 && r.height >= 120; })
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))
        .slice(0, 3);
      for (const img of imgs) {
        const d = captureElSafe(img);
        if (d) post.images.push(d);
        else if (/^https:/.test(img.currentSrc || img.src)) post.images.push(img.currentSrc || img.src);
      }
      if (post.images.length) post.media = 'image';
    }
    return post;
  }

  function hasMetaAiLabel(c) {
    const nodes = c.querySelectorAll('span, a, div[role="button"], [aria-label]');
    for (const n of nodes) {
      const al = (n.getAttribute('aria-label') || '').trim();
      if (al && META_AI_LABEL.test(al)) return true;
      if (n.childElementCount > 2) continue;
      const t = (n.textContent || '').trim();
      if (t.length && t.length <= 20 && META_AI_LABEL.test(t)) return true;
    }
    return false;
  }

  // Capture an <img>/<video> keeping its aspect ratio (shorter side 320px).
  // Returns null if the canvas is tainted (cross-origin) — caller then passes the URL.
  function captureElSafe(el) {
    try {
      const w0 = el.videoWidth || el.naturalWidth || el.width;
      const h0 = el.videoHeight || el.naturalHeight || el.height;
      if (!w0 || !h0) return null;
      const k = Math.min(1, 320 / Math.min(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(el, 0, 0, w, h);
      // all-black frame (not decoded yet / DRM) is useless
      const px = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
      const data = cv.toDataURL('image/jpeg', 0.92);
      if (data.length < 1500 && px[0] + px[1] + px[2] === 0) return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  // ── Share overlay ───────────────────────────────────────────────────────────
  function showOverlay(post, analysis, loading, originalBtn) {
    document.getElementById('pav-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'pav-overlay';
    overlay.setAttribute('data-theme', uiSettings.darkMode === false ? 'light' : 'dark');
    overlay.innerHTML = `
      <div class="pav-modal" role="dialog" aria-modal="true" aria-label="Pause and Verify">
        <div class="pav-modal__header">
          ${isExtensionValid() ? `<img src="${chrome.runtime.getURL('icons/icon32.png')}" width="22" height="22" alt="">` : ''}
          <span>Pause &amp; Verify</span>
          <button class="pav-close" id="pav-close" aria-label="Close">✕</button>
        </div>
        <div class="pav-modal__body" id="pav-body">
          ${loading ? loadingHTML(post) : analysisHTML(analysis, post)}
        </div>
        <div class="pav-modal__footer">
          <button class="pav-btn pav-btn--cancel" id="pav-cancel">Don't share</button>
          <button class="pav-btn pav-btn--share"  id="pav-proceed">Share anyway →</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const close = () => { overlay.remove(); document.body.style.overflow = prevOverflow; };
    overlay.querySelector('#pav-close').addEventListener('click', close);
    overlay.querySelector('#pav-cancel').addEventListener('click', close);
    overlay.querySelector('#pav-proceed').addEventListener('click', () => {
      close();
      bypassShare = true;   // let our own re-click through
      setTimeout(() => {
        try { if (originalBtn?.isConnected) originalBtn.click(); } finally {
          setTimeout(() => { bypassShare = false; }, 600);
        }
      }, 120);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
    return overlay;
  }

  function updateOverlay(overlay, post, analysis) {
    if (!overlay?.isConnected) return;
    const body = overlay.querySelector('#pav-body');
    if (body) body.innerHTML = analysisHTML(analysis, post);
    const shareBtn = overlay.querySelector('#pav-proceed');
    if (shareBtn && analysis) {
      const risk = analysis.label;
      shareBtn.textContent = (risk === 'LOW_RISK' || risk === 'UNKNOWN') ? 'Share →' : 'Share anyway →';
      shareBtn.style.background = risk === 'HIGH_RISK' ? '#dc2626' : risk === 'MEDIUM_RISK' ? '#d97706' : risk === 'UNKNOWN' ? '#4b5563' : '#16a34a';
    }
  }

  function loadingHTML(post) {
    const what = post?.media === 'video' ? `Checking ${post.images.length} video frame${post.images.length === 1 ? '' : 's'}…`
               : post?.media === 'image' ? 'Checking image…' : 'Checking post…';
    return `<div class="pav-loading">
      <div class="pav-spinner"></div>
      <div>${what}</div>
      <div class="pav-sub">Runs on your device — nothing is uploaded.</div>
    </div>`;
  }

  const VERDICT = {
    HIGH_RISK:   { icon: '🚨', text: 'Likely AI-generated',   color: '#ef4444' },
    MEDIUM_RISK: { icon: '⚠️', text: 'Possibly AI-generated', color: '#f59e0b' },
    LOW_RISK:    { icon: '✅', text: 'No strong AI signs',    color: '#22c55e' },
    UNKNOWN:     { icon: '❔', text: "Couldn't check the media", color: '#9ca3af' }
  };

  function analysisHTML(analysis, post) {
    if (!analysis) return `<div class="pav-loading"><div>Couldn't check this post.</div><div class="pav-sub">You can still share it.</div></div>`;
    const v = VERDICT[analysis.label] || VERDICT.LOW_RISK;
    const score = Math.round((analysis.combined_score || 0) * 100);
    const flags = (analysis.flags || []).slice(0, 4);
    const checkedMedia = analysis.image_score !== null && analysis.image_score !== undefined;
    let note = '';
    if (analysis.model_error) note = `<div class="pav-no-frame">⚠️ ${esc(String(analysis.model_error).slice(0, 90))}. Only the caption was checked.</div>`;
    else if (!checkedMedia && !analysis.meta_label) note = `<div class="pav-no-frame">No image or video found to check — result uses caption cues only.</div>`;
    const methodTxt = analysis.method === 'on-device'
      ? `🔒 Checked on your device${analysis.media_kind === 'video' ? ` · ${analysis.frames} frame${analysis.frames === 1 ? '' : 's'}` : ''}`
      : analysis.meta_label ? '🏷 Facebook label' : '📝 Caption cues only';
    return `
      <div class="pav-score-ring" style="border-color:${v.color}">
        <div class="pav-score-num" style="color:${v.color}">${analysis.label === 'UNKNOWN' ? '—' : score + '%'}</div>
      </div>
      <div class="pav-verdict" style="color:${v.color}">${v.icon} ${v.text}</div>
      ${note}
      ${flags.length ? `<div class="pav-flags">${flags.map(f => `<span class="pav-flag">${esc(f)}</span>`).join('')}</div>` : ''}
      ${checkedMedia ? `<div class="pav-bar-row"><span>AI-likeness</span><div class="pav-bar"><div style="width:${Math.round(analysis.image_score * 100)}%;background:#8b5cf6"></div></div><span>${Math.round(analysis.image_score * 100)}%</span></div>` : ''}
      ${analysis.text_score ? `<div class="pav-bar-row"><span>Caption cues</span><div class="pav-bar"><div style="width:${Math.round(analysis.text_score * 100)}%;background:#f59e0b"></div></div><span>${Math.round(analysis.text_score * 100)}%</span></div>` : ''}
      <div class="pav-method">${methodTxt}</div>
      <div class="pav-disclaimer">This is an automated estimate and can be wrong. Real videos are sometimes flagged, and new AI tools can slip through.</div>`;
  }

  // ── Post badge ──────────────────────────────────────────────────────────────
  function showBadge(el, result) {
    if (el.__pavBadge) return;
    el.__pavBadge = true;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const b = document.createElement('div');
    b.className = `pav-badge pav-badge--${result.label.toLowerCase()}`;
    b.textContent = `${result.label === 'HIGH_RISK' ? '🚨 Likely AI' : '⚠️ Possibly AI'} · ${Math.round(result.combined_score * 100)}%`;
    b.title = 'Pause & Verify — automated estimate, can be wrong';
    el.insertAdjacentElement('afterbegin', b);
  }

  // ── Scroll time limit overlay ───────────────────────────────────────────────
  function showScrollLimitOverlay() {
    if (document.getElementById('pav-scroll-limit-overlay')) return;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    const el = document.createElement('div');
    el.id = 'pav-scroll-limit-overlay';
    el.innerHTML = `
      <div class="pav-sl-modal">
        <div class="pav-sl-icon">⏰</div>
        <div class="pav-sl-title">Screen Time Limit Reached</div>
        <div class="pav-sl-body">
          You've used up your Facebook time for this session.<br>
          Taking a break is good for you!
        </div>
        <div class="pav-sl-actions">
          <button class="pav-sl-btn pav-sl-btn--extend" id="pav-sl-extend">+15 min</button>
          <button class="pav-sl-btn pav-sl-btn--done"   id="pav-sl-done">I'm Done ✓</button>
        </div>
        <div class="pav-sl-note">Set a new limit or reset your session in the extension popup.</div>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('pav-sl-extend').addEventListener('click', () => {
      safeSend({ type: 'EXTEND_SCROLL_SESSION', value: 15 * 60 * 1000 }).catch(() => {});
      removeScrollLimitOverlay();
    });
    document.getElementById('pav-sl-done').addEventListener('click', removeScrollLimitOverlay);
  }

  function removeScrollLimitOverlay() {
    const el = document.getElementById('pav-scroll-limit-overlay');
    if (el) el.remove();
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  // ── Utilities ───────────────────────────────────────────────────────────────
  function walkUp(el, test, max) {
    let n = el;
    for (let i=0; i<max && n && n!==document.body; i++) {
      if (test(n)) return n;
      n = n.parentElement;
    }
    return null;
  }
  function attr(el,name) { return el?.getAttribute?.(name)||''; }
  function btnKey(n) { return `${attr(n,'aria-label')}|${attr(n,'data-testid')}|${n.offsetLeft}|${n.offsetTop}`; }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
 function safeSend(msg) {
  return new Promise((resolve) => {
    // If extension context is already gone, resolve with null instead of rejecting
    if (!chrome.runtime?.id) {
      console.debug('[PAV] Extension context invalid – message skipped:', msg.type);
      return resolve(null);
    }
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        // Ignore errors caused by context invalidation
        if (chrome.runtime.lastError) {
          console.debug('[PAV] Runtime error (context likely invalid):', chrome.runtime.lastError.message);
          return resolve(null);
        }
        resolve(r);
      });
    } catch (e) {
      console.debug('[PAV] sendMessage threw:', e.message);
      resolve(null);
    }
  });
}

})();
