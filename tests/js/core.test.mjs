// Unit tests for the browser modules that run without a DOM.
//   node --test tests/js/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildMatcher, parseCommand, normalizeText, stem } from '../../public/js/matcher.js';
import * as M from '../../public/js/model.js';
import { crc32, makeZip } from '../../public/js/zip.js';
import { parseExifTime, exifDateToEpoch } from '../../public/js/camera.js';
import { encodeWav } from '../../public/js/speech.js';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../server/catalog.json', import.meta.url)), 'utf8'));
const matcher = buildMatcher(catalog);
const idx = Object.fromEntries(matcher.elements.map(e => [e.id, e]));

// ── Matcher ──────────────────────────────────────────────────────────────────
const AUTO = [
  ['drilling', 'FAS-01'],
  ["he's drilling the pilot holes now", 'FAS-01'],
  ['sealing', 'ASM-05'],
  ['sealant work', 'ASM-05'],          // Task1: these must standardize together
  ['applying sealant', 'ASM-05'],
  ['applying wet sealant', 'FAS-08'],
  ['installing high locks on the frame', 'FAS-05'],
  ['waiting on the inspector', 'DLY-01'],
  ['torque check', 'QUA-05'],
  ['torquing the bolts', 'FAS-07'],
  ['reading the drawing', 'SUP-01'],
  ['looking for a drill bit', 'MAT-07'],
  ['finished drilling, now deburring', 'FAS-02'],
  ['redrilling an oversize hole', 'RWK-01'],
  ['drilling out a rivet', 'RWK-02'],
  ['the drill battery died', 'DLY-07'],
  ['installing clecos', 'ASM-03'],
  ['crimping pins', 'ELE-04'],
  ['QA buyoff', 'QUA-03'],
  ['he is waiting for engineering to disposition the gap', 'DLY-04'],
];

for (const [text, id] of AUTO) {
  test(`matcher: "${text}" -> ${id}`, () => {
    const r = matcher.match(text);
    assert.equal(r.top?.id, id, JSON.stringify(r.candidates.slice(0, 3)));
    assert.equal(r.decision, 'auto');
  });
}

test('matcher: unrelated chatter is not matched', () => {
  assert.equal(matcher.match('talking to the lead').decision, 'none');
  assert.equal(matcher.match('nothing really happening').decision, 'none');
});

test('matcher: ambiguous narration is only tentative', () => {
  assert.equal(matcher.match('getting parts from the kit cart').decision, 'tentative');
});

test('matcher: Other is never auto-selected', () => {
  for (const r of [matcher.match('other'), matcher.match('something else')]) {
    assert.notEqual(r.decision === 'auto' && r.top.id, 'RWK-08');
  }
});

test('matcher: search finds by prefix and synonym', () => {
  assert.equal(matcher.search('tor')[0].id.startsWith('FAS-07') || matcher.search('tor').some(h => h.id === 'FAS-07'), true);
  assert.ok(matcher.search('sealant').some(h => h.id === 'ASM-05'));
});

test('normalize + stem are consistent', () => {
  assert.equal(stem('drilling'), stem('drill'));
  assert.equal(stem('torquing'), stem('torque'));
  assert.equal(normalizeText('Hi-Lok'), 'hilok');
  assert.equal(normalizeText('re-drilling'), 'redrilling');
});

// ── Commands ─────────────────────────────────────────────────────────────────
test('commands: whole-utterance only', () => {
  assert.deepEqual(parseCommand('Pause.'), { command: 'pause', woke: false });
  assert.equal(parseCommand('Watts, pause the study please').command, 'pause');
  assert.equal(parseCommand('resume').command, 'resume');
  assert.equal(parseCommand('Scratch that').command, 'undo');
  assert.equal(parseCommand('end the study').command, 'complete');
  assert.equal(parseCommand('he paused to read the drawing'), null);
  assert.equal(parseCommand('stop'), null);
  assert.equal(parseCommand('drilling'), null);
});

test('commands: photo with caption, note text', () => {
  assert.deepEqual(parseCommand('take a photo of the gap'), { command: 'photo', caption: 'the gap', woke: false });
  assert.equal(parseCommand('snap').command, 'photo');
  const n = parseCommand('Note: the bit looks dull');
  assert.equal(n.command, 'note');
  assert.equal(n.note, 'the bit looks dull');
});

// ── Model ────────────────────────────────────────────────────────────────────
function newStudy(t0 = 1_000_000) {
  return M.createStudy({ soi: 'FAD-2284', line: '1047', studyDate: '2026-10-03',
    mechanics: [{ bemsid: '1', role: 'Primary Mechanic', rating: 120 }, { bemsid: '2', role: 'Partial Assist', rating: 80, assistMins: 3 }] },
  { catalogVersion: 'v', now: t0 });
}

test('model: boundaries, continuation, retroactive insert', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0 + 1000, elementId: 'SUP-01' }, t0 + 1000);
  M.addSegment(s, { t: t0 + 10000, elementId: 'FAS-01' }, t0 + 10000);
  const again = M.addSegment(s, { t: t0 + 15000, elementId: 'FAS-01' }, t0 + 15000);
  assert.equal(again.created, false);                       // same element continues
  M.addSegment(s, { t: t0 + 20000, elementId: 'DLY-01' }, t0 + 20000);
  // Late AI answer for an utterance at 5 s lands between the first two.
  M.addSegment(s, { t: t0 + 5000, elementId: 'MAT-07' }, t0 + 25000);
  assert.deepEqual(s.segments.map(x => x.elementId), ['SUP-01', 'MAT-07', 'FAS-01', 'DLY-01']);
  const d = M.deriveSegments(s, idx, t0 + 30000);
  assert.deepEqual(d.map(x => x.netMs), [4000, 5000, 10000, 10000]);
  assert.equal(M.unassignedMs(s, t0 + 30000), 1000);
});

test('model: adjacent duplicates merge after edits and deletes', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0, elementId: 'FAS-01' }, t0);
  const mid = M.addSegment(s, { t: t0 + 5000, elementId: 'FAS-02' }, t0 + 5000).segment;
  M.addSegment(s, { t: t0 + 9000, elementId: 'FAS-01' }, t0 + 9000);
  M.removeSegment(s, mid.id);
  assert.equal(s.segments.length, 1);
  assert.equal(s.segments[0].t, t0);
});

test('model: boundary within 0.5 s replaces instead of adding', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0 + 1000, elementId: 'FAS-01' }, t0 + 1000);
  const r = M.addSegment(s, { t: t0 + 1300, elementId: 'FAS-03' }, t0 + 1300);
  assert.equal(r.replaced, true);
  assert.deepEqual(s.segments.map(x => x.elementId), ['FAS-03']);
});

test('model: pauses are excluded from durations and totals', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0, elementId: 'FAS-01' }, t0);
  M.pauseStudy(s, t0 + 10000);
  assert.equal(M.isPaused(s), true);
  M.resumeStudy(s, t0 + 40000);
  M.addSegment(s, { t: t0 + 50000, elementId: 'DLY-02' }, t0 + 50000);
  M.completeStudy(s, t0 + 60000);
  const tot = M.totals(s, idx);
  assert.equal(tot.byType.VA, 20000);
  assert.equal(tot.byType.NVAD, 10000);
  assert.equal(tot.observedMs, 30000);
  assert.equal(tot.NVAU, 10000);
});

test('model: move start is clamped between neighbours', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0 + 1000, elementId: 'FAS-01' }, t0 + 1000);
  const b = M.addSegment(s, { t: t0 + 5000, elementId: 'FAS-02' }, t0 + 5000).segment;
  M.addSegment(s, { t: t0 + 9000, elementId: 'FAS-03' }, t0 + 9000);
  M.moveSegmentStart(s, b.id, t0, t0 + 9500);
  assert.equal(b.t, t0 + 1500);
  M.moveSegmentStart(s, b.id, t0 + 99999, t0 + 9500);
  assert.equal(b.t, t0 + 8500);
});

test('model: undo target is the most recently created segment', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0 + 9000, elementId: 'FAS-03' }, t0 + 9000);
  const late = M.addSegment(s, { t: t0 + 2000, elementId: 'FAS-01' }, t0 + 9500).segment;
  assert.equal(M.lastCreatedSegment(s).id, late.id);
});

test('model: Other keeps its description and is separate per label', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0, elementId: 'RWK-08', label: 'Speed Tape' }, t0);
  M.addSegment(s, { t: t0 + 5000, elementId: 'RWK-08', label: 'Painting' }, t0 + 5000);
  M.completeStudy(s, t0 + 8000);
  const names = M.deriveSegments(s, idx).map(x => x.name);
  assert.deepEqual(names, ['Other: Speed Tape', 'Other: Painting']);
  assert.equal(M.totals(s, idx).byElement.length, 2);
});

test('model: WATTS payload matches the save-full-time-study shape', () => {
  const s = newStudy();
  const t0 = s.startedAt;
  M.addSegment(s, { t: t0, elementId: 'FAS-01', source: 'voice', method: 'local', confidence: 0.9 }, t0);
  M.addSegment(s, { t: t0 + 60000, elementId: 'QUA-01' }, t0 + 60000);
  M.completeStudy(s, t0 + 90000);
  const p = M.toWattsPayload(s, idx);
  assert.equal(p.study.time_study_id, s.tsId);
  assert.equal(p.study.soi, 'FAD-2284');
  assert.equal(p.study.time_study_type, 'VOICE');
  assert.equal(p.study.total_duration_secs, 90);
  assert.equal(p.study.va_duration_secs, 60);
  assert.equal(p.study.nvan_duration_secs, 30);
  assert.equal(p.elements[0].task, 'Drilling Hole');
  assert.equal(p.elements[0].category, 'Fastener Installation');
  assert.equal(p.elements[0].categoryType, 'VA');
  assert.equal(p.elements[0].duration, 60000);
  assert.equal(p.elements[0].element1, 'Fastener Installation');
  assert.equal(p.elements[0].element2, 'Drilling Hole');
  assert.equal(p.elements[0].rating_pct, 120);           // primary only; partial assist excluded
  assert.equal(p.elements[0].normal_time_mins, 1.2);
  assert.deepEqual(p.mechanics.map(m => m.assist_duration_mins), [null, 3]);
});

// ── Zip / EXIF / WAV ─────────────────────────────────────────────────────────
test('zip: crc32 and structure', async () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const blob = await makeZip([{ name: 'a.txt', data: 'hi' }, { name: 'p/b.bin', data: new Uint8Array([1, 2]) }]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(bytes.length - 22 + 10, true), 2);
});

function jpegWithExif(dateStr, offset) {
  // Minimal big-endian TIFF: IFD0 -> ExifIFD with DateTimeOriginal (+ OffsetTimeOriginal).
  const enc = s => [...s].map(c => c.charCodeAt(0)).concat([0]);
  const date = enc(dateStr);
  const off = offset ? enc(offset) : null;
  const tiff = [];
  const u16 = v => [(v >> 8) & 255, v & 255];
  const u32 = v => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const exifIfdOff = 8 + 2 + 12 + 4;
  const exifCount = off ? 2 : 1;
  const dataOff = exifIfdOff + 2 + 12 * exifCount + 4;
  tiff.push(0x4d, 0x4d, ...u16(42), ...u32(8));
  tiff.push(...u16(1), ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifIfdOff), ...u32(0));
  tiff.push(...u16(exifCount), ...u16(0x9003), ...u16(2), ...u32(date.length), ...u32(dataOff));
  if (off) tiff.push(...u16(0x9011), ...u16(2), ...u32(off.length), ...u32(dataOff + date.length));
  tiff.push(...u32(0), ...date, ...(off || []));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const bytes = [0xff, 0xd8, 0xff, 0xe1, ...u16(app1.length + 2), ...app1, 0xff, 0xda, 0, 2];
  return new DataView(new Uint8Array(bytes).buffer);
}

test('exif: DateTimeOriginal with and without offset', () => {
  assert.equal(parseExifTime(jpegWithExif('2026:10:03 14:30:05', '-07:00')), Date.UTC(2026, 9, 3, 21, 30, 5));
  assert.equal(parseExifTime(jpegWithExif('2026:10:03 14:30:05')), new Date(2026, 9, 3, 14, 30, 5).getTime());
  assert.equal(parseExifTime(new DataView(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)), null);
  assert.equal(exifDateToEpoch('garbage'), null);
});

test('wav: 16 kHz mono header', () => {
  const wav = encodeWav([new Float32Array(4800), new Float32Array(43200)], 48000, 16000);
  assert.equal(wav.size, 44 + 16000 * 2);
  assert.equal(wav.type, 'audio/wav');
});
