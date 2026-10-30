'use strict';

const EMOJI     = { like:'👍',love:'❤️',haha:'😂',wow:'😮',sad:'😢',angry:'😡',care:'🤗',share:'🔁' };
const BADGE_CLS = { HIGH_RISK:'badge--red',MEDIUM_RISK:'badge--amber',LOW_RISK:'badge--green',UNKNOWN:'badge--grey' };

let allEntries = [], activeFilter = 'all';

// ── Settings state (defaults) ──────────────────────────────────────────────────
let settings = {
  darkMode:         true,
  compact:          false,
  showStats:        true,
  showScreenTime:   true,
  autoplay:         true,
  grayscale:        false,   // HCI Feature 2 — page-wide grayscale
  storyAutoplay:    true,    // HCI Feature 3 — when false, stories don't auto-advance
  showBadges:       true,
  showBars:         true,
  showFlags:        true,
  showText:         true,
  showMethod:       true,
  showMedia:        true,
  pageBadges:       true,
  shareOverlay:     true,
  maxPosts:         80,
  highThresh:       0.7,
  medThresh:        0.4,
};

const DEFAULT_SETTINGS = {
  darkMode:true, compact:false, showStats:true, showScreenTime:true,
  autoplay:true, grayscale:false, storyAutoplay:true,
  showBadges:true, showBars:true, showFlags:true, showText:true,
  showMethod:true, showMedia:true, pageBadges:true, shareOverlay:true,
  maxPosts:80, highThresh:0.7, medThresh:0.4,
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applySettings();
  // Run all loads independently — one failure won't block the others
  await Promise.allSettled([
    loadToggle(),
    loadModelStatus(),
    loadScrollTime(),
    loadAutoplay(),
    loadGrayscale(),
    loadStoryAutoplay(),
    loadReactions(),
  ]);
  bindEvents();
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const stored = await chromeGet(['pav_settings']);
    if (stored?.pav_settings) {
      settings = { ...settings, ...stored.pav_settings };
    }
  } catch(e) { /* use defaults */ }
}

async function saveSettings() {
  try { await chromeSet({ pav_settings: settings }); } catch(e) {}
}

function applySettings() {
  document.documentElement.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
  document.getElementById('themeToggleBtn').querySelector('.theme-icon').textContent =
    settings.darkMode ? '🌙' : '☀️';
  document.body.classList.toggle('compact-mode', settings.compact);

  const statsBar  = document.getElementById('statsBar');
  const stSection = document.getElementById('screenTimeSection');
  if (statsBar)  statsBar.style.display  = settings.showStats      ? '' : 'none';
  if (stSection) stSection.style.display = settings.showScreenTime ? '' : 'none';

  syncSettingToggle('settingDarkMode',       settings.darkMode);
  syncSettingToggle('settingCompact',        settings.compact);
  syncSettingToggle('settingShowStats',      settings.showStats);
  syncSettingToggle('settingShowScreenTime', settings.showScreenTime);
  syncSettingToggle('settingGrayscale',      settings.grayscale);
  syncSettingToggle('settingStoryAutoplay',  !settings.storyAutoplay); // toggle ON = "Disable story autoplay"
  syncSettingToggle('settingShowBadges',     settings.showBadges);
  syncSettingToggle('settingShowBars',       settings.showBars);
  syncSettingToggle('settingShowFlags',      settings.showFlags);
  syncSettingToggle('settingShowText',       settings.showText);
  syncSettingToggle('settingShowMethod',     settings.showMethod);
  syncSettingToggle('settingShowMedia',      settings.showMedia);
  syncSettingToggle('settingPageBadges',     settings.pageBadges);
  syncSettingToggle('settingShareOverlay',   settings.shareOverlay);
  syncSelect('settingMaxPosts',   String(settings.maxPosts));
  syncSelect('settingHighThresh', String(settings.highThresh));
  syncSelect('settingMedThresh',  String(settings.medThresh));
}

function syncSelect(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}
function syncSettingToggle(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = value;
}

// ── Detector status ─────────────────────────────────────────────────────────
async function loadModelStatus() {
  const dot = document.getElementById('modelDot');
  const label = document.getElementById('modelLabel');
  if (!dot) return;
  try {
    const st = await msg({ type: 'GET_MODEL_STATUS' });
    if (st?.ready)        { dot.className = 'dot dot--green'; label.textContent = '🔒 Detector ready · runs on your device'; }
    else if (st?.loading) { dot.className = 'dot dot--amber'; label.textContent = 'Loading detector…'; }
    else                  { dot.className = 'dot dot--green'; label.textContent = '🔒 On-device detection · loads when you open Facebook'; }
  } catch (e) {
    label.textContent = '🔒 On-device detection · no key needed';
  }
}

// ── Active toggle ─────────────────────────────────────────────────────────────
async function loadToggle() {
  try {
    const { active } = await msg({ type: 'GET_ACTIVE' });
    document.getElementById('activeToggle').checked = active;
  } catch(e) {}
}

// ── Reactions ─────────────────────────────────────────────────────────────────
async function loadReactions() {
  try {
    allEntries = await msg({ type: 'GET_REACTIONS' });
    renderStats();
    renderList();
  } catch(e) { allEntries = []; }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  document.getElementById('statTotal').textContent = allEntries.length;
  document.getElementById('statHigh').textContent  = allEntries.filter(e=>e.analysis?.label==='HIGH_RISK').length;
  document.getElementById('statMed').textContent   = allEntries.filter(e=>e.analysis?.label==='MEDIUM_RISK').length;
  document.getElementById('statLow').textContent   = allEntries.filter(e=>e.analysis?.label==='LOW_RISK').length;
  const mlCount = allEntries.filter(e=>e.analysis?.method==='on-device').length;
  document.getElementById('methodNote').textContent =
    mlCount > 0 ? `🔒 ${mlCount} checked on-device` :
    allEntries.filter(e=>e.analysis).length > 0 ? '📝 Caption cues only' : '';
}

// ── Screen Time ───────────────────────────────────────────────────────────────
let stCountdownInterval = null;

async function loadScrollTime() {
  try {
    const status = await msg({ type: 'GET_SCROLL_STATUS' });
    renderScrollTimeUI(status);
  } catch(e) {}
}

function renderScrollTimeUI(status) {
  const { limitMs = 0, remaining = null, expired = false } = status || {};
  document.querySelectorAll('.st-btn').forEach(b => {
    const activeMs = Number(b.dataset.hours) * 60 * 60 * 1000;
    b.classList.toggle('st-active', activeMs === limitMs);
  });
  const resetBtn  = document.getElementById('stResetBtn');
  const countdown = document.getElementById('stCountdown');
  const note      = document.getElementById('stNote');
  if (!resetBtn) return;
  if (stCountdownInterval) { clearInterval(stCountdownInterval); stCountdownInterval = null; }
  if (limitMs === 0) {
    countdown.textContent  = '';
    countdown.className    = 'st-countdown';
    note.textContent       = 'No limit set';
    resetBtn.style.display = 'none';
    return;
  }
  resetBtn.style.display = 'inline-block';
  if (expired || remaining === 0) {
    countdown.textContent = '0:00:00';
    countdown.className   = 'st-countdown st-expired';
    note.textContent      = `Limit: ${fmtHours(limitMs)} · Session ended`;
    return;
  }
  let localRemaining = remaining;
  let syncCounter    = 0;
  function tick() {
    localRemaining = Math.max(0, localRemaining - 1000);
    syncCounter++;
    if (syncCounter >= 30) {
      syncCounter = 0;
      msg({ type: 'GET_SCROLL_STATUS' }).then(s => {
        if (s && s.remaining !== null) localRemaining = s.remaining;
      }).catch(() => {});
    }
    if (localRemaining <= 0) {
      countdown.textContent = '0:00:00';
      countdown.className   = 'st-countdown st-expired';
      note.textContent      = `Limit: ${fmtHours(limitMs)} · Session ended`;
      if (stCountdownInterval) { clearInterval(stCountdownInterval); stCountdownInterval = null; }
      return;
    }
    countdown.textContent = fmtMs(localRemaining);
    countdown.className   = localRemaining < 10*60*1000 ? 'st-countdown st-warning' : 'st-countdown';
    note.textContent      = `Limit: ${fmtHours(limitMs)}`;
  }
  countdown.textContent = fmtMs(localRemaining);
  countdown.className   = localRemaining < 10*60*1000 ? 'st-countdown st-warning' : 'st-countdown';
  note.textContent      = `Limit: ${fmtHours(limitMs)}`;
  stCountdownInterval = setInterval(tick, 1000);
}

function fmtMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function fmtHours(ms) {
  const h = ms / (60*60*1000);
  return h === 1 ? '1 hr' : `${h} hrs`;
}

// ── Autoplay ──────────────────────────────────────────────────────────────────
async function loadAutoplay() {
  try {
    const r  = await chromeGet(['pav_autoplay']);
    const on = r.pav_autoplay !== false;
    settings.autoplay = on;
    const toggle = document.getElementById('autoplayToggle');
    if (toggle) toggle.checked = on;
    updateAutoplayNote(on);
  } catch(e) {}
}

function updateAutoplayNote(on) {
  const note = document.getElementById('autoplayNote');
  if (note) note.textContent = on ? 'Videos play automatically' : 'Videos are paused — tap to play';
}

// ── Grayscale (HCI Feature 2) ─────────────────────────────────────────────────
async function loadGrayscale() {
  try {
    const r = await chromeGet(['pav_grayscale']);
    const on = r.pav_grayscale === true;
    settings.grayscale = on;
    syncSettingToggle('settingGrayscale', on);
  } catch(e) {}
}

// ── Story Autoplay (HCI Feature 3) ────────────────────────────────────────────
async function loadStoryAutoplay() {
  try {
    const r = await chromeGet(['pav_story_autoplay']);
    // Default: true (stories auto-advance normally). If stored false, user has disabled it.
    const allow = r.pav_story_autoplay !== false;
    settings.storyAutoplay = allow;
    // UI toggle is phrased as "Disable Story Autoplay" → ON when autoplay is disabled
    syncSettingToggle('settingStoryAutoplay', !allow);
  } catch(e) {}
}

// ── List ──────────────────────────────────────────────────────────────────────
function renderList() {
  const list  = document.getElementById('list');
  const empty = document.getElementById('empty');
  const visible = allEntries.filter(e => {
    if (activeFilter==='all')   return true;
    if (activeFilter==='share') return e.reaction==='share';
    return e.analysis?.label === activeFilter;
  });
  list.querySelectorAll('.entry').forEach(e=>e.remove());
  empty.style.display = visible.length ? 'none' : 'flex';

  visible.slice(0, settings.maxPosts).forEach(entry => {
    const {reaction,post,analysis,ts} = entry;
    const label  = analysis?.label||'UNKNOWN';
    const score  = analysis?.combined_score??null;
    const method = analysis?.method||'pending';
    const flags  = (analysis?.flags||[]).slice(0,3);
    const imgS   = analysis?.image_score;
    const txtS   = analysis?.text_score;

    const div = document.createElement('div');
    div.className = 'entry' + (settings.compact ? ' compact' : '');

    const badgeHtml = settings.showBadges ? `
      <span class="badge ${BADGE_CLS[label]||'badge--grey'}">
        ${label==='HIGH_RISK'?'🚨 Likely AI':label==='MEDIUM_RISK'?'⚠️ Possibly AI':label==='LOW_RISK'?'✅ Low':analysis?'❔ Unchecked':'⏳'}
        ${score!==null?' '+Math.round(score*100)+'%':''}
      </span>` : '';

    const textHtml = settings.showText && post?.text
      ? `<div class="entry__text">${esc(post.text.slice(0,160))}${post.text.length>160?'…':''}</div>` : '';

    const flagsHtml = settings.showFlags && flags.length
      ? `<div class="flags">${flags.map(f=>`<span class="flag">${esc(f)}</span>`).join('')}</div>` : '';

    let barsHtml = '';
    if (settings.showBars) {
      const bars = [];
      if (imgS != null) bars.push(bar('AI-like', imgS, '#8b5cf6'));
      if (txtS)         bars.push(bar('Caption', txtS, '#f59e0b'));
      if (bars.length) barsHtml = `<div class="scores">${bars.join('')}</div>`;
    }

    let metaParts = [];
    if (settings.showMethod)
      metaParts.push(`<span class="method">${analysis?.meta_label&&method!=='on-device'?'🏷 FB label':method==='on-device'?'🔒 On-device':method==='heuristics'?'📝 Caption only':method==='timeout'?'⏱ Timed out':'⏳ Checking…'}</span>`);
    if (settings.showMedia) {
      const media = post?.media || (post?.videoFrameData ? 'video' : post?.imageData ? 'image' : 'none');
      if (media === 'image') metaParts.push('<span class="tag">🖼</span>');
      if (media === 'video') metaParts.push('<span class="tag">🎬</span>');
    }
    const metaHtml = metaParts.length ? `<div class="meta">${metaParts.join('')}</div>` : '';

    div.innerHTML = `
      <div class="entry__top">
        <span class="re">${EMOJI[reaction]||'👍'}</span>
        <span class="author">${esc(post?.author||'Unknown')}</span>
        <span class="time">${ago(ts)}</span>
        ${badgeHtml}
      </div>
      ${textHtml}${flagsHtml}${barsHtml}${metaHtml}`;
    list.appendChild(div);
  });
}

function bar(label, score, color) {
  return `<div class="score-row">
    <span class="score-lbl">${label}</span>
    <div class="score-track"><div class="score-fill" style="width:${Math.round(score*100)}%;background:${color}"></div></div>
    <span class="score-pct">${Math.round(score*100)}%</span>
  </div>`;
}

// ── Helper: broadcast a message to every open Facebook tab ────────────────────
async function broadcastToFacebookTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.facebook.com/*' });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  } catch(e) {}
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('tab-content--hidden'));
      document.getElementById('tab-' + target).classList.remove('tab-content--hidden');
    });
  });

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    settings.darkMode = !settings.darkMode;
    applySettings(); saveSettings(); renderList();
  });

  document.getElementById('activeToggle').addEventListener('change', e => {
    msg({ type:'SET_ACTIVE', value: e.target.checked }).catch(() => {});
  });

  // Autoplay toggle (only wired if the HTML element exists)
  const autoplayToggle = document.getElementById('autoplayToggle');
  if (autoplayToggle) {
    autoplayToggle.addEventListener('change', async () => {
      const on = autoplayToggle.checked;
      settings.autoplay = on;
      updateAutoplayNote(on);
      saveSettings();
      await chromeSet({ pav_autoplay: on });
      await broadcastToFacebookTabs({ type: 'SET_AUTOPLAY', value: on });
    });
  }

  // Grayscale toggle (HCI Feature 2)
  const grayscaleToggle = document.getElementById('settingGrayscale');
  if (grayscaleToggle) {
    grayscaleToggle.addEventListener('change', async () => {
      const on = grayscaleToggle.checked;
      settings.grayscale = on;
      saveSettings();
      await chromeSet({ pav_grayscale: on });
      await broadcastToFacebookTabs({ type: 'SET_GRAYSCALE', value: on });
    });
  }

  // Story autoplay toggle (HCI Feature 3)
  // UI label = "Disable Story Autoplay" → when checkbox is ON, autoplay is DISABLED.
  const storyAutoplayToggle = document.getElementById('settingStoryAutoplay');
  if (storyAutoplayToggle) {
    storyAutoplayToggle.addEventListener('change', async () => {
      const disabled = storyAutoplayToggle.checked;
      const allow    = !disabled;
      settings.storyAutoplay = allow;
      saveSettings();
      await chromeSet({ pav_story_autoplay: allow });
      await broadcastToFacebookTabs({ type: 'SET_STORY_AUTOPLAY', value: allow });
    });
  }

  document.querySelectorAll('.st-btn').forEach(b => {
    b.addEventListener('click', async () => {
      const ms = Number(b.dataset.hours) * 60 * 60 * 1000;
      try {
        await msg({ type: 'SET_SCROLL_LIMIT', value: ms });
        const status = await msg({ type: 'GET_SCROLL_STATUS' });
        renderScrollTimeUI(status);
      } catch(e) {}
    });
  });

  document.getElementById('stResetBtn').addEventListener('click', async () => {
    try {
      await msg({ type: 'RESET_SCROLL_SESSION' });
      const status = await msg({ type: 'GET_SCROLL_STATUS' });
      renderScrollTimeUI(status);
    } catch(e) {}
  });

  document.querySelectorAll('.filter-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    activeFilter = b.dataset.filter;
    renderList();
  }));

  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Clear all stored reactions?')) return;
    try { await msg({ type:'CLEAR_REACTIONS' }); } catch(e) {}
    allEntries = []; renderStats(); renderList();
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadReactions();
  });

  function bindSetting(id, key, extraFn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      applySettings();
      if (extraFn) extraFn();
      saveSettings();
      renderList();
    });
  }

  bindSetting('settingDarkMode',       'darkMode');
  bindSetting('settingCompact',        'compact');
  bindSetting('settingShowStats',      'showStats');
  bindSetting('settingShowScreenTime', 'showScreenTime');
  bindSetting('settingShowBadges',     'showBadges');
  bindSetting('settingShowBars',       'showBars');
  bindSetting('settingShowFlags',      'showFlags');
  bindSetting('settingShowText',       'showText');
  bindSetting('settingShowMethod',     'showMethod');
  bindSetting('settingShowMedia',      'showMedia');
  bindSetting('settingPageBadges',     'pageBadges', () => {
    msg({ type: 'SET_SETTING', key: 'pageBadges', value: settings.pageBadges }).catch(() => {});
  });
  bindSetting('settingShareOverlay',   'shareOverlay', () => {
    msg({ type: 'SET_SETTING', key: 'shareOverlay', value: settings.shareOverlay }).catch(() => {});
  });

  document.getElementById('settingMaxPosts').addEventListener('change', e => {
    settings.maxPosts = Number(e.target.value); saveSettings(); renderList();
  });
  document.getElementById('settingHighThresh').addEventListener('change', e => {
    settings.highThresh = Number(e.target.value); saveSettings();
  });
  document.getElementById('settingMedThresh').addEventListener('change', e => {
    settings.medThresh = Number(e.target.value); saveSettings();
  });

  document.getElementById('btnExportJSON').addEventListener('click', () => {
    if (!allEntries.length) { showActionMsg('No data to export yet.', 'err'); return; }
    const blob = new Blob([JSON.stringify(allEntries, null, 2)], {type:'application/json'});
    downloadBlob(blob, 'pause-verify-reactions.json');
    showActionMsg(`✅ Exported ${allEntries.length} entries as JSON`, 'ok');
  });

  document.getElementById('btnExportCSV').addEventListener('click', () => {
    if (!allEntries.length) { showActionMsg('No data to export yet.', 'err'); return; }
    const rows = [['Timestamp','Author','Reaction','Label','Score','Method','Flags','PostText']];
    allEntries.forEach(e => {
      rows.push([
        new Date(e.ts).toISOString(),
        e.post?.author || '',
        e.reaction || '',
        e.analysis?.label || '',
        e.analysis?.combined_score != null ? Math.round(e.analysis.combined_score * 100) + '%' : '',
        e.analysis?.method || '',
        (e.analysis?.flags || []).join('; '),
        (e.post?.text || '').replace(/"/g, '""').slice(0, 200),
      ]);
    });
    const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    downloadBlob(new Blob([csv], {type:'text/csv'}), 'pause-verify-reactions.csv');
    showActionMsg(`✅ Exported ${allEntries.length} entries as CSV`, 'ok');
  });

  document.getElementById('btnResetSettings').addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    settings = { ...DEFAULT_SETTINGS };
    applySettings(); saveSettings(); renderList();
    // Also reset the HCI feature toggles that live in their own storage keys
    try {
      await chromeSet({
        pav_autoplay:        DEFAULT_SETTINGS.autoplay,
        pav_grayscale:       DEFAULT_SETTINGS.grayscale,
        pav_story_autoplay:  DEFAULT_SETTINGS.storyAutoplay,
      });
      await broadcastToFacebookTabs({ type: 'SET_AUTOPLAY',       value: DEFAULT_SETTINGS.autoplay });
      await broadcastToFacebookTabs({ type: 'SET_GRAYSCALE',      value: DEFAULT_SETTINGS.grayscale });
      await broadcastToFacebookTabs({ type: 'SET_STORY_AUTOPLAY', value: DEFAULT_SETTINGS.storyAutoplay });
    } catch(e) {}
    updateAutoplayNote(DEFAULT_SETTINGS.autoplay);
    const apToggle = document.getElementById('autoplayToggle');
    if (apToggle) apToggle.checked = DEFAULT_SETTINGS.autoplay;
    showActionMsg('✅ Settings restored to defaults', 'ok');
  });

  document.getElementById('btnClearData').addEventListener('click', async () => {
    if (!confirm('Delete ALL tracked reactions? This cannot be undone.')) return;
    try { await msg({ type:'CLEAR_REACTIONS' }); } catch(e) {}
    allEntries = []; renderStats(); renderList();
    showActionMsg('🗑 All reaction data cleared', 'ok');
  });
}

function showActionMsg(text, type) {
  const el = document.getElementById('actionMsg');
  if (!el) return;
  el.textContent = text;
  el.className = 'action-msg action-msg--' + type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

// ── Chrome Storage helpers ────────────────────────────────────────────────────
function chromeGet(keys) {
  return new Promise((res, rej) => {
    if (!chrome?.storage?.local) return rej(new Error('no storage'));
    chrome.storage.local.get(keys, r => {
      if (chrome.runtime.lastError) rej(chrome.runtime.lastError); else res(r);
    });
  });
}
function chromeSet(obj) {
  return new Promise((res, rej) => {
    if (!chrome?.storage?.local) return rej(new Error('no storage'));
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) rej(chrome.runtime.lastError); else res();
    });
  });
}

// ── msg() — sends to background, retries once if service worker was sleeping ──
function msg(obj) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage(obj, r => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        // Service worker was inactive — wait briefly and retry once
        if (errMsg.includes('receiving end does not exist') || errMsg.includes('Could not establish')) {
          setTimeout(() => {
            chrome.runtime.sendMessage(obj, r2 => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
              else res(r2);
            });
          }, 300);
        } else {
          rej(new Error(errMsg));
        }
      } else {
        res(r);
      }
    });
  });
}

function ago(ts) {
  const s=Math.floor((Date.now()-ts)/1000);
  return s<60?'just now':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d';
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
