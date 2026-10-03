// Small shared helpers (no DOM access so they run under node tests too).

export function uid(prefix = '') {
  const rnd = (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return prefix + Date.now().toString(36) + rnd;
}

export const pad2 = n => String(Math.floor(n)).padStart(2, '0');

/** ms -> "H:MM:SS" (or "MM:SS" under an hour). */
export function fmtElapsed(ms, { forceHours = false } = {}) {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const body = (h || forceHours) ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
  return (neg ? '-' : '') + body;
}

/** ms -> "1m 05s" / "12.3s" style durations for tables. */
export function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${pad2(s - m * 60)}s`;
}

export function fmtMinutes(ms, digits = 2) {
  return (ms / 60000).toFixed(digits);
}

export function fmtClock(epochMs, withSeconds = true) {
  const d = new Date(epochMs);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())}${withSeconds ? ':' + pad2(d.getSeconds()) : ''} ${ampm}`;
}

export function isoDate(epochMs = Date.now()) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
  return wrapped;
}

export function safeFilename(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'study';
}
