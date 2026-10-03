// End-to-end smoke test at iPhone size (Chromium with iPhone viewport + touch,
// fake camera, and a scripted stand-in for iOS Safari's webkitSpeechRecognition).
//
//   node tests/e2e/iphone_flow.cjs [baseUrl] [screenshotDir]
//
// Requires a running server (flask --app app run) and Playwright.
const path = require('path');
const fs = require('fs');
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const BASE = process.argv[2] || 'http://127.0.0.1:5055/';
const OUT = process.argv[3] || path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });

// Fake recognizer: window.__say(text, {final}) feeds results like Safari does.
// With final=false the result never becomes final (an iOS quirk) and the app's
// stabilizer must still turn it into an utterance.
const FAKE_SPEECH = `
(() => {
  let active = null;
  class FakeRecognition {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; this.results = []; }
    start() { active = this; setTimeout(() => this.onstart && this.onstart(), 10); }
    stop() { if (active === this) active = null; setTimeout(() => this.onend && this.onend(), 10); }
    abort() { this.stop(); }
  }
  // Share sheet stand-in: __shareMode 'share' records what would be handed to
  // Mail/Files; 'download' makes canShare() false so the download fallback runs.
  window.__shareMode = 'download';
  window.__shared = null;
  Object.defineProperty(navigator, 'canShare', { configurable: true,
    value: (data) => window.__shareMode === 'share' && !!(data && data.files) });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => {
    window.__shared = { title: data.title, text: data.text,
      files: data.files.map(f => ({ name: f.name, type: f.type, size: f.size })) };
  } });
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
  window.__say = (text, { final = true } = {}) => {
    const rec = active;
    if (!rec) return false;
    const words = text.split(' ');
    const idx = rec.results.length;
    const emit = (t, isFinal) => {
      const alt = { transcript: t, confidence: 0.9 };
      const res = Object.assign([alt], { isFinal });
      rec.results[idx] = res;
      rec.onresult && rec.onresult({ resultIndex: idx, results: rec.results });
    };
    let i = 1;
    const step = () => {
      emit(words.slice(0, i).join(' '), false);
      if (i < words.length) { i++; setTimeout(step, 60); }
      else if (final) setTimeout(() => emit(text, true), 80);
    };
    step();
    return true;
  };
})();`;

(async () => {
  const browser = await playwright.chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    permissions: ['camera', 'microphone'],
    acceptDownloads: true,
  });
  await context.addInitScript(FAKE_SPEECH);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const say = async (text, opts = {}) => {
    const ok = await page.evaluate(([t, o]) => window.__say(t, o), [text, opts]);
    if (!ok) throw new Error('recognizer not running when saying: ' + text);
    await page.waitForTimeout(opts.final === false ? 2200 : 900);
  };
  const results = [];
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); };

  await page.goto(BASE);
  await page.waitForSelector('#view-home:not([hidden])');
  await page.screenshot({ path: path.join(OUT, '01_home.png'), fullPage: true });
  check('keep-safe tip shown in Safari (not Home Screen)', await page.isVisible('#keep-banner'));

  await page.fill('input[name=soi]', 'FAD-2284');
  await page.fill('input[name=line]', '1047');
  await page.fill('input[name=task]', 'Install aft pressure bulkhead fasteners');
  await page.fill('input[name=analystBemsid]', '1234567');
  await page.fill('input[name=analystName]', 'J. Rivera');
  await page.click('#btn-begin');
  await page.waitForSelector('#view-live:not([hidden])');
  await page.waitForTimeout(1200);
  check('camera started', await page.evaluate(() => document.querySelector('#cam').classList.contains('on')));
  check('mic listening', (await page.textContent('#voice-state')).startsWith('Listening'));

  await say('reading the work instructions');
  check('first element mapped', (await page.textContent('#cur-name')) === 'Reading Work Instr', await page.textContent('#cur-name'));
  await say("now he's drilling the pilot holes", { final: false });   // iOS: never final
  check('stabilizer emitted non-final result', (await page.textContent('#cur-name')) === 'Drilling Hole', await page.textContent('#cur-name'));
  await say('take a photo of the drill setup');
  await page.waitForTimeout(800);
  check('voice photo captured', (await page.textContent('#photo-count')).startsWith('1 photo'), await page.textContent('#photo-count'));
  await say('sealant work');
  check('sealant work -> Fay Surface Sealing', (await page.textContent('#cur-name')) === 'Fay Surface Sealing', await page.textContent('#cur-name'));
  await say('applying sealant');
  check('same element continues (no new boundary)', (await page.locator('#live-timeline .tl-bar').count()) === 3,
    String(await page.locator('#live-timeline .tl-bar').count()));
  await say('installing clecos');
  await say('scratch that');
  check('undo removed last element', (await page.textContent('#cur-name')) === 'Fay Surface Sealing', await page.textContent('#cur-name'));
  await say('pause');
  check('pause overlay shown', await page.isVisible('#pause-overlay'));
  await page.screenshot({ path: path.join(OUT, '03_paused.png') });
  await say('resume');
  check('resumed', !(await page.isVisible('#pause-overlay')));
  await page.fill('#type-input', 'waiting on the inspector');
  await page.click('#type-form button[type=submit]');
  await page.waitForTimeout(300);
  check('typed narration mapped', (await page.textContent('#cur-name')) === 'Waiting for QA', await page.textContent('#cur-name'));
  await say('he is talking to the lead about something');
  check('unmatched narration flagged', (await page.locator('#feed .tag.bad').count()) >= 1);
  await page.click('#btn-shutter');
  await page.waitForTimeout(900);
  check('shutter photo captured', (await page.textContent('#photo-count')).startsWith('2 photos'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '02_live.png') });

  // Element picker (tap fallback)
  await page.click('#btn-browse');
  await page.fill('#picker-search', 'torque');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '04_picker.png') });
  await page.click('#picker-body [data-el="FAS-07"]');
  check('picker set element', (await page.textContent('#cur-name')) === 'Torquing Fastener');

  // Gantt mode
  await page.click('#view-live [data-tlmode=gantt]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '05_live_gantt.png') });
  check('gantt rows', (await page.locator('#live-timeline .tl-grow').count()) >= 4);
  await page.click('#view-live [data-tlmode=track]');

  // Landscape iPhone
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '06_live_landscape.png') });
  await page.setViewportSize({ width: 390, height: 844 });

  // Edit a segment from the timeline
  await page.$eval('#live-timeline .tl-bar', el => el.click());
  await page.waitForSelector('#dlg-segment[open]');
  await page.screenshot({ path: path.join(OUT, '07_segment.png') });
  await page.click('#dlg-segment button[value=cancel]');

  // Complete
  await page.click('#btn-complete');
  await page.fill('#complete-notes', 'Crane delay observed at station B.');
  await page.click('#btn-complete-ok');
  await page.waitForSelector('#view-review:not([hidden])');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '08_review.png'), fullPage: true });
  check('review cards', (await page.locator('#rv-cards .mcard').count()) >= 5);
  await page.click('#rv-tabs [data-tab=totals]');
  await page.screenshot({ path: path.join(OUT, '09_totals.png'), fullPage: true });
  await page.click('#rv-tabs [data-tab=photos]');
  check('photo gallery', (await page.locator('#rv-body figure').count()) === 2);
  await page.screenshot({ path: path.join(OUT, '09b_photos.png'), fullPage: true });
  await page.click('#rv-tabs [data-tab=transcript]');
  await page.screenshot({ path: path.join(OUT, '10_transcript.png'), fullPage: true });

  // Exports: study folder LINE_SOI with photos LINE_SOI_<element #>_<element>.jpg
  const FOLDER = '1047_FAD-2284';
  const EXPECTED_PHOTOS = [`${FOLDER}_2_Drilling Hole.jpg`, `${FOLDER}_4_Waiting for QA.jpg`];
  const readZip = (file) => {
    const zbuf = fs.readFileSync(file);
    const entries = [];
    for (let o = 0; zbuf.readUInt32LE(o) === 0x04034b50;) {
      const size = zbuf.readUInt32LE(o + 18), nlen = zbuf.readUInt16LE(o + 26), xlen = zbuf.readUInt16LE(o + 28);
      const name = zbuf.toString('utf8', o + 30, o + 30 + nlen);
      entries.push({ name, data: zbuf.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + size) });
      o += 30 + nlen + xlen + size;
    }
    return entries;
  };
  const isJpeg = d => d[0] === 0xFF && d[1] === 0xD8 && d[2] === 0xFF;
  await page.click('#rv-tabs [data-tab=photos]');
  check('gallery shows file names', (await page.textContent('#rv-body')).includes(EXPECTED_PHOTOS[0]));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-save-folder')]);
  check('study folder zip named LINE_SOI', dl.suggestedFilename() === `${FOLDER}.zip`, dl.suggestedFilename());
  const zipPath = path.join(OUT, `${FOLDER}.zip`);
  await dl.saveAs(zipPath);
  const entries = readZip(zipPath);
  const names = entries.map(e => e.name);
  check('everything inside the LINE_SOI folder', names.every(n => n.startsWith(`${FOLDER}/`)), names.join(','));
  check('folder has report, CSV, WATTS JSON, study JSON',
    ['report.html', 'elements.csv', 'watts_import.json', 'study.json'].every(k => names.includes(`${FOLDER}/${FOLDER}_${k}`)), names.join(','));
  const photos = entries.filter(e => e.name.endsWith('.jpg'));
  check('photos named LINE_SOI_element#_element.jpg', JSON.stringify(photos.map(e => e.name).sort())
    === JSON.stringify(EXPECTED_PHOTOS.map(n => `${FOLDER}/${n}`).sort()), photos.map(e => e.name).join(','));
  check('exported photos are JPEG', photos.length === 2 && photos.every(e => isJpeg(e.data)));
  const report = entries.find(e => e.name.endsWith('_report.html')).data.toString('utf8');
  check('report links the renamed photos', report.includes(encodeURIComponent(EXPECTED_PHOTOS[0])));

  // Email photos through the share sheet (iPhone path)
  await page.evaluate(() => { window.__shareMode = 'share'; window.__shared = null; });
  await page.click('#btn-email-photos');
  await page.waitForFunction(() => window.__shared, null, { timeout: 10000 });
  const shared = await page.evaluate(() => window.__shared);
  check('email hands each photo to the share sheet by name', JSON.stringify(shared.files.map(f => f.name).sort())
    === JSON.stringify([...EXPECTED_PHOTOS].sort()), JSON.stringify(shared.files));
  check('emailed files are image/jpeg', shared.files.every(f => f.type === 'image/jpeg' && f.size > 1000));
  check('email text names the study', shared.text.includes('FAD-2284') && shared.text.includes('1047'), shared.text);
  // Desktop fallback: photos-only zip in the same folder
  await page.evaluate(() => { window.__shareMode = 'download'; });
  const [dlp] = await Promise.all([page.waitForEvent('download'), page.click('#btn-email-photos')]);
  const photosZip = path.join(OUT, `${FOLDER}_photos.zip`);
  await dlp.saveAs(photosZip);
  check('photo fallback zip', dlp.suggestedFilename() === `${FOLDER}_photos.zip`
    && readZip(photosZip).every(e => e.name.startsWith(`${FOLDER}/${FOLDER}_`) && isJpeg(e.data)));
  check('review shows the study was saved', (await page.textContent('#rv-sub')).includes('last'), await page.textContent('#rv-sub'));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-watts')]);
  const wattsPath = path.join(OUT, 'watts.json');
  await dl2.saveAs(wattsPath);
  const payload = JSON.parse(fs.readFileSync(wattsPath, 'utf8'));
  check('WATTS payload elements', payload.elements.length >= 4 && payload.study.time_study_type === 'VOICE', JSON.stringify(payload.elements.map(e => e.element_code)));
  check('WATTS payload totals add up', Math.abs(payload.study.va_duration_secs + payload.study.nvan_duration_secs
    + payload.study.nvaw_duration_secs + payload.study.nvad_duration_secs - payload.elements.reduce((a, e) => a + e.duration, 0) / 1000) < 0.01);

  // Persistence: reload and find the study on the home list
  await page.reload();
  await page.waitForSelector('#view-home:not([hidden])');
  check('study persisted after reload', (await page.locator('#study-list .study-item').count()) === 1);
  await page.screenshot({ path: path.join(OUT, '11_home_after.png'), fullPage: true });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail && !r.ok ? '  — ' + r.detail : ''}`);
  }
  console.log(`${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
