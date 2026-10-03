// Study data model — pure functions, no DOM.
//
// A study is a continuous clock that starts at `startedAt`. Elements are stored
// as *boundaries* (`segments`, each with a start time `t`); a segment runs until
// the next boundary, so a late AI answer for an earlier utterance can be
// inserted retroactively without disturbing anything else. Paused intervals
// are excluded from every duration (same rule as WATTS Perform Time Study).

import { uid } from './util.js';

export const SCHEMA_VERSION = 1;
export const MECHANIC_ROLES = ['Primary Mechanic', 'Full Duration Assist', 'Partial Assist'];
export const OTHER_ID = 'RWK-08';
const MIN_GAP_MS = 500;   // two boundaries closer than this collapse into one

export function createStudy(setup, { catalogVersion = '', now = Date.now() } = {}) {
  const soi = (setup.soi || '').trim();
  const line = (setup.line || '').trim();
  const stamp = new Date(now);
  const tsStamp = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}`
    + `${String(stamp.getDate()).padStart(2, '0')}${String(stamp.getHours()).padStart(2, '0')}`
    + `${String(stamp.getMinutes()).padStart(2, '0')}`;
  return {
    id: uid('st_'),
    schema: SCHEMA_VERSION,
    catalogVersion,
    // Provisional ID; WATTS assigns its own TS-SOI-LINE-NNNN on import.
    tsId: `TSV-${soi || 'SOI'}-${line || 'LINE'}-${tsStamp}`,
    setup: {
      soi, line,
      task: (setup.task || '').trim(),
      analystBemsid: (setup.analystBemsid || '').trim(),
      analystName: (setup.analystName || '').trim(),
      studyDate: setup.studyDate || '',
      mechanics: (setup.mechanics || []).map(m => ({
        bemsid: (m.bemsid || '').trim(), name: (m.name || '').trim(),
        role: MECHANIC_ROLES.includes(m.role) ? m.role : 'Primary Mechanic',
        assistMins: m.assistMins ?? null,
        rating: [80, 100, 120].includes(Number(m.rating)) ? Number(m.rating) : 100,
      })),
    },
    status: 'live',
    startedAt: now,
    endedAt: null,
    lastSeenAt: now,
    segments: [],
    pauses: [],
    gaps: [],
    utterances: [],
    photos: [],
    notes: [],
    studyNotes: '',
    createdAt: now,
    updatedAt: now,
  };
}

// ── Pauses ────────────────────────────────────────────────────────────────
export function isPaused(study) {
  const last = study.pauses[study.pauses.length - 1];
  return !!last && last.end == null;
}

export function pauseStudy(study, t = Date.now()) {
  if (study.status === 'complete' || isPaused(study)) return false;
  study.pauses.push({ start: t, end: null });
  study.status = 'paused';
  return true;
}

export function resumeStudy(study, t = Date.now()) {
  if (!isPaused(study)) return false;
  study.pauses[study.pauses.length - 1].end = Math.max(t, study.pauses[study.pauses.length - 1].start);
  study.status = 'live';
  return true;
}

/** Milliseconds of [a, b) that fall inside a pause. */
export function pausedOverlap(study, a, b, now = Date.now()) {
  let total = 0;
  for (const p of study.pauses) {
    const ps = p.start, pe = p.end ?? now;
    const lo = Math.max(a, ps), hi = Math.min(b, pe);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

export function isTimePaused(study, t, now = Date.now()) {
  return study.pauses.some(p => t >= p.start && t < (p.end ?? now));
}

/** End of the study clock: `endedAt` once complete, otherwise now. */
export function clockEnd(study, now = Date.now()) {
  return study.endedAt ?? now;
}

/** Observed (net of pauses) study time in ms. */
export function observedMs(study, now = Date.now()) {
  const end = clockEnd(study, now);
  return Math.max(0, end - study.startedAt - pausedOverlap(study, study.startedAt, end, now));
}

/** Gross wall-clock time since the study started. */
export function elapsedMs(study, now = Date.now()) {
  return Math.max(0, clockEnd(study, now) - study.startedAt);
}

// ── Segments ──────────────────────────────────────────────────────────────
export function sortSegments(study) {
  study.segments.sort((a, b) => a.t - b.t || a.createdAt - b.createdAt);
}

export function segmentIndexAt(study, t) {
  let idx = -1;
  for (let i = 0; i < study.segments.length; i++) {
    if (study.segments[i].t <= t) idx = i; else break;
  }
  return idx;
}

export function segmentAt(study, t) {
  const i = segmentIndexAt(study, t);
  return i >= 0 ? study.segments[i] : null;
}

export function currentSegment(study) {
  return study.segments[study.segments.length - 1] || null;
}

function sameElement(a, b) {
  return a && b && a.elementId === b.elementId && (a.label || '') === (b.label || '');
}

/**
 * Start `elementId` at time `t`. Returns `{segment, created}`; when the element
 * already running at `t` is the same one, no boundary is added (the narration
 * just confirms the current element) and that segment is returned.
 */
export function addSegment(study, { t, elementId, label = '', source = 'voice', method = 'manual',
  confidence = null, alternatives = [], needsReview = false, utteranceId = null, pending = false },
now = Date.now()) {
  t = Math.max(study.startedAt, Math.min(t, clockEnd(study, now)));
  const prev = segmentAt(study, t);
  const candidate = { elementId, label };
  if (prev && sameElement(prev, candidate)) {
    return { segment: prev, created: false };
  }
  // A boundary landing on top of an existing one replaces it (e.g. a
  // correction narrated a moment after a mis-tap).
  if (prev && Math.abs(prev.t - t) < MIN_GAP_MS) {
    Object.assign(prev, { elementId, label, source, method, confidence, alternatives,
      needsReview, utteranceId, pending, reviewed: false, updatedAt: now });
    mergeAdjacent(study);
    return { segment: segmentAt(study, t), created: false, replaced: true };
  }
  const seg = {
    id: uid('sg_'), t, elementId, label, source, method, confidence, alternatives,
    needsReview, reviewed: false, pending, utteranceId, createdAt: now, updatedAt: now,
  };
  study.segments.push(seg);
  sortSegments(study);
  mergeAdjacent(study);
  return { segment: study.segments.includes(seg) ? seg : segmentAt(study, t), created: true };
}

/** Collapse consecutive boundaries that name the same element. */
export function mergeAdjacent(study) {
  const out = [];
  for (const seg of study.segments) {
    const prev = out[out.length - 1];
    if (prev && sameElement(prev, seg)) {
      prev.needsReview = prev.needsReview || seg.needsReview;
      continue;
    }
    out.push(seg);
  }
  study.segments = out;
}

export function getSegment(study, id) {
  return study.segments.find(s => s.id === id) || null;
}

export function updateSegment(study, id, patch, now = Date.now()) {
  const seg = getSegment(study, id);
  if (!seg) return null;
  Object.assign(seg, patch, { updatedAt: now });
  mergeAdjacent(study);
  return getSegment(study, id) || segmentAt(study, seg.t);
}

/** Remove a boundary; its time is absorbed by the previous element. */
export function removeSegment(study, id) {
  const before = study.segments.length;
  study.segments = study.segments.filter(s => s.id !== id);
  mergeAdjacent(study);
  return study.segments.length !== before;
}

/** Move a segment's start, keeping it between its neighbours. */
export function moveSegmentStart(study, id, t, now = Date.now()) {
  const i = study.segments.findIndex(s => s.id === id);
  if (i < 0) return null;
  const lo = i > 0 ? study.segments[i - 1].t + MIN_GAP_MS : study.startedAt;
  const hi = i < study.segments.length - 1 ? study.segments[i + 1].t - MIN_GAP_MS : clockEnd(study, now);
  study.segments[i].t = Math.round(Math.max(lo, Math.min(hi, t)));
  study.segments[i].updatedAt = now;
  return study.segments[i];
}

/** Most recently *created* segment (what "undo" / "scratch that" removes). */
export function lastCreatedSegment(study) {
  return study.segments.reduce((best, s) => (!best || s.createdAt > best.createdAt ? s : best), null);
}

// ── Derived views ─────────────────────────────────────────────────────────
/**
 * Segments with computed start/end/durations and catalog info.
 * `idx` is `{id: {name, type, category, categoryCode}}`.
 */
export function deriveSegments(study, idx, now = Date.now()) {
  const end = clockEnd(study, now);
  return study.segments.map((s, i) => {
    const next = study.segments[i + 1];
    const segEnd = next ? next.t : end;
    const el = idx[s.elementId] || {};
    const grossMs = Math.max(0, segEnd - s.t);
    const netMs = Math.max(0, grossMs - pausedOverlap(study, s.t, segEnd, now));
    return {
      ...s, seq: i + 1, start: s.t, end: segEnd, grossMs, netMs,
      live: !next && !study.endedAt,
      name: displayName(s, el), baseName: el.name || s.elementId,
      type: el.type || 'NVAW', category: el.category || '', categoryCode: el.categoryCode || '',
    };
  });
}

export function displayName(seg, el) {
  const name = (el && el.name) || seg.elementId;
  return seg.elementId === OTHER_ID && seg.label ? `Other: ${seg.label}` : name;
}

/** Time from study start to the first narrated element (not attributed). */
export function unassignedMs(study, now = Date.now()) {
  const first = study.segments[0];
  const end = first ? first.t : clockEnd(study, now);
  return Math.max(0, end - study.startedAt - pausedOverlap(study, study.startedAt, end, now));
}

export function totals(study, idx, now = Date.now()) {
  const byType = { VA: 0, NVAN: 0, NVAW: 0, NVAD: 0 };
  const byElement = new Map();
  for (const d of deriveSegments(study, idx, now)) {
    byType[d.type] = (byType[d.type] || 0) + d.netMs;
    const key = d.elementId + '|' + (d.elementId === OTHER_ID ? d.label || '' : '');
    const agg = byElement.get(key) || { elementId: d.elementId, name: d.name, type: d.type,
      category: d.category, netMs: 0, count: 0 };
    agg.netMs += d.netMs;
    agg.count += 1;
    byElement.set(key, agg);
  }
  const assigned = byType.VA + byType.NVAN + byType.NVAW + byType.NVAD;
  return {
    byType,
    NVAU: byType.NVAW + byType.NVAD,
    assignedMs: assigned,
    unassignedMs: unassignedMs(study, now),
    observedMs: observedMs(study, now),
    byElement: [...byElement.values()].sort((a, b) => b.netMs - a.netMs),
  };
}

export function needsReviewCount(study) {
  return study.segments.filter(s => s.needsReview && !s.reviewed).length;
}

/** Element running when a photo/note was taken. */
export function elementAtTime(study, idx, t) {
  const seg = segmentAt(study, t);
  if (!seg) return null;
  const el = idx[seg.elementId] || {};
  return { segment: seg, name: displayName(seg, el), type: el.type || 'NVAW', category: el.category || '' };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
export function completeStudy(study, t = Date.now()) {
  if (study.status === 'complete') return false;
  if (isPaused(study)) resumeStudy(study, t);
  study.endedAt = t;
  study.status = 'complete';
  return true;
}

/** Record time the app was closed / backgrounded so coverage gaps are visible. */
export function noteGap(study, start, end, reason) {
  if (end - start < 5000) return;
  study.gaps.push({ start, end, reason });
}

// ── WATTS export ──────────────────────────────────────────────────────────
/**
 * Payload for WATTS `POST /api/save-full-time-study` (same shape the WATTS
 * Perform Time Study page sends). Extra keys are WATTS Voice provenance and
 * are ignored by the current WATTS importer.
 */
export function toWattsPayload(study, idx, now = Date.now()) {
  const t = totals(study, idx, now);
  const segs = deriveSegments(study, idx, now);
  const critical = study.setup.mechanics.filter(m => m.role !== 'Partial Assist');
  const ratings = critical.map(m => m.rating).filter(Number.isFinite);
  const rating = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null;
  const transcriptFor = seg => study.utterances
    .filter(u => u.segmentId === seg.id).map(u => u.text).join(' / ');
  const photosFor = seg => study.photos.filter(p => p.t >= seg.start && p.t < seg.end).map(p => p.id);
  return {
    study: {
      time_study_id: study.tsId,
      soi: study.setup.soi,
      line_number: study.setup.line,
      minor_model: '',
      analyst_bemsid: study.setup.analystBemsid,
      analyst_name: study.setup.analystName,
      study_date: study.setup.studyDate,
      study_start_timestamp: study.startedAt,
      study_end_timestamp: study.endedAt ?? now,
      total_duration_secs: t.observedMs / 1000,
      va_duration_secs: t.byType.VA / 1000,
      nvan_duration_secs: t.byType.NVAN / 1000,
      nvaw_duration_secs: t.byType.NVAW / 1000,
      nvad_duration_secs: t.byType.NVAD / 1000,
      nvau_duration_secs: t.NVAU / 1000,
      element_count: segs.length,
      notes: study.studyNotes || '',
      time_study_type: 'VOICE',
      task_description: study.setup.task,
      catalog_version: study.catalogVersion,
      photo_count: study.photos.length,
    },
    elements: segs.map(s => ({
      task: s.name,
      category: s.category,
      categoryType: s.type,
      startTime: s.start,
      endTime: s.end,
      duration: s.netMs,
      element1: s.category,
      element2: s.name,
      element3: '',
      rating_pct: rating ?? '',
      normal_time_mins: rating != null ? Math.round(rating / 100 * s.netMs / 60000 * 1000) / 1000 : '',
      element_code: s.elementId,
      source: s.source,
      mapping_method: s.method,
      confidence: s.confidence,
      needs_review: !!(s.needsReview && !s.reviewed),
      transcript: transcriptFor(s),
      photo_ids: photosFor(s),
    })),
    mechanics: study.setup.mechanics.map(m => ({
      bemsid: m.bemsid,
      name: m.name,
      role: m.role,
      assist_duration_mins: m.role === 'Partial Assist' ? (Number(m.assistMins) || 0) : null,
      rating_pct: m.rating ?? '',
    })),
  };
}
