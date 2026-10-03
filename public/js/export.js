// Study exports: WATTS import JSON, element CSV, and a self-contained package
// (.zip with JSON, CSV, photos and an offline HTML report).

import { deriveSegments, toWattsPayload, totals, elementAtTime, segmentIndexAt } from './model.js';
import { esc, fmtClock, fmtElapsed, fmtMinutes } from './util.js';
import { makeZip } from './zip.js';

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function elementsCsv(study, idx, now = Date.now()) {
  const rows = [[
    'Seq', 'Code', 'Element', 'Category', 'LeanType', 'StartElapsed', 'EndElapsed', 'StartClock',
    'DurationSec', 'DurationMin', 'Source', 'Mapping', 'Confidence', 'NeedsReview', 'Narration', 'PhotoCount',
  ]];
  for (const s of deriveSegments(study, idx, now)) {
    const narration = study.utterances.filter(u => u.segmentId === s.id).map(u => u.text).join(' / ');
    const photos = study.photos.filter(p => p.t >= s.start && p.t < s.end).length;
    rows.push([
      s.seq, s.elementId, s.name, s.category, s.type,
      fmtElapsed(s.start - study.startedAt, { forceHours: true }),
      fmtElapsed(s.end - study.startedAt, { forceHours: true }),
      fmtClock(s.start), (s.netMs / 1000).toFixed(1), fmtMinutes(s.netMs, 3), s.source, s.method,
      s.confidence != null ? Math.round(s.confidence * 100) + '%' : '',
      s.needsReview && !s.reviewed ? 'yes' : '', narration, photos,
    ]);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// ── File naming ──────────────────────────────────────────────────────────────
/** A file-name part that is valid on iPhone Files, Windows and email (spaces kept). */
export function fileSafe(s) {
  return String(s ?? '')
    .replace(/\s*:\s*/g, ' - ')                    // "Other: Speed Tape" -> "Other - Speed Tape"
    .replace(/[\\/*?"<>|#%\u0000-\u001f]+/g, '-')    // "Clamping/Fixturing" -> "Clamping-Fixturing"
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
}

/** Folder for everything exported from a study: LINE_SOI, e.g. "1047_FAD-2284". */
export function studyFolderName(study) {
  return `${fileSafe(study.setup.line) || 'LINE'}_${fileSafe(study.setup.soi) || 'SOI'}`;
}

/**
 * Photo file names: LINE_SOI_<element #>_<element>.jpg, e.g.
 * "1047_FAD-2284_5_Installing Bolt.jpg". The element number is the element's
 * place in the study sequence (as in the sequence table and CSV); a second
 * photo during the same element becomes "... (2).jpg". Photos taken before
 * the first element use 0. Returns {photoId: fileName}.
 */
export function photoFileNames(study, idx) {
  const folder = studyFolderName(study);
  const segs = deriveSegments(study, idx);
  const used = new Map();
  const names = {};
  for (const p of [...study.photos].sort((a, b) => a.t - b.t)) {
    const i = segmentIndexAt(study, p.t);
    const desc = i >= 0 ? segs[i].name : 'Before first element';
    const base = `${folder}_${i + 1}_${fileSafe(desc) || 'Element'}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    names[p.id] = n === 1 ? `${base}.jpg` : `${base} (${n}).jpg`;
  }
  return names;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Hand files to the iPhone share sheet (Mail, Outlook, Teams, Save to Files,
 * AirDrop); download where file sharing isn't available. Resolves
 * 'shared' | 'cancelled' | 'downloaded' | 'needs-tap'. 'needs-tap' means iOS
 * refused because preparing the files outlasted the original tap — call
 * again from a new tap.
 */
export async function shareFiles(files, { title = '', text = '', fallback } = {}) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title, text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      if (e && e.name === 'NotAllowedError') return 'needs-tap';
      throw e;
    }
  }
  if (files.length === 1) downloadBlob(files[0], files[0].name);
  else if (fallback) { const f = await fallback(); downloadBlob(f.blob, f.name); }
  return 'downloaded';
}

export function shareOrDownload(blob, filename, opts = {}) {
  return shareFiles([new File([blob], filename, { type: blob.type })], { title: filename, ...opts });
}

/** Zip with just the photos, inside the LINE_SOI folder. */
export async function buildPhotosZip(study, idx, getPhotoBlob) {
  const folder = studyFolderName(study);
  const names = photoFileNames(study, idx);
  const files = [];
  for (const p of study.photos) {
    const blob = await getPhotoBlob(p.id);
    if (blob) files.push({ name: `${folder}/${names[p.id]}`, data: blob, date: new Date(p.t) });
  }
  return makeZip(files);
}

/**
 * The study folder as a .zip: LINE_SOI/ with the photos (named per
 * photoFileNames), the offline report, CSV and WATTS import JSON. Tapping the
 * .zip in the iPhone Files app turns it into that folder.
 */
export async function buildPackage(study, idx, catalog, getPhotoBlob, now = Date.now()) {
  const folder = studyFolderName(study);
  const photoNames = photoFileNames(study, idx);
  const files = [];
  for (const p of study.photos) {
    const blob = await getPhotoBlob(p.id);
    if (!blob) continue;
    files.push({ name: `${folder}/${photoNames[p.id]}`, data: blob, date: new Date(p.t) });
  }
  const payload = toWattsPayload(study, idx, now);
  files.unshift(
    { name: `${folder}/${folder}_report.html`, data: reportHtml(study, idx, catalog, photoNames, now) },
    { name: `${folder}/${folder}_elements.csv`, data: '\ufeff' + elementsCsv(study, idx, now) },
    { name: `${folder}/${folder}_watts_import.json`, data: JSON.stringify(payload, null, 2) },
    { name: `${folder}/${folder}_study.json`, data: JSON.stringify({ ...study, photoFiles: photoNames }, null, 2) },
  );
  return makeZip(files);
}

/** Static, offline-viewable report (works from the extracted .zip). */
export function reportHtml(study, idx, catalog, photoNames, now = Date.now()) {
  const segs = deriveSegments(study, idx, now);
  const tot = totals(study, idx, now);
  const lean = catalog.leanTypes;
  const span = Math.max(1, (study.endedAt ?? now) - study.startedAt);
  const pct = ms => (tot.observedMs ? (100 * ms / tot.observedMs).toFixed(1) : '0.0');
  const bar = segs.map(s => {
    const left = (100 * (s.start - study.startedAt) / span).toFixed(3);
    const width = Math.max(0.15, 100 * (s.end - s.start) / span).toFixed(3);
    return `<div class="b" title="${esc(s.name)} — ${fmtElapsed(s.netMs)}" style="left:${left}%;width:${width}%;background:${lean[s.type]?.color || '#999'}"></div>`;
  }).join('');
  const pauses = study.pauses.map(p => {
    const left = (100 * (p.start - study.startedAt) / span).toFixed(3);
    const width = (100 * ((p.end ?? now) - p.start) / span).toFixed(3);
    return `<div class="p" style="left:${left}%;width:${width}%"></div>`;
  }).join('');
  const marks = study.photos.map(p => `<div class="m" style="left:${(100 * (p.t - study.startedAt) / span).toFixed(3)}%"></div>`).join('');
  const typeCards = Object.keys(lean).map(k => `
    <div class="card" style="border-top:4px solid ${lean[k].color}">
      <div class="k">${esc(lean[k].label)}</div>
      <div class="v">${fmtMinutes(tot.byType[k] || 0)} min</div><div class="s">${pct(tot.byType[k] || 0)}%</div>
    </div>`).join('');
  const rows = segs.map(s => `<tr>
      <td>${s.seq}</td><td>${fmtElapsed(s.start - study.startedAt)}</td><td>${esc(s.elementId)}</td>
      <td><span class="dot" style="background:${lean[s.type]?.color}"></span>${esc(s.name)}</td>
      <td>${esc(s.type)}</td><td class="r">${(s.netMs / 1000).toFixed(1)}</td>
      <td>${esc(study.utterances.filter(u => u.segmentId === s.id).map(u => u.text).join(' / '))}</td></tr>`).join('');
  const elemRows = tot.byElement.map(e => `<tr><td>${esc(e.elementId)}</td><td>${esc(e.name)}</td>
      <td>${esc(e.type)}</td><td class="r">${e.count}</td><td class="r">${fmtMinutes(e.netMs)}</td>
      <td class="r">${pct(e.netMs)}%</td></tr>`).join('');
  const photos = study.photos.map(p => {
    const at = elementAtTime(study, idx, p.t);
    return `<figure><img src="${esc(encodeURIComponent(photoNames[p.id] || ''))}" alt="">
      <figcaption><b>${fmtElapsed(p.t - study.startedAt)}</b> · ${esc(fmtClock(p.t))}<br>
      ${at ? `<span class="dot" style="background:${lean[at.type]?.color}"></span>${esc(at.name)}` : 'Before first element'}
      ${p.caption ? `<br><i>${esc(p.caption)}</i>` : ''}<br><span style="color:#777">${esc(photoNames[p.id] || '')}</span></figcaption></figure>`;
  }).join('');
  const s = study.setup;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WATTS Voice report — ${esc(s.soi)} L${esc(s.line)}</title>
<style>
body{font:14px/1.45 -apple-system,'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;color:#1a1a2e;background:#f5f6f8}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.meta{color:#555}
.cards{display:flex;flex-wrap:wrap;gap:10px}.card{background:#fff;border-radius:8px;padding:10px 14px;min-width:150px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.k{font-size:12px;color:#555}.v{font-size:20px;font-weight:700}.s{color:#555}
.tl{position:relative;height:34px;background:#e3e6ea;border-radius:6px;overflow:hidden;margin-top:6px}
.b{position:absolute;top:0;bottom:0;border-right:1px solid rgba(255,255,255,.6)}
.p{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(45deg,#0003 0 4px,#fff6 4px 8px)}
.marks{position:relative;height:12px}.m{position:absolute;width:2px;height:12px;background:#0033a0}
table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid #e6e8eb;text-align:left;vertical-align:top}
th{background:#eef1f6}.r{text-align:right}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden}figure img{width:100%;display:block}figcaption{padding:8px;font-size:12px}
</style></head><body>
<h1>WATTS Voice time study — SOI ${esc(s.soi)} · Line ${esc(s.line)}</h1>
<div class="meta">${esc(study.tsId)} · ${esc(s.studyDate)} · Analyst ${esc(s.analystName)} (${esc(s.analystBemsid)})
${s.task ? ' · ' + esc(s.task) : ''}<br>Started ${esc(fmtClock(study.startedAt))} · Observed ${fmtElapsed(tot.observedMs, { forceHours: true })}
· ${segs.length} elements · ${study.photos.length} photos · catalog ${esc(study.catalogVersion)}</div>
<h2>Value classification</h2><div class="cards">${typeCards}</div>
<h2>Timeline</h2><div class="tl">${bar}${pauses}</div><div class="marks">${marks}</div>
<h2>Standard element totals</h2><table><tr><th>Code</th><th>Element</th><th>Type</th><th class="r">Count</th><th class="r">Minutes</th><th class="r">%</th></tr>${elemRows}</table>
<h2>Element sequence</h2><table><tr><th>#</th><th>Start</th><th>Code</th><th>Element</th><th>Type</th><th class="r">Sec</th><th>Narration</th></tr>${rows}</table>
${study.photos.length ? `<h2>Photos</h2><div class="gal">${photos}</div>` : ''}
${study.studyNotes ? `<h2>Notes</h2><p>${esc(study.studyNotes)}</p>` : ''}
</body></html>`;
}
