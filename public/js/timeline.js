// Video-editor style study timeline.
//
// Track mode: one continuous lane of element bars (like a clip track) with a
// photo track above it. Gantt mode: one row per standard element. Both share
// the time ruler, pause hatching, coverage gaps, notes and the live playhead.

import { esc, fmtElapsed } from './util.js';

const ZOOMS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 4, 8, 16, 32];   // px per second
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const LABEL_W = 170;

export class Timeline {
  constructor(root, { onSegment, onPhoto, onNote, onFollowChange } = {}) {
    this.root = root;
    this.cb = { onSegment, onPhoto, onNote, onFollowChange };
    this.mode = 'track';
    this.pps = 2;
    this.follow = true;
    this.data = null;
    this.thumbUrls = new Map();
    this._programmaticScroll = false;
    root.classList.add('tl');
    root.innerHTML = `<div class="tl-scroll" tabindex="0" aria-label="Study timeline"><div class="tl-canvas"></div></div>`;
    this.scroller = root.querySelector('.tl-scroll');
    this.canvas = root.querySelector('.tl-canvas');
    this._bind();
  }

  setThumbUrl(photoId, url) { this.thumbUrls.set(photoId, url); }

  setMode(mode) { this.mode = mode; this.render(); }

  /**
   * data: { startedAt, end, live, segments (derived), photos, notes, pauses,
   *         gaps, lean (leanTypes), utteranceTimes }
   */
  setData(data) {
    const first = !this.data;
    this.data = data;
    if (first) this.fit();
    this.render();
  }

  get x0() { return this.mode === 'gantt' ? LABEL_W : 10; }

  x(t) { return this.x0 + ((t - this.data.startedAt) / 1000) * this.pps; }

  zoomBy(factor, anchorClientX) {
    this.setZoom(this.pps * factor, anchorClientX);
  }

  zoomStep(dir) {
    const i = ZOOMS.findIndex(z => z >= this.pps - 1e-9);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))];
    this.setZoom(next);
  }

  setZoom(pps, anchorClientX) {
    if (!this.data) return;
    pps = Math.max(ZOOMS[0] / 2, Math.min(ZOOMS[ZOOMS.length - 1], pps));
    const rect = this.scroller.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - rect.left : rect.width / 2;
    const tAtAnchor = (this.scroller.scrollLeft + ax - this.x0) / this.pps;
    this.pps = pps;
    this.render();
    this._scrollTo(this.x0 + tAtAnchor * this.pps - ax);
  }

  fit() {
    if (!this.data) return;
    const dur = Math.max(30, (this.data.end - this.data.startedAt) / 1000);
    const w = Math.max(200, this.scroller.clientWidth - this.x0 - 30);
    this.pps = Math.max(ZOOMS[0] / 2, Math.min(8, w / dur));
    this.render();
    this._scrollTo(0);
  }

  setFollow(on) {
    this.follow = on;
    if (this.cb.onFollowChange) this.cb.onFollowChange(on);
    if (on) this.tick(this.data ? this.data.end : Date.now());
  }

  _scrollTo(left) {
    this._programmaticScroll = true;
    this.scroller.scrollLeft = Math.max(0, left);
    requestAnimationFrame(() => { this._programmaticScroll = false; });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  render() {
    const d = this.data;
    if (!d) { this.canvas.innerHTML = ''; return; }
    const durSec = Math.max(1, (d.end - d.startedAt) / 1000);
    // Headroom so the live playhead can advance for a while without re-rendering.
    const width = Math.ceil(this.x0 + durSec * this.pps + Math.max(240, this.scroller.clientWidth * 0.6));
    const rows = this.mode === 'gantt' ? this._ganttRows(d.segments) : null;
    const laneH = this.mode === 'gantt' ? rows.length * 30 + 6 : 54;
    const html = [];
    html.push(this._ruler(width, durSec));
    html.push(this._photoTrack(d));
    html.push(`<div class="tl-lanes" style="height:${laneH}px">`);
    if (this.mode === 'gantt') {
      rows.forEach((row, r) => {
        html.push(`<div class="tl-grow" style="top:${r * 30 + 3}px">
          <div class="tl-glabel" style="width:${LABEL_W - 8}px"><span class="tl-sw" style="background:${d.lean[row.type]?.color}"></span>${esc(row.name)}</div></div>`);
        for (const s of row.segs) html.push(this._bar(s, r * 30 + 5, 22, true));
      });
    } else {
      for (const s of d.segments) html.push(this._bar(s, 6, 42, false));
    }
    html.push('</div>');
    html.push(this._overlays(d, laneH));
    html.push(`<div class="tl-playhead" style="left:${this.x(d.end)}px;${d.live ? '' : 'display:none'}"></div>`);
    this.canvas.style.width = width + 'px';
    this.canvas.classList.toggle('gantt', this.mode === 'gantt');
    this.canvas.innerHTML = html.join('');
    if (d.live && this.follow) this._followNow();
  }

  _ganttRows(segments) {
    const rows = [];
    const byKey = new Map();
    for (const s of segments) {
      const key = s.elementId + '|' + (s.label || '');
      if (!byKey.has(key)) { byKey.set(key, { name: s.name, type: s.type, segs: [] }); rows.push(byKey.get(key)); }
      byKey.get(key).segs.push(s);
    }
    return rows;
  }

  _bar(s, top, h, compact) {
    const left = this.x(s.start);
    const w = Math.max(3, this.x(s.end) - left);
    const color = this.data.lean[s.type]?.color || '#888';
    const cls = ['tl-bar', `lt-${s.type}`];
    if (s.needsReview && !s.reviewed) cls.push('review');
    if (s.pending) cls.push('pending');
    if (s.live) cls.push('live');
    const label = w > 46 && !compact
      ? `<span class="tl-code">${esc(s.elementId)}</span><span class="tl-name">${esc(s.name)}</span>` : '';
    const dur = fmtElapsed(s.netMs);
    return `<button class="${cls.join(' ')}" data-seg="${s.id}" style="left:${left}px;width:${w}px;top:${top}px;height:${h}px;--c:${color}"
      title="${esc(s.elementId)} ${esc(s.name)} · ${dur}${s.needsReview && !s.reviewed ? ' · needs review' : ''}">${label}${!compact && w > 90 ? `<span class="tl-dur">${dur}</span>` : ''}</button>`;
  }

  _ruler(width, durSec) {
    const step = TICK_STEPS.find(s => s * this.pps >= 70) || 3600;
    const minor = step >= 60 ? step / (step >= 600 ? 5 : 4) : step / 5;
    const out = ['<div class="tl-ruler">'];
    const maxSec = (width - this.x0) / this.pps;
    for (let s = 0; s <= maxSec; s += minor) {
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      const x = this.x0 + s * this.pps;
      out.push(`<div class="tl-tick${major ? ' major' : ''}" style="left:${x}px">${major ? fmtElapsed(s * 1000) : ''}</div>`);
    }
    out.push('</div>');
    return out.join('');
  }

  _photoTrack(d) {
    const out = ['<div class="tl-photos">'];
    let lastX = -999, row = 0;
    for (const p of d.photos) {
      const x = this.x(p.t);
      row = x - lastX < 40 ? (row + 1) % 2 : 0;
      lastX = x;
      const url = this.thumbUrls.get(p.id);
      out.push(`<button class="tl-photo row${row}" data-photo="${p.id}" style="left:${x}px"
        title="Photo at ${fmtElapsed(p.t - d.startedAt)}${p.caption ? ' — ' + esc(p.caption) : ''}">
        ${url ? `<img src="${url}" alt="" loading="lazy">` : '<span>📷</span>'}</button>
        <div class="tl-stem" style="left:${x}px"></div>`);
    }
    out.push('</div>');
    return out.join('');
  }

  _overlays(d, laneH) {
    const out = [];
    for (const p of d.pauses) {
      const l = this.x(p.start), w = Math.max(2, this.x(p.end ?? d.end) - l);
      out.push(`<div class="tl-pause" style="left:${l}px;width:${w}px" title="Paused ${fmtElapsed((p.end ?? d.end) - p.start)} (excluded)"></div>`);
    }
    for (const g of d.gaps || []) {
      const l = this.x(g.start), w = Math.max(2, this.x(g.end) - l);
      out.push(`<div class="tl-gap" style="left:${l}px;width:${w}px" title="No voice coverage: ${esc(g.reason)} (${fmtElapsed(g.end - g.start)})"></div>`);
    }
    for (const n of d.notes || []) {
      out.push(`<button class="tl-note" data-note="${n.id}" style="left:${this.x(n.t) - 7}px" title="${esc(n.text)}">✎</button>`);
    }
    for (const t of d.utteranceTimes || []) {
      out.push(`<div class="tl-utt" style="left:${this.x(t)}px"></div>`);
    }
    return out.join('');
  }

  /** Cheap per-frame update while live: playhead + the running bar. */
  tick(now) {
    const d = this.data;
    if (!d || !d.live) return;
    d.end = now;
    const xNow = this.x(now);
    const ph = this.canvas.querySelector('.tl-playhead');
    if (ph) ph.style.left = xNow + 'px';
    const liveSeg = d.segments[d.segments.length - 1];
    if (liveSeg) {
      liveSeg.end = now;
      this.canvas.querySelectorAll(`[data-seg="${liveSeg.id}"]`).forEach(el => {
        el.style.width = Math.max(3, xNow - this.x(liveSeg.start)) + 'px';
      });
    }
    if (xNow + 60 > this.canvas.offsetWidth) this.render();
    else if (this.follow) this._followNow();
  }

  _followNow() {
    const xNow = this.x(this.data.end);
    const view = this.scroller.clientWidth;
    const left = this.scroller.scrollLeft;
    if (xNow > left + view * 0.85 || xNow < left + this.x0) this._scrollTo(xNow - view * 0.6);
  }

  // ── Interaction ───────────────────────────────────────────────────────────
  _bind() {
    this.canvas.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-seg]');
      if (seg && this.cb.onSegment) return this.cb.onSegment(seg.dataset.seg);
      const ph = e.target.closest('[data-photo]');
      if (ph && this.cb.onPhoto) return this.cb.onPhoto(ph.dataset.photo);
      const note = e.target.closest('[data-note]');
      if (note && this.cb.onNote) return this.cb.onNote(note.dataset.note);
    });
    this.scroller.addEventListener('scroll', () => {
      if (this._programmaticScroll || !this.data || !this.data.live) return;
      const xNow = this.x(this.data.end);
      const visible = xNow >= this.scroller.scrollLeft && xNow <= this.scroller.scrollLeft + this.scroller.clientWidth;
      if (!visible && this.follow) this.setFollow(false);
    }, { passive: true });
    // Ctrl+wheel / trackpad pinch on desktop.
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX);
    }, { passive: false });
    // Safari (macOS trackpad / iOS) gesture events.
    let gestureStart = null;
    this.scroller.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = this.pps; });
    this.scroller.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (gestureStart) this.setZoom(gestureStart * e.scale, e.clientX);
    });
    this.scroller.addEventListener('gestureend', (e) => { e.preventDefault(); gestureStart = null; });
    // Two-finger pinch via pointer events (touch screens on all browsers).
    const pts = new Map();
    let pinch = null;
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, e.clientX);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { dist: Math.abs(a - b) || 1, pps: this.pps, mid: (a + b) / 2 };
      }
    });
    this.scroller.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, e.clientX);
      if (pinch && pts.size === 2 && !gestureStart) {
        const [a, b] = [...pts.values()];
        this.setZoom(pinch.pps * (Math.abs(a - b) || 1) / pinch.dist, pinch.mid);
      }
    });
    const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    this.scroller.addEventListener('pointerup', end);
    this.scroller.addEventListener('pointercancel', end);
  }
}
