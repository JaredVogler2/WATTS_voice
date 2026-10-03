// WATTS Voice — app controller (views, live study loop, review, exports).

import {
  addSegment, clockEnd, completeStudy, createStudy, currentSegment, deriveSegments, displayName,
  elementAtTime, getSegment, isPaused, lastCreatedSegment, MECHANIC_ROLES, moveSegmentStart,
  needsReviewCount, noteGap, observedMs, OTHER_ID, pauseStudy, removeSegment, resumeStudy,
  segmentAt, toWattsPayload, totals, updateSegment,
} from './model.js';
import { buildMatcher, parseCommand } from './matcher.js';
import {
  deletePhoto, deleteStudy, getPhoto, getPhotosForStudy, isPersistentStorage, kvGet, kvSet,
  listStudies, requestPersistence, savePhoto, saveStudy,
} from './store.js';
import { BrowserEngine, ServerEngine, browserSpeechSupported, serverCaptureSupported } from './speech.js';
import { LiveCamera, liveCameraSupported, readExifTime, resizeImage } from './camera.js';
import { Timeline } from './timeline.js';
import {
  buildPackage, buildPhotosZip, elementsCsv, photoFileNames, shareFiles, shareOrDownload, studyFolderName,
} from './export.js';
import { clamp, debounce, esc, fmtClock, fmtDuration, fmtElapsed, fmtMinutes, isoDate, uid } from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULT_SETTINGS = {
  engine: 'auto', listenMode: 'continuous', lang: 'en-US', latencyMs: 400,
  aiMapping: true, aiVerify: false, accessCode: '', cameraOnStart: true,
};

const app = {
  catalog: null, idx: {}, matcher: null,
  config: { llm: { enabled: false }, stt: { enabled: false }, accessCodeRequired: false },
  settings: { ...DEFAULT_SETTINGS },
  studies: new Map(),       // id -> study (cache so resume can start the mic inside the tap)
  study: null, view: null,
  engine: null, micOn: false, micState: 'off',
  camera: null, nativeTapAt: null,
  tlLive: null, tlReview: null,
  thumbUrls: new Map(),
  wakeLock: null, tickTimer: null, hiddenAt: null,
  reviewTab: 'sequence',
};

// ═══════════════════════════ Utilities ═══════════════════════════════════
const persistDebounced = debounce((study) => {
  saveStudy(study).catch(err => toast(`Could not save: ${err.message}`, 'bad'));
}, 400);
function persist(study = app.study) { if (study) persistDebounced(study); }
async function persistNow(study = app.study) {
  if (!study) return;
  persistDebounced.flush(study);
  await saveStudy(study).catch(err => toast(`Could not save: ${err.message}`, 'bad'));
}

function leanColor(type) { return app.catalog?.leanTypes?.[type]?.color || '#888'; }
function leanLabel(type) { return app.catalog?.leanTypes?.[type]?.label || type; }
function elInfo(id) { return app.idx[id] || { name: id, type: 'NVAW', category: '' }; }

function show(view) {
  for (const v of ['home', 'live', 'review']) $(`#view-${v}`).hidden = v !== view;
  app.view = view;
  // Keep toasts clear of the live timeline.
  const tl = view === 'live' ? $('#view-live .tl-panel') : null;
  document.documentElement.style.setProperty('--toast-bottom', tl ? `${tl.offsetHeight + 10}px` : '18px');
  window.scrollTo(0, 0);
}

function toast(msg, kind = 'info', { action, onAction, ms = 3800, color } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  const colors = { info: '#6694CC', ok: '#1f9d55', warn: '#f0a92e', bad: '#d63447' };
  el.style.setProperty('--c', color || colors[kind] || colors.info);
  el.innerHTML = `<span class="grow">${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  const tl = app.view === 'live' ? $('#view-live .tl-panel') : null;
  document.documentElement.style.setProperty('--toast-bottom', tl ? `${tl.offsetHeight + 10}px` : '18px');
  if (action) el.querySelector('button').onclick = () => { el.remove(); onAction && onAction(); };
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

function confirmDialog(title, text, okLabel = 'OK') {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

async function apiGet(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {};
  if (app.settings.accessCode) headers['X-Access-Code'] = app.settings.accessCode;
  let opts;
  if (body instanceof FormData) opts = { method: 'POST', body, headers };
  else opts = { method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'Content-Type': 'application/json' } };
  try {
    const r = await fetch(path, { ...opts, signal: ctrl.signal });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('Access code required — set it in Settings');
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('wv.settings');
    if (raw) app.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) { /* private mode */ }
}
function saveSettings() {
  try { localStorage.setItem('wv.settings', JSON.stringify(app.settings)); } catch (_) { /* noop */ }
}

function aiAvailable() {
  return app.config.llm.enabled && app.settings.aiMapping && navigator.onLine;
}

function engineKind() {
  const s = app.settings.engine;
  if (s === 'off') return 'off';
  if (s === 'browser') return browserSpeechSupported() ? 'browser' : 'off';
  if (s === 'server') return app.config.stt.enabled && serverCaptureSupported() ? 'server' : 'off';
  if (browserSpeechSupported()) return 'browser';
  if (app.config.stt.enabled && serverCaptureSupported()) return 'server';
  return 'off';
}

async function setThumb(photoId, blob) {
  if (app.thumbUrls.has(photoId)) URL.revokeObjectURL(app.thumbUrls.get(photoId));
  const url = URL.createObjectURL(blob);
  app.thumbUrls.set(photoId, url);
  app.tlLive && app.tlLive.setThumbUrl(photoId, url);
  app.tlReview && app.tlReview.setThumbUrl(photoId, url);
}

async function loadThumbs(study) {
  for (const url of app.thumbUrls.values()) URL.revokeObjectURL(url);
  app.thumbUrls.clear();
  const recs = await getPhotosForStudy(study.id);
  for (const r of recs) if (r.thumb) await setThumb(r.id, r.thumb);
}

// ═══════════════════════════ Boot ════════════════════════════════════════
async function boot() {
  loadSettings();
  try {
    app.catalog = await apiGet('api/catalog');
    kvSet('catalog', app.catalog).catch(() => {});
  } catch (e) {
    app.catalog = await kvGet('catalog').catch(() => null);
    if (!app.catalog) {
      document.body.innerHTML = `<div style="padding:30px;font:16px system-ui">
        <h2>WATTS Voice could not load the standard element catalog.</h2>
        <p>Connect to the network once so the app can download it, then reload.</p><p>${esc(e.message)}</p></div>`;
      return;
    }
    toast('Offline — using the cached element catalog', 'warn');
  }
  try { app.config = await apiGet('api/config'); } catch (_) { /* offline: AI off */ }
  app.matcher = buildMatcher(app.catalog);
  for (const el of app.matcher.elements) app.idx[el.id] = el;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  requestPersistence();

  bindHome();
  bindLive();
  bindReview();
  bindDialogs();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => { persistNow(); });
  window.addEventListener('online', () => renderChips());
  window.addEventListener('offline', () => renderChips());
  await renderHome();
  show('home');
}

// ═══════════════════════════ Home ════════════════════════════════════════
function mechRowHtml(m = {}) {
  return `<div class="mech-row">
    <input placeholder="BEMSID" inputmode="numeric" data-k="bemsid" value="${esc(m.bemsid || '')}">
    <input placeholder="Name" data-k="name" value="${esc(m.name || '')}">
    <select data-k="role">${MECHANIC_ROLES.map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <select data-k="rating" title="Performance rating">${[80, 100, 120].map(v => `<option value="${v}" ${v === (m.rating || 100) ? 'selected' : ''}>${v}%</option>`).join('')}</select>
    <input placeholder="Assist min" inputmode="decimal" data-k="assistMins" value="${esc(m.assistMins ?? '')}" title="Partial assist minutes">
    <button type="button" class="icon-btn rm" aria-label="Remove mechanic">✕</button></div>`;
}

function bindHome() {
  const form = $('#setup-form');
  form.studyDate.value = isoDate();
  try {
    const last = JSON.parse(localStorage.getItem('wv.analyst') || '{}');
    if (last.bemsid) form.analystBemsid.value = last.bemsid;
    if (last.name) form.analystName.value = last.name;
  } catch (_) { /* noop */ }
  $('#mech-rows').innerHTML = mechRowHtml({ role: 'Primary Mechanic' });
  $('#btn-add-mech').onclick = () => $('#mech-rows').insertAdjacentHTML('beforeend', mechRowHtml({ role: 'Full Duration Assist' }));
  $('#mech-rows').addEventListener('click', e => { if (e.target.closest('.rm')) e.target.closest('.mech-row').remove(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const setup = Object.fromEntries(fd.entries());
    if (!setup.soi.trim() || !setup.line.trim()) { toast('SOI and line number are required', 'warn'); return; }
    setup.mechanics = $$('.mech-row').map(row => Object.fromEntries($$('[data-k]', row).map(i => [i.dataset.k, i.value])))
      .filter(m => m.bemsid || m.name);
    try { localStorage.setItem('wv.analyst', JSON.stringify({ bemsid: setup.analystBemsid, name: setup.analystName })); } catch (_) { /* noop */ }
    const study = createStudy(setup, { catalogVersion: app.catalog.version });
    app.studies.set(study.id, study);
    // Start mic + camera synchronously inside the tap: iOS only grants them to a user gesture.
    enterLive(study, { startDevices: true });
    persistNow(study);
  });

  const sf = $('#settings-form');
  for (const [k, v] of Object.entries(app.settings)) {
    const input = sf.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
  sf.addEventListener('change', () => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const input = sf.elements[k];
      if (!input) continue;
      app.settings[k] = input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? Number(input.value) || 0 : input.value;
    }
    saveSettings();
    renderChips();
    renderChecks();
  });

  $('#btn-test-mic').onclick = testMic;
  $('#btn-test-cam').onclick = testCamera;
  $('#study-list').addEventListener('click', onStudyListClick);
  $('#resume-banner').addEventListener('click', onStudyListClick);
}

function renderChips() {
  const chips = [];
  const kind = engineKind();
  chips.push(`<span class="chip ${kind === 'off' ? 'warn' : 'ok'}">Voice: ${kind === 'browser' ? 'iPhone / browser speech' : kind === 'server' ? 'server transcription' : 'off'}</span>`);
  chips.push(app.config.llm.enabled
    ? `<span class="chip ${app.settings.aiMapping ? 'ok' : 'off'}">AI mapping: ${esc(app.config.llm.model || app.config.llm.provider)}${app.settings.aiMapping ? '' : ' (off)'}</span>`
    : '<span class="chip off">AI mapping: off (on-device matcher)</span>');
  if (!navigator.onLine) chips.push('<span class="chip warn">Offline</span>');
  $('#status-chips').innerHTML = chips.join('');
}

function renderChecks() {
  const items = [];
  const row = (ok, title, detail = '') => items.push(`<div class="check-item"><span class="st">${ok === true ? '✅' : ok === false ? '⛔' : '⚠️'}</span><div><b>${title}</b>${detail ? `<div class="muted small">${detail}</div>` : ''}</div></div>`);
  row(window.isSecureContext, 'Secure (HTTPS) page', window.isSecureContext ? '' : 'Microphone and camera only work over HTTPS (or localhost).');
  if (browserSpeechSupported()) {
    row(true, 'Speech recognition available', 'iPhone: requires Siri &amp; Dictation to be enabled (Settings › General › Keyboard › Enable Dictation). Managed iPhones that block Siri also block this — use server transcription instead.');
  } else if (app.config.stt.enabled) {
    row(null, 'No built-in speech recognition', 'Server transcription will be used.');
  } else {
    row(false, 'No speech recognition', 'Narration can still be typed (the iPhone keyboard mic works too) or tapped from the element list.');
  }
  row(liveCameraSupported(), 'Live camera', liveCameraSupported() ? 'Photos are time-stamped at the shutter.' : 'Only the native camera is available.');
  row(isPersistentStorage(), 'On-device storage', 'Studies and photos stay on this device until exported.');
  row('wakeLock' in navigator ? true : null, 'Keep screen awake', 'wakeLock' in navigator ? '' : 'Set Auto-Lock to Never while studying (Settings › Display & Brightness).');
  row(app.config.llm.enabled ? true : null, 'AI element mapping',
    app.config.llm.enabled ? `${esc(app.config.llm.provider)} · ${esc(app.config.llm.model)}` : 'Not configured on the server — the on-device matcher still maps clear narration.');
  $('#checks').innerHTML = items.join('');
  $('#about-text').textContent = `Catalog ${app.catalog.version} · ${app.matcher.elements.length} standard elements · ${navigator.userAgent}`;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

async function renderHome() {
  renderChips();
  renderChecks();
  // Safari may clear a website's stored data after 7 days without use; Home
  // Screen apps keep theirs.
  $('#keep-banner').hidden = !(isIOS() && !isStandalone());
  const studies = await listStudies().catch(() => []);
  app.studies = new Map(studies.map(s => [s.id, s]));
  const live = studies.find(s => s.status === 'live' || s.status === 'paused');
  const banner = $('#resume-banner');
  if (live) {
    banner.hidden = false;
    banner.innerHTML = `<div><b>Study in progress:</b> SOI ${esc(live.setup.soi)} · Line ${esc(live.setup.line)} — started ${esc(fmtClock(live.startedAt, false))}</div>
      <button class="btn primary" data-open="${live.id}">▶ Resume study</button>`;
  } else banner.hidden = true;
  $('#study-list').innerHTML = studies.length ? studies.map(s => {
    const flags = needsReviewCount(s);
    const saved = (s.exports || []).some(x => x.kind === 'folder' || x.kind === 'email');
    const badge = s.status === 'complete'
      ? (flags ? `<span class="badge review">${flags} to review</span>` : '<span class="badge">Complete</span>')
        + (s.photos.length && !saved ? '<span class="badge review">Photos not saved yet</span>' : saved ? '<span class="badge">Saved</span>' : '')
      : `<span class="badge live">${s.status === 'paused' ? 'Paused' : 'In progress'}</span>`;
    return `<div class="study-item">
      <div class="grow"><div class="t">SOI ${esc(s.setup.soi)} · Line ${esc(s.setup.line)}</div>
      <div class="s">${esc(s.setup.studyDate)} · ${fmtElapsed(observedMs(s), { forceHours: true })} · ${s.segments.length} elements · ${s.photos.length} photos${s.setup.task ? ' · ' + esc(s.setup.task) : ''}</div></div>
      ${badge}<button class="btn small" data-open="${s.id}">Open</button>
      <button class="icon-btn" data-del="${s.id}" aria-label="Delete study" title="Delete">🗑</button></div>`;
  }).join('') : '<div class="empty">No studies yet.</div>';
}

async function onStudyListClick(e) {
  const open = e.target.closest('[data-open]');
  const del = e.target.closest('[data-del]');
  if (open) {
    const study = app.studies.get(open.dataset.open);
    if (!study) return;
    if (study.status === 'complete') enterReview(study);
    else enterLive(study, { startDevices: true, resumed: true });
  } else if (del) {
    const study = app.studies.get(del.dataset.del);
    if (!study) return;
    const ok = await confirmDialog('Delete study?', `SOI ${study.setup.soi} Line ${study.setup.line} and its ${study.photos.length} photos will be removed from this device. Export it first if you need it.`, 'Delete');
    if (!ok) return;
    await deleteStudy(study.id);
    renderHome();
  }
}

// Device tests ──────────────────────────────────────────────────────────────
let testEngine = null, testCam = null;
function testMic() {
  const out = $('#test-output');
  out.hidden = false;
  if (testEngine) { testEngine.stop(); testEngine = null; $('#btn-test-mic').textContent = 'Test microphone & speech'; return; }
  const kind = engineKind();
  if (kind === 'off') { out.textContent = 'No speech engine available. You can still type narration or tap elements.'; return; }
  out.innerHTML = 'Listening… say something like <b>“installing clecos”</b> or <b>“waiting for QA”</b>.';
  const onUtterance = (u) => {
    const m = app.matcher.match(u.text);
    const cmd = parseCommand(u.text);
    const label = cmd ? `command: ${cmd.command}` : m.top ? `${m.top.id} ${elInfo(m.top.id).name} (${Math.round(m.top.score * 100)}%, ${m.decision})` : 'no on-device match (AI would be asked)';
    out.innerHTML = `Heard: <b>“${esc(u.text)}”</b><br>→ ${esc(label)}`;
  };
  const opts = { lang: app.settings.lang, onUtterance, onInterim: t => { if (t) out.innerHTML = `Hearing: <i>${esc(t)}</i>`; },
    onState: (s, msg) => { if (s === 'error') out.textContent = msg; } };
  testEngine = kind === 'browser' ? new BrowserEngine(opts) : new ServerEngine({ ...opts, transcribe: transcribeBlob });
  Promise.resolve(testEngine.start()).catch(err => { out.textContent = err.message; testEngine = null; });
  $('#btn-test-mic').textContent = 'Stop test';
}

async function testCamera() {
  const v = $('#test-video');
  if (testCam) { testCam.stop(); testCam = null; v.hidden = true; $('#btn-test-cam').textContent = 'Test camera'; return; }
  testCam = new LiveCamera(v);
  try {
    v.hidden = false;
    await testCam.start();
    $('#btn-test-cam').textContent = 'Stop camera';
  } catch (e) {
    v.hidden = true; testCam = null;
    $('#test-output').hidden = false;
    $('#test-output').textContent = `Camera unavailable: ${e.message}`;
  }
}

// ═══════════════════════════ Live study ══════════════════════════════════
function bindLive() {
  app.camera = new LiveCamera($('#cam-video'));
  app.camera.onEnded = () => renderCamera();
  app.tlLive = new Timeline($('#live-timeline'), {
    onSegment: id => openSegment(id),
    onPhoto: id => openPhoto(id),
    onNote: id => { const n = app.study.notes.find(x => x.id === id); if (n) toast(`Note at ${fmtElapsed(n.t - app.study.startedAt)}: ${n.text}`); },
    onFollowChange: on => $('#btn-follow').classList.toggle('on', on),
  });
  bindTimelineTools($('#view-live .tl-panel'), () => app.tlLive);
  $('#btn-follow').classList.add('on');
  $('#btn-follow').onclick = () => app.tlLive.setFollow(true);

  $('#btn-live-home').onclick = leaveLive;
  $('#btn-pause').onclick = () => togglePause();
  $('#btn-resume').onclick = () => togglePause(false);
  $('#btn-complete').onclick = openComplete;
  $('#btn-mic').onclick = () => (app.micOn ? stopMic() : startMic());
  $('#btn-cur-edit').onclick = () => { const s = currentSegment(app.study); if (s) openSegment(s.id); else openBrowse(); };
  $('#btn-browse').onclick = openBrowse;
  $('#btn-review-flags').onclick = () => {
    const s = app.study.segments.find(x => x.needsReview && !x.reviewed);
    if (s) openSegment(s.id);
  };

  // Typed narration: the element starts when the analyst started typing.
  const input = $('#type-input');
  let typingSince = null;
  input.addEventListener('input', () => { if (input.value && !typingSince) typingSince = Date.now(); if (!input.value) typingSince = null; });
  $('#type-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    handleUtterance({ t: typingSince || Date.now(), text, engine: 'typed' }, 'typed');
    input.value = ''; typingSince = null;
  });
  // iOS scrolls the (overflow-hidden) live screen to show the keyboard; put the
  // current element back on top afterwards.
  input.addEventListener('blur', () => setTimeout(() => { $('.live-main').scrollTop = 0; }, 150));

  // Push-to-talk
  const ptt = $('#btn-ptt');
  const down = (e) => { e.preventDefault(); ptt.classList.add('down'); ensureEngine(); app.engine && app.engine.pttDown(); };
  const up = () => { if (!ptt.classList.contains('down')) return; ptt.classList.remove('down'); app.engine && app.engine.pttUp(); };
  ptt.addEventListener('pointerdown', down);
  ptt.addEventListener('pointerup', up);
  ptt.addEventListener('pointercancel', up);
  ptt.addEventListener('pointerleave', up);
  ptt.addEventListener('contextmenu', e => e.preventDefault());

  // Camera
  $('#btn-cam-on').onclick = () => startCamera();
  $('#btn-cam-off').onclick = () => { app.camera.stop(); renderCamera(); };
  $('#btn-cam-flip').onclick = () => app.camera.flip().then(renderCamera).catch(e => toast(e.message, 'bad'));
  $('#btn-shutter').onclick = () => takePhoto();
  const native = $('#native-photo');
  native.closest('label').addEventListener('pointerdown', () => { app.nativeTapAt = Date.now(); });
  native.addEventListener('change', async () => {
    const file = native.files && native.files[0];
    native.value = '';
    if (file) await addNativePhoto(file, app.nativeTapAt || Date.now());
  });
  $('#last-thumb').onclick = () => { const p = app.study.photos[app.study.photos.length - 1]; if (p) openPhoto(p.id); };
}

function bindTimelineTools(root, getTl) {
  root.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-tlmode]');
    if (mode) {
      $$('[data-tlmode]', root).forEach(b => b.classList.toggle('on', b === mode));
      getTl().setMode(mode.dataset.tlmode);
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) getTl().zoomStep(Number(zoom.dataset.zoom));
    if (e.target.closest('[data-fit]')) getTl().fit();
  });
}

function renderLegend(el) {
  el.innerHTML = Object.entries(app.catalog.leanTypes).map(([k, v]) =>
    `<span title="${esc(v.description)}"><i style="background:${v.color}"></i>${esc(k)} ${esc(v.label.replace(/^Non-Value Added - /, 'NVA ').replace('Value Added', 'VA'))}</span>`).join('')
    + '<span><i class="rv"></i>Needs review</span>';
}

function enterLive(study, { startDevices = false, resumed = false } = {}) {
  app.study = study;
  const now = Date.now();
  if (resumed && study.lastSeenAt && now - study.lastSeenAt > 15000) {
    noteGap(study, study.lastSeenAt, now, 'App closed');
    toast(`Resumed. ${fmtElapsed(now - study.lastSeenAt)} passed with the app closed — the element that was running continued.`, 'warn', { ms: 6000 });
  }
  study.lastSeenAt = now;
  show('live');
  renderLegend($('#legend'));
  $('#live-soi').textContent = `SOI ${study.setup.soi} · L${study.setup.line}`;
  $('#live-tsid').textContent = `${study.tsId}${study.setup.task ? ' · ' + study.setup.task : ''}`;
  if (startDevices) {
    if (engineKind() !== 'off') startMic();
    if (app.settings.cameraOnStart && liveCameraSupported()) startCamera();
  }
  app.tlLive.data = null;   // re-fit for the new study
  loadThumbs(study).then(() => renderLive());
  renderLive();
  clearInterval(app.tickTimer);
  app.tickTimer = setInterval(tick, 250);
  acquireWakeLock();
}

async function leaveLive() {
  stopMic();
  app.camera.stop();
  clearInterval(app.tickTimer);
  releaseWakeLock();
  await persistNow();
  await renderHome();
  show('home');
}

function renderLive() {
  if (app.view !== 'live' || !app.study) return;
  renderCurrent();
  renderPauseState();
  renderFeed();
  renderCamera();
  renderPhotoInfo();
  app.tlLive.setData(timelineData(app.study, true));
  document.documentElement.style.setProperty('--toast-bottom', `${$('#view-live .tl-panel').offsetHeight + 10}px`);
}

function timelineData(study, live) {
  const now = Date.now();
  return {
    startedAt: study.startedAt, end: clockEnd(study, now), live: live && study.status !== 'complete',
    segments: deriveSegments(study, app.idx, now), photos: study.photos, notes: study.notes,
    pauses: study.pauses, gaps: study.gaps, lean: app.catalog.leanTypes,
    utteranceTimes: study.utterances.filter(u => u.status !== 'command' && u.status !== 'ignored').map(u => u.t),
  };
}

function renderCurrent() {
  const study = app.study;
  const seg = currentSegment(study);
  const card = $('#current-card');
  if (!seg) {
    $('#cur-band').style.background = '#444';
    $('#cur-code').textContent = ''; $('#cur-cat').textContent = '';
    $('#cur-lean').textContent = ''; $('#cur-lean').style.background = 'transparent';
    $('#cur-name').textContent = 'Narrate the first element…';
    $('#cur-source').textContent = 'e.g. “reading the work instructions”';
    return;
  }
  const el = elInfo(seg.elementId);
  $('#cur-band').style.background = leanColor(el.type);
  $('#cur-code').textContent = seg.elementId;
  $('#cur-cat').textContent = el.category;
  $('#cur-lean').textContent = el.type;
  $('#cur-lean').style.background = leanColor(el.type);
  $('#cur-name').textContent = displayName(seg, el);
  const conf = seg.confidence != null ? ` ${Math.round(seg.confidence * 100)}%` : '';
  const how = { local: 'on-device', ai: 'AI', 'local+ai': 'on-device + AI', manual: 'manual' }[seg.method] || seg.method;
  $('#cur-source').textContent = `${seg.source === 'tap' ? 'tapped' : seg.source} · ${how}${conf}${seg.pending ? ' · checking…' : ''}${seg.needsReview && !seg.reviewed ? ' · review' : ''}`;
  card.dataset.seg = seg.id;
}

function flashCurrent() {
  const c = $('#current-card');
  c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
}

function renderPauseState() {
  const paused = isPaused(app.study);
  $('#pause-overlay').hidden = !paused;
  $('#btn-pause').innerHTML = paused ? '▶ <span class="lbl">Resume</span>' : '⏸ <span class="lbl">Pause</span>';
  const pill = $('#rec-pill');
  pill.textContent = app.study.status === 'complete' ? 'DONE' : paused ? 'PAUSED' : '● REC';
  pill.className = 'rec-pill' + (paused ? ' paused' : app.study.status === 'complete' ? ' done' : '');
}

function renderFeed() {
  const study = app.study;
  const flags = needsReviewCount(study);
  const fb = $('#btn-review-flags');
  fb.hidden = !flags;
  fb.textContent = `${flags} to review ›`;
  const items = study.utterances.slice(-40).reverse().map(u => {
    const seg = u.segmentId ? getSegment(study, u.segmentId) : null;
    const tags = [];
    if (u.status === 'command') tags.push(`<span class="tag">command: ${esc(u.command)}</span>`);
    else if (u.status === 'note') tags.push('<span class="tag">note</span>');
    else if (u.status === 'ignored') tags.push('<span class="tag">ignored (paused)</span>');
    else if (u.status === 'undone') tags.push('<span class="tag bad">undone</span>');
    else if (u.status === 'unmatched') tags.push('<span class="tag bad">not matched — tap to assign</span>');
    if (seg) {
      const el = elInfo(seg.elementId);
      tags.push(`<span class="tag el" style="--c:${leanColor(el.type)}">${esc(seg.elementId)} ${esc(displayName(seg, el))}</span>`);
      if (seg.needsReview && !seg.reviewed) tags.push('<span class="tag review">review</span>');
    } else if (u.elementId && u.status === 'mapped') {
      tags.push(`<span class="tag">${esc(u.elementId)} (continued)</span>`);
    }
    if (u.aiStatus === 'pending') tags.push('<span class="tag pending">AI…</span>');
    else if (u.aiStatus === 'failed') tags.push('<span class="tag bad" title="' + esc(u.aiError || '') + '">AI unavailable</span>');
    return `<li data-utt="${u.id}"><span class="ft">${fmtElapsed(u.t - study.startedAt)}</span>
      <span class="fx">${esc(u.text)}</span><span class="fm">${tags.join('')}</span></li>`;
  });
  $('#feed').innerHTML = items.join('') || '<li class="muted" style="cursor:default">Narration appears here. Speak naturally: “he’s drilling the pilot holes”, “now waiting on QA”.</li>';
  $('#feed').onclick = (e) => {
    const li = e.target.closest('[data-utt]');
    if (!li) return;
    const u = study.utterances.find(x => x.id === li.dataset.utt);
    if (!u) return;
    if (u.segmentId && getSegment(study, u.segmentId)) openSegment(u.segmentId);
    else if (u.status !== 'command') assignUtterance(u.id);
  };
}

function renderCamera() {
  $('#cam').classList.toggle('on', app.camera.active);
}

function renderPhotoInfo() {
  const n = app.study.photos.length;
  $('#photo-count').textContent = n ? `${n} photo${n === 1 ? '' : 's'}` : 'No photos yet';
  const last = app.study.photos[n - 1];
  const img = $('#last-thumb');
  if (last && app.thumbUrls.get(last.id)) { img.src = app.thumbUrls.get(last.id); img.hidden = false; } else img.hidden = true;
}

function tick() {
  const study = app.study;
  if (!study || app.view !== 'live') return;
  const now = Date.now();
  $('#live-elapsed').textContent = fmtElapsed(observedMs(study, now));
  $('#live-wall').textContent = fmtClock(now);
  const seg = currentSegment(study);
  if (seg) {
    const d = deriveSegments(study, app.idx, now);
    $('#cur-timer').textContent = fmtElapsed(d[d.length - 1].netMs);
  } else $('#cur-timer').textContent = '00:00';
  if (!isPaused(study) && study.status !== 'complete') app.tlLive.tick(now);
  if (now - (study.lastSeenAt || 0) > 5000) { study.lastSeenAt = now; persist(); }
}

// ── Voice ────────────────────────────────────────────────────────────────────
async function transcribeBlob(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'speech.wav');
  const r = await apiPost('api/transcribe', fd, 30000);
  return r.text || '';
}

function ensureEngine() {
  if (app.engine) return app.engine;
  const kind = engineKind();
  if (kind === 'off') return null;
  const common = {
    lang: app.settings.lang,
    latencyMs: Number(app.settings.latencyMs) || 0,
    onUtterance: u => handleUtterance(u, 'voice'),
    onInterim: t => { $('#interim').textContent = t; },
    onState: onMicState,
    onLevel: l => { $('#mic-level').style.height = `${Math.round(l * 100)}%`; },
  };
  app.engine = kind === 'browser'
    ? new BrowserEngine(common)
    : new ServerEngine({ ...common, mode: app.settings.listenMode === 'ptt' ? 'ptt' : 'vad', transcribe: transcribeBlob });
  return app.engine;
}

function startMic() {
  const engine = ensureEngine();
  if (!engine) { toast('No speech engine available — type or tap elements instead.', 'warn'); return; }
  app.micOn = true;
  const ptt = app.settings.listenMode === 'ptt';
  $('#btn-ptt').hidden = !ptt;
  if (!ptt || engine.name === 'server') {
    Promise.resolve(engine.start()).catch(e => { app.micOn = false; onMicState('error', e.message); });
  } else onMicState('ptt');
  renderMic();
}

function stopMic() {
  app.micOn = false;
  if (app.engine) app.engine.stop();
  app.engine = null;
  $('#btn-ptt').hidden = true;
  $('#interim').textContent = '';
  renderMic();
}

let lastMicError = { msg: '', at: 0 };
function onMicState(state, msg) {
  app.micState = state;
  if (state === 'error' && msg) {
    const now = Date.now();
    if (msg !== lastMicError.msg || now - lastMicError.at > 15000) toast(msg, 'bad', { ms: 6000 });
    lastMicError = { msg, at: now };
    app.micErr = msg;
  } else if (state === 'listening') app.micErr = '';
  renderMic();
}

function renderMic() {
  const btn = $('#btn-mic');
  const ptt = app.settings.listenMode === 'ptt';
  btn.classList.toggle('on', app.micOn && app.micState === 'listening' && !ptt);
  btn.classList.toggle('err', app.micOn && app.micState === 'error');
  let text;
  if (!app.micOn) text = engineKind() === 'off' ? 'Voice off — type or tap elements' : 'Microphone off — tap to listen';
  else if (app.micState === 'error') text = 'Voice problem — tap mic to retry';
  else if (ptt) text = 'Hold “Hold to talk” while you narrate';
  else if (app.micState === 'restarting') text = 'Listening…';
  else text = app.engine && app.engine.name === 'server' ? 'Listening (server transcription)…' : 'Listening…';
  $('#voice-state').textContent = text;
}

function contextFor(study, utt) {
  // Element running just before this utterance (ignoring its own provisional boundary).
  const cur = study.segments.filter(s => s.t <= utt.t && s.utteranceId !== utt.id).pop();
  const recent = study.utterances.filter(u => u.t < utt.t && u.status !== 'command').slice(-4).map(u => u.text);
  return {
    current_element_id: cur ? cur.elementId : null,
    task_description: study.setup.task,
    recent,
    speech_alternatives: utt.alternatives || [],
  };
}

function handleUtterance(u, source = 'voice') {
  const study = app.study;
  if (!study || study.status === 'complete' || !u.text || !u.text.trim()) return;
  const now = Date.now();
  const utt = {
    id: uid('ut_'), t: clamp(u.t ?? now, study.startedAt, now), text: u.text.trim(), engine: u.engine || source,
    source, speechConfidence: u.confidence ?? null, alternatives: u.alternatives || [],
    status: 'pending', segmentId: null, createdAt: now,
  };
  study.utterances.push(utt);

  const cmd = parseCommand(utt.text);
  if (cmd) {
    utt.status = 'command'; utt.command = cmd.command;
    runCommand(cmd, utt);
    persist(); renderLive();
    return;
  }
  if (isPaused(study)) {
    utt.status = 'ignored';
    toast('Study is paused — say “resume” to continue timing', 'warn');
    persist(); renderFeed();
    return;
  }

  const m = app.matcher.match(utt.text);
  utt.local = { decision: m.decision, top: m.top ? { id: m.top.id, score: m.top.score } : null };
  const alts = m.candidates.slice(1, 4).map(c => c.id);
  const ai = aiAvailable();
  if (m.decision === 'auto') {
    applyElement(utt, m.top.id, { method: 'local', confidence: m.top.score, alternatives: alts });
    if (ai && app.settings.aiVerify) askAi(study, utt, { verify: true });
  } else if (ai) {
    if (m.decision === 'tentative') {
      applyElement(utt, m.top.id, { method: 'local', confidence: m.top.score, alternatives: alts, pending: true });
    }
    askAi(study, utt);
  } else if (m.decision === 'tentative') {
    applyElement(utt, m.top.id, { method: 'local', confidence: m.top.score, alternatives: alts, needsReview: true });
  } else {
    markUnmatched(utt);
  }
  persist();
  renderLive();
}

function markUnmatched(utt) {
  utt.status = 'unmatched';
  toast(`Not matched: “${utt.text}”`, 'warn', { action: 'Assign', onAction: () => assignUtterance(utt.id), ms: 6000 });
}

function applyElement(utt, elementId, { method, confidence = null, alternatives = [], pending = false, needsReview = false, label = '' }) {
  const study = app.study;
  const source = utt.source === 'typed' ? 'typed' : utt.source === 'tap' ? 'tap' : 'voice';
  const r = addSegment(study, { t: utt.t, elementId, label, source, method, confidence, alternatives,
    needsReview: needsReview || (elementId === OTHER_ID && !label), utteranceId: utt.id, pending });
  utt.segmentId = r.segment ? r.segment.id : null;
  utt.status = 'mapped';
  utt.elementId = elementId;
  if (r.created || r.replaced) flashCurrent();
  return r;
}

async function askAi(study, utt, { verify = false } = {}) {
  utt.aiStatus = 'pending';
  renderFeed();
  let decision;
  try {
    const res = await apiPost('api/interpret', { text: utt.text, context: contextFor(study, utt) });
    decision = res.decision;
  } catch (e) {
    if (app.study !== study) return;
    utt.aiStatus = 'failed'; utt.aiError = e.message;
    const seg = utt.segmentId ? getSegment(study, utt.segmentId) : null;
    if (seg && seg.pending) updateSegment(study, seg.id, { pending: false, needsReview: true });
    else if (!seg && !verify) markUnmatched(utt);
    persist(); renderLive();
    return;
  }
  if (app.study !== study) return;   // study closed meanwhile; never overwrite newer data
  utt.aiStatus = 'done';
  utt.ai = decision;
  applyAiDecision(study, utt, decision, verify);
  persist();
  if (app.view === 'live') renderLive();
}

function applyAiDecision(study, utt, d, verify) {
  const seg = utt.segmentId ? getSegment(study, utt.segmentId) : null;
  const owns = !!seg && seg.utteranceId === utt.id;
  const lowConf = d.confidence < 0.6;
  if (verify) {
    if (d.intent === 'element' && d.element_id && seg && d.element_id !== seg.elementId && d.confidence >= 0.7) {
      const before = seg.elementId;
      updateSegment(study, seg.id, { elementId: d.element_id, label: d.other_description || '', method: 'ai',
        confidence: d.confidence, alternatives: [before, ...d.alternatives].slice(0, 3) });
      toast(`AI changed “${utt.text}” to ${d.element_id} ${elInfo(d.element_id).name}`, 'info', { action: 'Undo', onAction: () => {
        const s = getSegment(study, seg.id);
        if (s) { updateSegment(study, s.id, { elementId: before, method: 'manual' }); persist(); renderLive(); }
      } });
      utt.elementId = d.element_id;
    } else if (d.intent === 'element' && seg && d.element_id === seg.elementId) {
      updateSegment(study, seg.id, { method: 'local+ai', confidence: Math.max(seg.confidence || 0, d.confidence) });
    } else if (seg && (d.intent === 'unclear' || d.intent === 'note')) {
      updateSegment(study, seg.id, { needsReview: true });
    }
    return;
  }
  switch (d.intent) {
    case 'same_element': {
      if (owns) removeSegment(study, seg.id);
      const cur = segmentAt(study, utt.t);
      utt.segmentId = cur ? cur.id : null;
      utt.elementId = cur ? cur.elementId : null;
      utt.status = cur ? 'mapped' : 'unmatched';
      break;
    }
    case 'element': {
      const label = d.element_id === OTHER_ID ? d.other_description : '';
      if (owns) {
        updateSegment(study, seg.id, { elementId: d.element_id, label, pending: false,
          method: seg.elementId === d.element_id ? 'local+ai' : 'ai', confidence: d.confidence,
          alternatives: d.alternatives, needsReview: lowConf || (d.element_id === OTHER_ID && !label) });
        const now = getSegment(study, seg.id) || segmentAt(study, utt.t);
        utt.segmentId = now ? now.id : null;
        utt.elementId = d.element_id;
        utt.status = 'mapped';
      } else if (seg && seg.elementId === d.element_id) {
        utt.status = 'mapped';
      } else {
        applyElement(utt, d.element_id, { method: 'ai', confidence: d.confidence, alternatives: d.alternatives,
          needsReview: lowConf, label });
      }
      break;
    }
    case 'note':
      if (owns) removeSegment(study, seg.id);
      addNote(study, utt.t, d.note || utt.text, utt.id);
      utt.status = 'note'; utt.segmentId = null;
      break;
    case 'command':
      if (owns) removeSegment(study, seg.id);
      utt.status = 'command'; utt.command = d.command; utt.segmentId = null;
      runCommand({ command: d.command }, utt);
      break;
    default:
      if (owns) updateSegment(study, seg.id, { pending: false, needsReview: true });
      else markUnmatched(utt);
  }
}

function addNote(study, t, text, utteranceId = null) {
  study.notes.push({ id: uid('nt_'), t, text, utteranceId });
  study.notes.sort((a, b) => a.t - b.t);
}

function runCommand(cmd, utt) {
  const study = app.study;
  switch (cmd.command) {
    case 'pause':
      if (pauseStudy(study, utt ? utt.t : Date.now())) toast('Paused — say “resume” to continue', 'warn');
      break;
    case 'resume':
      if (resumeStudy(study, Math.max(utt ? utt.t : Date.now(), study.pauses.at(-1)?.start || 0))) toast('Resumed', 'ok');
      break;
    case 'undo': {
      const seg = lastCreatedSegment(study);
      if (!seg || Date.now() - seg.createdAt > 10 * 60000) { toast('Nothing recent to undo', 'warn'); break; }
      const name = displayName(seg, elInfo(seg.elementId));
      removeSegment(study, seg.id);
      study.utterances.filter(u => u.segmentId === seg.id).forEach(u => { u.status = 'undone'; u.segmentId = null; });
      toast(`Removed ${name}`, 'info');
      break;
    }
    case 'photo':
      takePhoto({ caption: cmd.caption || '' });
      break;
    case 'note':
      addNote(study, utt ? utt.t : Date.now(), cmd.note || '', utt ? utt.id : null);
      toast('Note added', 'ok');
      break;
    case 'complete':
      openComplete();
      break;
    default: break;
  }
  renderLive();
}

function togglePause(force) {
  const study = app.study;
  const paused = isPaused(study);
  if (force === false || paused) resumeStudy(study, Date.now());
  else pauseStudy(study, Date.now());
  persist();
  renderLive();
}

// ── Element picker (browse / assign / change) ─────────────────────────────────
let pickerCb = null;
function openPicker({ title = 'Standard elements', selected = null, onPick }) {
  pickerCb = onPick;
  $('#picker-title').textContent = title;
  $('#picker-search').value = '';
  $('#picker-other').hidden = true;
  renderPicker('', selected);
  $('#dlg-picker').showModal();
}

function renderPicker(query, selected) {
  const body = $('#picker-body');
  const elBtn = el => `<button type="button" class="pk-el${el.id === selected ? ' sel' : ''}" data-el="${el.id}" style="--c:${leanColor(el.type)}">
      <b>${esc(el.name)}</b><span>${esc(el.id)} · ${esc(el.type)}</span></button>`;
  if (query.trim()) {
    const hits = app.matcher.search(query);
    body.innerHTML = hits.length ? `<div class="pk-grid">${hits.map(h => elBtn(app.idx[h.id])).join('')}</div>`
      : `<div class="empty">No standard element matches “${esc(query)}”. Use <b>Other</b> (Rework/Other) and describe it.</div>`;
    return;
  }
  body.innerHTML = app.catalog.categories.map(cat => `<div class="pk-cat"><h4>${esc(cat.name)}</h4>
    <div class="pk-grid">${cat.elements.map(e => elBtn(app.idx[e.id])).join('')}</div></div>`).join('');
}

function openBrowse() {
  const t = Date.now();   // the change happened when the analyst reached for the list
  openPicker({ title: 'Start element now', onPick: (id, label) => {
    const study = app.study;
    if (!study || study.status === 'complete') return;
    const utt = { id: uid('ut_'), t: clamp(t, study.startedAt, Date.now()), text: `[tapped] ${label ? 'Other: ' + label : elInfo(id).name}`,
      engine: 'tap', source: 'tap', status: 'pending', segmentId: null, createdAt: Date.now() };
    study.utterances.push(utt);
    applyElement(utt, id, { method: 'manual', confidence: 1, label });
    persist(); renderLive();
  } });
}

function assignUtterance(uttId) {
  const study = app.study;
  const utt = study.utterances.find(u => u.id === uttId);
  if (!utt) return;
  openPicker({ title: `Assign “${utt.text}”`, onPick: (id, label) => {
    applyElement(utt, id, { method: 'manual', confidence: 1, label });
    persist();
    app.view === 'live' ? renderLive() : renderReview();
  } });
}

// ── Segment editor ─────────────────────────────────────────────────────────
function openSegment(id) {
  renderSegmentEditor(id);
  const dlg = $('#dlg-segment');
  if (!dlg.open) dlg.showModal();
}

function afterEdit() {
  persist();
  if (app.view === 'live') renderLive(); else renderReview();
}

function renderSegmentEditor(id) {
  const study = app.study;
  const derived = deriveSegments(study, app.idx);
  const s = derived.find(x => x.id === id);
  const body = $('#seg-body');
  if (!s) { $('#dlg-segment').close(); return; }
  const narration = study.utterances.filter(u => u.segmentId === s.id);
  const ai = narration.map(u => u.ai).filter(Boolean).pop();
  const photos = study.photos.filter(p => p.t >= s.start && p.t < s.end);
  body.innerHTML = `
    <div class="seg-head" style="--c:${leanColor(s.type)}"><div>
      <div class="nm">${esc(s.name)}</div>
      <div class="muted">${esc(s.elementId)} · ${esc(s.category)} · <span class="lean" style="background:${leanColor(s.type)}">${esc(s.type)}</span> ${esc(leanLabel(s.type))}</div>
    </div></div>
    <div class="row wrap" style="margin-top:10px"><button type="button" class="btn primary" data-act="change">Change element</button>
      ${s.needsReview && !s.reviewed ? '<button type="button" class="btn" data-act="reviewed">✓ Mark reviewed</button>' : ''}</div>
    ${s.alternatives && s.alternatives.length ? `<div class="muted small" style="margin-top:10px">Other likely elements:</div><div class="alts">${s.alternatives.filter(a => app.idx[a]).map(a =>
      `<button type="button" class="alt" data-alt="${a}" style="--c:${leanColor(app.idx[a].type)}">${esc(a)} ${esc(app.idx[a].name)}</button>`).join('')}</div>` : ''}
    <dl class="kv">
      <dt>Start</dt><dd>${fmtElapsed(s.start - study.startedAt, { forceHours: true })} <span class="muted">(${fmtClock(s.start)})</span></dd>
      <dt>Duration</dt><dd>${fmtDuration(s.netMs)}${s.live ? ' <span class="muted">(running)</span>' : ''}${s.grossMs !== s.netMs ? ` <span class="muted">excl. ${fmtDuration(s.grossMs - s.netMs)} paused</span>` : ''}</dd>
      <dt>Captured by</dt><dd>${esc(s.source)} · ${esc(s.method)}${s.confidence != null ? ` · ${Math.round(s.confidence * 100)}%` : ''}</dd>
      ${narration.length ? `<dt>Narration</dt><dd>${narration.map(u => `“${esc(u.text)}”`).join('<br>')}</dd>` : ''}
      ${ai && ai.rationale ? `<dt>AI</dt><dd>${esc(ai.rationale)}</dd>` : ''}
      ${photos.length ? `<dt>Photos</dt><dd>${photos.length}</dd>` : ''}
    </dl>
    <div class="muted small">Move start</div>
    <div class="nudge">${[-10, -5, -1, 1, 5, 10].map(d => `<button type="button" class="btn small" data-nudge="${d}">${d > 0 ? '+' : ''}${d}s</button>`).join('')}</div>
    <div class="row wrap" style="margin-top:12px">
      <button type="button" class="btn" data-act="insert">＋ Insert element inside</button>
      <button type="button" class="btn danger" data-act="delete">Delete</button>
    </div>
    <p class="muted small">Deleting gives this time back to the previous element.</p>`;
  body.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const alt = e.target.closest('[data-alt]')?.dataset.alt;
    const nudge = e.target.closest('[data-nudge]')?.dataset.nudge;
    if (alt) {
      updateSegment(study, s.id, { elementId: alt, label: '', method: 'manual', confidence: 1, needsReview: false, reviewed: true,
        alternatives: [s.elementId, ...(s.alternatives || []).filter(a => a !== alt)].slice(0, 3) });
      afterEdit(); renderSegmentEditor(segmentAt(study, s.start)?.id);
    } else if (nudge) {
      moveSegmentStart(study, s.id, s.start + Number(nudge) * 1000);
      afterEdit(); renderSegmentEditor(s.id);
    } else if (act === 'reviewed') {
      updateSegment(study, s.id, { reviewed: true });
      afterEdit(); renderSegmentEditor(s.id);
    } else if (act === 'change') {
      $('#dlg-segment').close();
      openPicker({ title: `Change ${s.name}`, selected: s.elementId, onPick: (id, label) => {
        updateSegment(study, s.id, { elementId: id, label, method: 'manual', confidence: 1, needsReview: false, reviewed: true,
          alternatives: [s.elementId, ...(s.alternatives || [])].filter(a => a !== id).slice(0, 3) });
        afterEdit();
      } });
    } else if (act === 'insert') {
      const mid = s.start + (s.end - s.start) / 2;
      $('#dlg-segment').close();
      openPicker({ title: `Insert element at ${fmtElapsed(mid - study.startedAt)}`, onPick: (id, label) => {
        const r = addSegment(study, { t: mid, elementId: id, label, source: 'edit', method: 'manual', confidence: 1 });
        afterEdit();
        if (r.segment) openSegment(r.segment.id);
      } });
    } else if (act === 'delete') {
      removeSegment(study, s.id);
      study.utterances.filter(u => u.segmentId === s.id).forEach(u => { u.segmentId = null; u.status = 'unmatched'; });
      $('#dlg-segment').close();
      afterEdit();
    }
  };
}

// ── Photos ─────────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    await app.camera.start();
  } catch (e) {
    toast(`Camera unavailable: ${e.message}. Use “Native camera”.`, 'bad', { ms: 6000 });
  }
  renderCamera();
}

async function takePhoto({ caption = '' } = {}) {
  const study = app.study;
  if (!study) return;
  if (!app.camera.active) {
    toast('Camera is off — turn it on, or use Native camera', 'warn', { action: 'Turn on', onAction: startCamera });
    return;
  }
  const t = Date.now();
  const f = $('#flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  try {
    const shot = await app.camera.capture();
    await addPhoto(study, { ...shot, t, caption, source: 'live', timeSource: 'shutter' });
  } catch (e) {
    toast(`Photo failed: ${e.message}`, 'bad');
  }
}

/**
 * Decode any image Safari can read (HEIC included) and re-encode it as a
 * baseline JPEG, so every stored and exported photo opens anywhere.
 */
async function toJpeg(file) {
  try {
    return await resizeImage(file, 2048, 0.86);
  } catch (e) {
    throw new Error(`Could not read “${file.name || 'photo'}” (${file.type || 'unknown format'})`);
  }
}

async function addNativePhoto(file, tappedAt) {
  const study = app.study;
  const exif = await readExifTime(file);
  const now = Date.now();
  // Prefer the camera's own capture time when it is plausible for this tap.
  const useExif = exif && exif >= tappedAt - 10000 && exif <= now + 2000;
  try {
    const jpeg = await toJpeg(file);
    await addPhoto(study, { ...jpeg, t: useExif ? exif : tappedAt, caption: '', source: 'native', timeSource: useExif ? 'exif' : 'tap' });
  } catch (e) {
    toast(e.message, 'bad', { ms: 6000 });
  }
}

async function addPhoto(study, { blob, width, height, t, caption, source, timeSource }) {
  const id = uid('ph_');
  const thumb = (await resizeImage(blob, 320, 0.75)).blob;
  await savePhoto({ id, studyId: study.id, blob, thumb });
  study.photos.push({ id, t: clamp(t, study.startedAt, clockEnd(study)), caption, w: width, h: height, source, timeSource, createdAt: Date.now() });
  study.photos.sort((a, b) => a.t - b.t);
  await setThumb(id, thumb);
  await persistNow(study);
  const at = elementAtTime(study, app.idx, t);
  toast(`📷 Photo at ${fmtElapsed(t - study.startedAt)}${at ? ' · ' + at.name : ''}`, 'ok', { color: at ? leanColor(at.type) : undefined, ms: 2200 });
  if (app.view === 'live') renderLive(); else renderReview();
  return id;
}

async function openPhoto(id) {
  const study = app.study;
  const i = study.photos.findIndex(p => p.id === id);
  const p = study.photos[i];
  if (!p) return;
  const rec = await getPhoto(id);
  const url = rec ? URL.createObjectURL(rec.blob) : app.thumbUrls.get(id);
  const at = elementAtTime(study, app.idx, p.t);
  const near = study.utterances.filter(u => Math.abs(u.t - p.t) < 20000 && u.status !== 'command');
  $('#photo-title').textContent = `Photo ${i + 1} of ${study.photos.length} · ${fmtElapsed(p.t - study.startedAt, { forceHours: true })}`;
  $('#photo-body').innerHTML = `<div class="photo-view"><img src="${url}" alt=""></div>
    <div class="photo-meta">
      ${at ? `<span class="lean" style="background:${leanColor(at.type)}">${esc(at.type)}</span><b>${esc(at.name)}</b>` : '<span class="muted">Before the first element</span>'}
      <span class="muted">${fmtClock(p.t)} · ${p.timeSource === 'shutter' ? 'exact shutter time' : p.timeSource === 'exif' ? 'camera EXIF time' : 'time of tap'}</span>
    </div>
    <div class="fname">File name: ${esc(photoFileNames(study, app.idx)[p.id])}</div>
    ${near.length ? `<div class="muted small">Narration around this photo</div><ul class="transcript">${near.map(u => `<li>${fmtElapsed(u.t - study.startedAt)} — “${esc(u.text)}”</li>`).join('')}</ul>` : ''}
    <label>Caption <input id="photo-caption" value="${esc(p.caption || '')}" placeholder="What does this photo show?"></label>
    <div class="row wrap">
      <button type="button" class="btn" data-nav="-1" ${i === 0 ? 'disabled' : ''}>‹ Prev</button>
      <button type="button" class="btn" data-nav="1" ${i === study.photos.length - 1 ? 'disabled' : ''}>Next ›</button>
      ${at ? `<button type="button" class="btn" data-seg="${at.segment.id}">Open element</button>` : ''}
      <button type="button" class="btn danger" data-del>Delete photo</button>
    </div>`;
  const dlg = $('#dlg-photo');
  $('#photo-caption').onchange = (e) => { p.caption = e.target.value.trim(); persist(); };
  $('#photo-body').onclick = async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { const next = study.photos[i + Number(nav.dataset.nav)]; if (next) openPhoto(next.id); return; }
    const seg = e.target.closest('[data-seg]');
    if (seg) { dlg.close(); openSegment(seg.dataset.seg); return; }
    if (e.target.closest('[data-del]')) {
      dlg.close();
      if (!(await confirmDialog('Delete photo?', 'This photo will be removed from the study.', 'Delete'))) return;
      study.photos = study.photos.filter(x => x.id !== id);
      await deletePhoto(id);
      await persistNow(study);
      app.view === 'live' ? renderLive() : renderReview();
    }
  };
  dlg.addEventListener('close', () => { if (rec && url) URL.revokeObjectURL(url); }, { once: true });
  if (!dlg.open) dlg.showModal();
}

// ── Complete ───────────────────────────────────────────────────────────────
function openComplete() {
  const study = app.study;
  if (!study || study.status === 'complete') return;
  const flags = needsReviewCount(study);
  $('#complete-summary').innerHTML = `${study.segments.length} elements · ${study.photos.length} photos · observed ${fmtElapsed(observedMs(study), { forceHours: true })}`
    + (flags ? `<br><b>${flags}</b> element${flags === 1 ? '' : 's'} flagged for review — you can fix them on the next screen.` : '');
  $('#complete-notes').value = study.studyNotes || '';
  const dlg = $('#dlg-complete');
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
}

async function finishStudy() {
  const study = app.study;
  completeStudy(study, Date.now());
  study.studyNotes = $('#complete-notes').value.trim();
  stopMic();
  app.camera.stop();
  clearInterval(app.tickTimer);
  releaseWakeLock();
  await persistNow(study);
  enterReview(study);
}

// ── Wake lock & lifecycle ──────────────────────────────────────────────────
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !app.wakeLock) {
      app.wakeLock = await navigator.wakeLock.request('screen');
      app.wakeLock.addEventListener('release', () => { app.wakeLock = null; });
    }
  } catch (_) { /* denied (low power mode) */ }
}
function releaseWakeLock() {
  try { app.wakeLock && app.wakeLock.release(); } catch (_) { /* noop */ }
  app.wakeLock = null;
}

function onVisibility() {
  const study = app.study;
  if (document.visibilityState === 'hidden') {
    app.hiddenAt = Date.now();
    persistNow();
    return;
  }
  if (app.view !== 'live' || !study || study.status === 'complete') return;
  const now = Date.now();
  if (app.hiddenAt && now - app.hiddenAt > 5000) {
    noteGap(study, app.hiddenAt, now, 'App in background');
    toast(`Back after ${fmtElapsed(now - app.hiddenAt)} in the background — no narration was captured then.`, 'warn', { ms: 6000 });
  }
  app.hiddenAt = null;
  acquireWakeLock();
  // iOS stops the mic and camera in the background; restart what we can.
  if (app.micOn && app.engine && app.engine.name === 'browser') app.engine.start();
  if (app.micOn && app.engine && app.engine.name === 'server' && !app.engine.ctx) {
    stopMic();
    toast('Tap the microphone to resume listening', 'warn');
  }
  renderLive();
}

// ═══════════════════════════ Review ══════════════════════════════════════
function bindReview() {
  app.tlReview = new Timeline($('#review-timeline'), {
    onSegment: id => openSegment(id),
    onPhoto: id => openPhoto(id),
    onNote: id => { const n = app.study.notes.find(x => x.id === id); if (n) toast(n.text); },
  });
  app.tlReview.follow = false;
  bindTimelineTools($('#view-review .tl-card'), () => app.tlReview);
  $('#btn-review-home').onclick = async () => { await persistNow(); await renderHome(); show('home'); };
  $('#rv-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    app.reviewTab = b.dataset.tab;
    $$('#rv-tabs button').forEach(x => x.classList.toggle('on', x === b));
    renderReviewTab();
  };
  $('#btn-save-folder').onclick = saveStudyFolder;
  $('#btn-email-photos').onclick = emailPhotos;
  $('#btn-export-watts').onclick = () => {
    const s = app.study;
    const blob = new Blob([JSON.stringify(toWattsPayload(s, app.idx), null, 2)], { type: 'application/json' });
    runShare('watts-json', () => shareOrDownload(blob, `${studyFolderName(s)}_watts_import.json`), 'WATTS import file');
  };
  $('#btn-export-csv').onclick = () => {
    const s = app.study;
    const blob = new Blob(['﻿' + elementsCsv(s, app.idx)], { type: 'text/csv' });
    runShare('csv', () => shareOrDownload(blob, `${studyFolderName(s)}_elements.csv`), 'Elements CSV');
  };
  $('#import-photos').addEventListener('change', importPhotos);
}

async function enterReview(study) {
  app.study = study;
  show('review');
  renderLegend($('#rv-legend'));
  app.tlReview.data = null;
  await loadThumbs(study);
  renderReview();
}

function renderReview() {
  if (app.view !== 'review') return;
  const study = app.study;
  const tot = totals(study, app.idx);
  const s = study.setup;
  $('#rv-title').textContent = `SOI ${s.soi} · Line ${s.line}`;
  const last = (study.exports || []).filter(x => x.kind === 'folder' || x.kind === 'email').pop();
  $('#rv-sub').textContent = `${study.tsId} · ${s.studyDate} · ${s.analystName || ''} ${s.analystBemsid ? '(' + s.analystBemsid + ')' : ''}${s.task ? ' · ' + s.task : ''}`
    + (study.photos.length ? ` · photos folder ${studyFolderName(study)}` : '')
    + (last ? ` · photos last shared ${fmtClock(last.at, false)}` : ' · not saved off the phone yet');
  const obs = tot.observedMs || 1;
  const cards = [`<div class="mcard"><div class="k">Observed time</div><div class="v">${fmtElapsed(tot.observedMs, { forceHours: true })}</div>
    <div class="s">${study.segments.length} elements · ${study.photos.length} photos</div>
    <div class="stack">${Object.keys(app.catalog.leanTypes).map(k => `<div style="width:${100 * (tot.byType[k] || 0) / obs}%;background:${leanColor(k)}"></div>`).join('')}</div></div>`];
  for (const [k, v] of Object.entries(app.catalog.leanTypes)) {
    cards.push(`<div class="mcard" style="--c:${v.color}"><div class="k">${esc(v.label)}</div>
      <div class="v">${fmtMinutes(tot.byType[k] || 0, 1)} min</div><div class="s">${(100 * (tot.byType[k] || 0) / obs).toFixed(1)}%</div></div>`);
  }
  if (tot.unassignedMs > 1000) {
    cards.push(`<div class="mcard" style="--c:#bbb"><div class="k">Before first element</div><div class="v">${fmtMinutes(tot.unassignedMs, 1)} min</div><div class="s">not attributed</div></div>`);
  }
  $('#rv-cards').innerHTML = cards.join('');
  const flags = needsReviewCount(study);
  const unmatched = study.utterances.filter(u => u.status === 'unmatched').length;
  const fl = $('#rv-flags');
  fl.hidden = !flags && !unmatched;
  fl.innerHTML = `<span>${flags ? `<b>${flags}</b> element${flags === 1 ? '' : 's'} flagged for review (low-confidence mapping). ` : ''}${unmatched ? `<b>${unmatched}</b> narration${unmatched === 1 ? '' : 's'} not matched.` : ''}</span>
    <span class="row">${flags ? '<button class="btn small primary" data-next-flag>Review next</button>' : ''}${unmatched ? '<button class="btn small" data-tab-go="transcript">Show narration</button>' : ''}</span>`;
  fl.onclick = (e) => {
    if (e.target.closest('[data-next-flag]')) {
      const seg = study.segments.find(x => x.needsReview && !x.reviewed);
      if (seg) openSegment(seg.id);
    }
    if (e.target.closest('[data-tab-go]')) $(`#rv-tabs [data-tab="transcript"]`).click();
  };
  app.tlReview.setData(timelineData(study, false));
  renderReviewTab();
}

function renderReviewTab() {
  const study = app.study;
  const body = $('#rv-body');
  const tab = app.reviewTab;
  if (tab === 'sequence') {
    const segs = deriveSegments(study, app.idx);
    body.innerHTML = segs.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Start</th><th>Element</th>
      <th class="r">Duration</th><th class="hide-sm">Captured</th><th class="hide-sm">Narration</th></tr></thead><tbody>${segs.map(s => {
        const narr = study.utterances.filter(u => u.segmentId === s.id).map(u => u.text).join(' / ');
        return `<tr class="click" data-seg="${s.id}"><td>${s.seq}</td><td>${fmtElapsed(s.start - study.startedAt, { forceHours: true })}</td>
        <td><span class="dot" style="background:${leanColor(s.type)}"></span>${esc(s.name)}
        ${s.needsReview && !s.reviewed ? ' <span class="flag">⚑ review</span>' : ''}<div class="muted small">${esc(s.elementId)} · ${esc(s.type)}</div></td>
        <td class="r">${fmtDuration(s.netMs)}</td><td class="hide-sm">${esc(s.source)} · ${esc(s.method)}${s.confidence != null ? ` · ${Math.round(s.confidence * 100)}%` : ''}</td>
        <td class="hide-sm">${esc(narr)}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">No elements recorded.</div>';
  } else if (tab === 'totals') {
    const tot = totals(study, app.idx);
    const obs = tot.observedMs || 1;
    body.innerHTML = `<p class="muted small">Standardized element codes — every phrasing of the same activity rolls up to one row.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Element</th><th class="hide-sm">Category</th><th class="r">Count</th>
      <th class="r">Min</th><th class="r">%</th><th class="r hide-sm">Avg (s)</th></tr></thead><tbody>${tot.byElement.map(e => `<tr>
      <td><span class="dot" style="background:${leanColor(e.type)}"></span>${esc(e.name)}<div class="muted small">${esc(e.elementId)} · ${esc(e.type)}</div></td>
      <td class="hide-sm">${esc(e.category)}</td><td class="r">${e.count}</td><td class="r">${fmtMinutes(e.netMs)}</td><td class="r">${(100 * e.netMs / obs).toFixed(1)}%</td>
      <td class="r hide-sm">${(e.netMs / e.count / 1000).toFixed(1)}</td></tr>`).join('')}</tbody></table></div>`;
  } else if (tab === 'photos') {
    const names = photoFileNames(study, app.idx);
    body.innerHTML = study.photos.length ? `<p class="muted small">Saved and emailed as <b>${esc(studyFolderName(study))}</b> / LINE_SOI_element#_element.jpg</p><div class="gallery">${study.photos.map(p => {
      const at = elementAtTime(study, app.idx, p.t);
      return `<figure data-photo="${p.id}"><img src="${app.thumbUrls.get(p.id) || ''}" alt="" loading="lazy">
        <figcaption><b>${fmtElapsed(p.t - study.startedAt, { forceHours: true })}</b> · ${at ? `<span class="dot" style="background:${leanColor(at.type)}"></span>${esc(at.name)}` : 'before first element'}
        ${p.caption ? `<br><i>${esc(p.caption)}</i>` : ''}<div class="fname">${esc(names[p.id])}</div></figcaption></figure>`;
    }).join('')}</div>` : '<div class="empty">No photos. Use “Import photos” to place photos from the camera roll by their capture time.</div>';
  } else if (tab === 'transcript') {
    body.innerHTML = study.utterances.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Narration</th><th>Result</th></tr></thead><tbody>${study.utterances.map(u => {
      const seg = u.segmentId ? getSegment(study, u.segmentId) : null;
      const res = u.status === 'command' ? `command: ${esc(u.command)}` : u.status === 'note' ? 'note'
        : seg ? `${esc(seg.elementId)} ${esc(displayName(seg, elInfo(seg.elementId)))}`
        : u.status === 'unmatched' ? '<button class="btn small" data-assign="' + u.id + '">Assign element</button>' : esc(u.status);
      return `<tr><td>${fmtElapsed(u.t - study.startedAt, { forceHours: true })}</td><td>${esc(u.text)}</td><td>${res}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No narration.</div>';
  } else {
    const s = study.setup;
    body.innerHTML = `<dl class="kv">
      <dt>Time study ID</dt><dd>${esc(study.tsId)} <span class="muted">(WATTS assigns its TS-ID on import)</span></dd>
      <dt>SOI / Line</dt><dd>${esc(s.soi)} / ${esc(s.line)}</dd><dt>Job</dt><dd>${esc(s.task) || '—'}</dd>
      <dt>Analyst</dt><dd>${esc(s.analystName)} ${esc(s.analystBemsid)}</dd><dt>Date</dt><dd>${esc(s.studyDate)}</dd>
      <dt>Started / ended</dt><dd>${fmtClock(study.startedAt)} – ${study.endedAt ? fmtClock(study.endedAt) : 'running'}</dd>
      <dt>Paused</dt><dd>${study.pauses.length} time(s)</dd><dt>Catalog</dt><dd>${esc(study.catalogVersion)}</dd>
      <dt>Mechanics</dt><dd>${s.mechanics.length ? s.mechanics.map(m => `${esc(m.name || m.bemsid)} — ${esc(m.role)} (${m.rating}%)`).join('<br>') : '—'}</dd>
    </dl>
    <label>Observation notes <textarea id="rv-notes" rows="4">${esc(study.studyNotes || '')}</textarea></label>
    <div class="row"><button class="btn danger" data-delete-study>Delete study from this device</button></div>`;
    $('#rv-notes').onchange = (e) => { study.studyNotes = e.target.value.trim(); persist(); };
  }
  body.onclick = async (e) => {
    const seg = e.target.closest('[data-seg]');
    if (seg) return openSegment(seg.dataset.seg);
    const ph = e.target.closest('[data-photo]');
    if (ph) return openPhoto(ph.dataset.photo);
    const as = e.target.closest('[data-assign]');
    if (as) return assignUtterance(as.dataset.assign);
    if (e.target.closest('[data-delete-study]')) {
      if (!(await confirmDialog('Delete study?', 'The study and its photos will be removed from this device.', 'Delete'))) return;
      await deleteStudy(study.id);
      app.study = null;
      await renderHome();
      show('home');
    }
  };
}

async function importPhotos(e) {
  const study = app.study;
  const files = [...(e.target.files || [])];
  e.target.value = '';
  let placed = 0, skipped = 0;
  for (const file of files) {
    const t = await readExifTime(file);
    if (!t || t < study.startedAt - 1000 || t > (study.endedAt ?? Date.now()) + 1000) { skipped++; continue; }
    try {
      const jpeg = await toJpeg(file);
      await addPhoto(study, { ...jpeg, t, caption: '', source: 'import', timeSource: 'exif' });
      placed++;
    } catch (err) {
      skipped++;
      toast(err.message, 'bad');
    }
  }
  toast(`Placed ${placed} photo${placed === 1 ? '' : 's'} on the timeline${skipped ? ` · ${skipped} skipped (no capture time inside the study window)` : ''}`, placed ? 'ok' : 'warn', { ms: 6000 });
}

// ── Getting photos and data off the phone ─────────────────────────────────────
// Safari can't write into the Files app or Photos by itself, so both flows end
// in the iPhone share sheet: "Save to Files" (On My iPhone / OneDrive) or
// Mail / Outlook / Teams.
const EMAIL_LIMIT_BYTES = 18 * 1024 * 1024;   // under common 20–25 MB attachment limits
const photoBlob = async id => (await getPhoto(id))?.blob;

function recordExport(study, kind, result) {
  if (result !== 'shared' && result !== 'downloaded') return;
  (study.exports || (study.exports = [])).push({ kind, at: Date.now(), via: result });
  persistNow(study);
  if (app.view === 'review' && app.study === study) renderReview();
}

/** Share, and if iOS wants a fresh tap (preparing took too long), offer one. */
async function runShare(kind, share, readyLabel) {
  const study = app.study;
  try {
    const result = await share();
    if (result === 'needs-tap') {
      toast(`${readyLabel} ready`, 'ok', { action: 'Share', ms: 20000,
        onAction: async () => recordExport(study, kind, await share().catch(e => toast(e.message, 'bad'))) });
      return;
    }
    recordExport(study, kind, result);
  } catch (e) {
    toast(`Could not share: ${e.message}`, 'bad');
  }
}

async function withBusy(btn, label, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

/** LINE_SOI.zip → tap it in Files and it becomes the LINE_SOI folder. */
async function saveStudyFolder() {
  const study = app.study;
  const folder = studyFolderName(study);
  await withBusy($('#btn-save-folder'), 'Building folder…', async () => {
    const blob = await buildPackage(study, app.idx, app.catalog, photoBlob);
    const file = new File([blob], `${folder}.zip`, { type: 'application/zip' });
    await runShare('folder', () => shareFiles([file], { title: folder }), `Folder ${folder}`);
  });
}

/** Every photo as its own named JPEG, handed to Mail / Outlook / Teams. */
async function emailPhotos() {
  const study = app.study;
  if (!study.photos.length) { toast('This study has no photos', 'warn'); return; }
  const folder = studyFolderName(study);
  await withBusy($('#btn-email-photos'), 'Preparing photos…', async () => {
    const names = photoFileNames(study, app.idx);
    let items = [];
    for (const p of study.photos) {
      const blob = await photoBlob(p.id);
      if (blob) items.push({ p, blob });
    }
    let total = items.reduce((a, x) => a + x.blob.size, 0);
    let resizedTo = null;
    for (const side of [1600, 1200, 900]) {
      if (total <= EMAIL_LIMIT_BYTES) break;
      const smaller = [];
      for (const x of items) smaller.push({ p: x.p, blob: (await resizeImage(x.blob, side, 0.8)).blob });   // one at a time: iPhone memory
      items = smaller;
      total = items.reduce((a, x) => a + x.blob.size, 0);
      resizedTo = side;
    }
    const files = items.map(x => new File([x.blob], names[x.p.id], { type: 'image/jpeg', lastModified: x.p.t }));
    const s = study.setup;
    const text = `WATTS Voice time study photos: SOI ${s.soi}, Line ${s.line}, ${s.studyDate}${s.task ? ` (${s.task})` : ''}. `
      + `${files.length} photo${files.length === 1 ? '' : 's'}, named LINE_SOI_element#_element.`;
    if (resizedTo) toast(`Photos reduced to ${resizedTo}px so the email stays under ~18 MB`, 'info');
    await runShare('email', () => shareFiles(files, {
      title: `${folder} photos`, text,
      fallback: async () => ({ blob: await buildPhotosZip(study, app.idx, photoBlob), name: `${folder}_photos.zip` }),
    }), `${files.length} photos`);
  });
}

// ═══════════════════════════ Dialog wiring ═══════════════════════════════
function bindDialogs() {
  const search = $('#picker-search');
  search.addEventListener('input', () => renderPicker(search.value, null));
  // Enter would submit the dialog form (closing it); pick the top hit instead.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = $('#picker-body [data-el]');
    if (first && search.value.trim()) first.click();
  });
  $('#picker-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-el]');
    if (!b) return;
    const id = b.dataset.el;
    if (app.idx[id]?.requiresDescription) {
      $('#picker-other').hidden = false;
      $('#picker-other-text').value = search.value.trim();
      $('#picker-other-text').focus();
      return;
    }
    $('#dlg-picker').close();
    const cb = pickerCb; pickerCb = null;
    cb && cb(id, '');
  });
  $('#picker-other-ok').onclick = () => {
    const label = $('#picker-other-text').value.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!label) { $('#picker-other-text').focus(); return; }
    $('#dlg-picker').close();
    const cb = pickerCb; pickerCb = null;
    cb && cb(OTHER_ID, label);
  };
  $('#dlg-complete').addEventListener('close', () => {
    if ($('#dlg-complete').returnValue === 'confirm') finishStudy();
  });
  // Tap outside a dialog closes it.
  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
  }
}

boot();
