// Speech capture engines.
//
//  BrowserEngine — Web Speech API (Safari = Siri dictation, Chrome = Google,
//                  Edge = Azure). Continuous, interim results, no server cost.
//  ServerEngine  — records PCM in the page, cuts utterances with a voice-
//                  activity detector (or push-to-talk) and sends WAV clips to
//                  /api/transcribe. Used where Web Speech is missing (Firefox)
//                  or when higher-accuracy server transcription is preferred.
//
// Both emit `onUtterance({t, text, engine, confidence, alternatives})` where
// `t` is when the analyst *started* speaking — that, not the moment the text
// arrived, is the element's start time.

const SpeechRecognitionCtor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export function browserSpeechSupported() {
  return !!SpeechRecognitionCtor;
}

export function serverCaptureSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (globalThis.AudioContext || globalThis.webkitAudioContext));
}

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const STABLE_MS = 1300;       // interim text unchanged this long counts as final (iOS quirk)

export class BrowserEngine {
  constructor({ lang = 'en-US', onUtterance, onInterim, onState, latencyMs = 400 }) {
    this.lang = lang;
    this.onUtterance = onUtterance;
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.latencyMs = latencyMs;
    this.want = false;
    this.rec = null;
    this.session = 0;
    this.keys = new Map();     // resultKey -> {firstAt, text, changedAt, emitted}
    this.restarts = [];
    this.pttStart = null;
    this.stabilizer = null;
  }

  get name() { return 'browser'; }

  start() {
    this.want = true;
    // Drop a recognizer iOS may have left half-alive (e.g. after backgrounding).
    try { this.rec && this.rec.abort(); } catch (_) { /* already ended */ }
    this._startRec();
    clearInterval(this.stabilizer);
    this.stabilizer = setInterval(() => this._flushStable(), 300);
  }

  stop() {
    this.want = false;
    clearInterval(this.stabilizer);
    this._flushAll();
    try { this.rec && this.rec.abort(); } catch (_) { /* already stopped */ }
    this.rec = null;
    this.onState('off');
  }

  /** Push-to-talk: utterance time is the press, not when text arrives. */
  pttDown() {
    this.pttStart = Date.now();
    if (!this.want) { this.want = true; this._startRec(); }
  }

  pttUp() {
    this.want = false;
    // Give the recognizer a moment to deliver the final result, then stop.
    setTimeout(() => { try { this.rec && this.rec.stop(); } catch (_) { /* noop */ } }, 350);
  }

  _startRec() {
    if (!SpeechRecognitionCtor) { this.onState('error', 'Speech recognition is not available in this browser.'); return; }
    const rec = new SpeechRecognitionCtor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    const session = ++this.session;
    rec.onstart = () => this.onState('listening');
    rec.onresult = (e) => this._onResult(e, session);
    rec.onerror = (e) => this._onError(e);
    rec.onend = () => this._onEnd(session);
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      // InvalidStateError when a previous session hasn't fully ended yet.
      setTimeout(() => this.want && this._startRec(), 400);
    }
  }

  _onResult(e, session) {
    const now = Date.now();
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const key = `${session}:${i}`;
      const text = (r[0] && r[0].transcript || '').trim();
      let k = this.keys.get(key);
      if (!k) {
        k = { firstAt: now - this.latencyMs, text: '', changedAt: now, emitted: '', deltaAt: null };
        if (this.pttStart) { k.firstAt = this.pttStart; this.pttStart = null; }
        this.keys.set(key, k);
      }
      if (text !== k.text) {
        // Words added after an earlier emission of this result start a new
        // utterance; remember when they began.
        if (k.emitted && k.deltaAt == null) k.deltaAt = now - this.latencyMs;
        k.text = text; k.changedAt = now;
      }
      if (r.isFinal) {
        const alts = [];
        for (let a = 1; a < r.length; a++) if (r[a] && r[a].transcript) alts.push(r[a].transcript.trim());
        this._emit(k, text, r[0].confidence, alts);
      } else {
        interim += (interim ? ' ' : '') + text.slice(k.emitted.length).trim();
      }
    }
    this.onInterim(interim);
  }

  /** Emit only the part of `text` not already emitted for this result. */
  _emit(k, text, confidence = null, alternatives = []) {
    let fresh = text;
    if (k.emitted && text.toLowerCase().startsWith(k.emitted.toLowerCase())) {
      fresh = text.slice(k.emitted.length);
    } else if (k.emitted && k.emitted.toLowerCase() === text.toLowerCase()) {
      fresh = '';
    }
    fresh = fresh.trim();
    if (fresh.replace(/[^a-z0-9]/gi, '').length < 2) return;
    const t = k.emitted ? (k.deltaAt ?? k.changedAt - this.latencyMs) : k.firstAt;
    k.emitted = text;
    k.deltaAt = null;
    this.onInterim('');
    this.onUtterance({ t, text: fresh, engine: 'browser', confidence: confidence || null, alternatives });
  }

  // iOS Safari sometimes never marks results final in continuous mode; treat
  // interim text that has stopped changing as final.
  _flushStable() {
    const now = Date.now();
    for (const k of this.keys.values()) {
      if (k.text && k.text !== k.emitted && now - k.changedAt >= STABLE_MS) this._emit(k, k.text);
    }
    if (this.keys.size > 200) {
      for (const [key, k] of this.keys) if (k.text === k.emitted) this.keys.delete(key);
    }
  }

  _flushAll() {
    for (const k of this.keys.values()) if (k.text && k.text !== k.emitted) this._emit(k, k.text);
  }

  _onError(e) {
    const err = e.error || 'unknown';
    if (err === 'no-speech' || err === 'aborted') return;
    // iOS revokes the mic in the background; the app restarts us on return.
    if (isHidden()) return;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      this.want = false;
      this.onState('error', 'Microphone or dictation access was denied. On iPad/iPhone enable Dictation '
        + '(Settings › General › Keyboard) and allow the microphone for this site.');
      return;
    }
    if (err === 'audio-capture') {
      this.onState('error', 'No microphone available (is another app using it?).');
      return;
    }
    if (err === 'network') {
      this.onState('error', 'Speech service unreachable — retrying. Typed narration and taps still work.');
      return;
    }
    this.onState('error', `Speech recognition error: ${err}`);
  }

  _onEnd(session) {
    if (session !== this.session) return;
    this._flushAll();
    if (!this.want) { this.onState('off'); return; }
    if (isHidden()) { this.onState('restarting'); return; }   // resumed on visibilitychange
    // Recognizers stop after silence / ~1 min; restart, backing off if it is
    // flapping (e.g. no network).
    const now = Date.now();
    this.restarts = this.restarts.filter(t => now - t < 10000);
    this.restarts.push(now);
    const delay = this.restarts.length > 6 ? 3000 : 250;
    this.onState('restarting');
    setTimeout(() => { if (this.want) this._startRec(); }, delay);
  }
}

// ── Server transcription engine ─────────────────────────────────────────────
const TARGET_RATE = 16000;

export class ServerEngine {
  constructor({ mode = 'vad', transcribe, onUtterance, onInterim, onState, onLevel }) {
    this.mode = mode;                 // 'vad' (hands-free) | 'ptt'
    this.transcribe = transcribe;     // async (wavBlob) => text
    this.onUtterance = onUtterance;
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.ctx = null;
    this.stream = null;
    this.chunks = [];                 // [{t, data: Float32Array}]
    this.noiseDb = -60;
    this.inSpeech = false;
    this.speechFrames = 0;
    this.silentMs = 0;
    this.segStart = null;
    this.pttActive = false;
    this.pttAt = null;
  }

  get name() { return 'server'; }

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.onState('error', 'Microphone access was denied.');
      throw e;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const proc = this.ctx.createScriptProcessor(2048, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => this._onAudio(e.inputBuffer.getChannelData(0));
    src.connect(proc);
    proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.nodes = { src, proc, mute };
    this.onState('listening');
  }

  stop() {
    try { this.nodes && this.nodes.proc.disconnect(); } catch (_) { /* noop */ }
    try { this.ctx && this.ctx.close(); } catch (_) { /* noop */ }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.ctx = null; this.stream = null; this.chunks = [];
    this.onState('off');
  }

  pttDown() { this.pttActive = true; this.pttAt = Date.now(); this.segStart = this.pttAt; }

  pttUp() {
    if (!this.pttActive) return;
    this.pttActive = false;
    this._finishSegment(this.pttAt - 200, Date.now());
  }

  _onAudio(input) {
    const now = Date.now();
    const data = new Float32Array(input);
    const frameMs = (data.length / this.ctx.sampleRate) * 1000;
    this.chunks.push({ t: now - frameMs, data });
    // Keep ~20 s of audio for pre-roll and the longest utterance.
    while (this.chunks.length && now - this.chunks[0].t > 20000) this.chunks.shift();

    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const db = 10 * Math.log10(sum / data.length + 1e-12);
    this.onLevel(Math.max(0, Math.min(1, (db + 70) / 60)));
    if (this.mode !== 'vad') return;

    const threshold = Math.max(this.noiseDb + 10, -52);
    if (db > threshold) {
      this.speechFrames++;
      this.silentMs = 0;
      if (!this.inSpeech && this.speechFrames >= 3) {
        this.inSpeech = true;
        this.segStart = now - this.speechFrames * frameMs - 300;   // pre-roll
        this.onInterim('…');
      }
    } else {
      this.speechFrames = 0;
      // Track the factory's background noise level while nobody is talking.
      if (!this.inSpeech) this.noiseDb = this.noiseDb * 0.97 + db * 0.03;
      if (this.inSpeech) {
        this.silentMs += frameMs;
        if (this.silentMs > 750) {
          this.inSpeech = false;
          this._finishSegment(this.segStart, now - this.silentMs + 200);
        }
      }
    }
    if (this.inSpeech && now - this.segStart > 12000) {
      // Long monologue: cut it so element changes inside it are not delayed.
      this._finishSegment(this.segStart, now);
      this.segStart = now;
    }
  }

  async _finishSegment(start, end) {
    if (!this.ctx || end - start < 350) return;
    const parts = this.chunks.filter(c => c.t + 50 >= start && c.t <= end).map(c => c.data);
    if (!parts.length) return;
    const wav = encodeWav(parts, this.ctx.sampleRate, TARGET_RATE);
    this.onInterim('Transcribing…');
    try {
      const text = (await this.transcribe(wav)).trim();
      this.onInterim('');
      if (text && text.replace(/[^a-z0-9]/gi, '').length >= 2) {
        this.onUtterance({ t: start, text, engine: 'server', confidence: null, alternatives: [] });
      }
    } catch (e) {
      this.onInterim('');
      this.onState('error', `Transcription failed: ${e.message || e}`);
    }
  }
}

/** Float32 chunks at `inRate` -> 16-bit mono WAV at `outRate`. */
export function encodeWav(parts, inRate, outRate) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const ratio = inRate / outRate;
  const outLen = Math.floor(total / ratio);
  const samples = new Int16Array(outLen);
  let pi = 0, po = 0, consumed = 0;
  for (let o = 0; o < outLen; o++) {
    // Average the input samples that fall into this output sample (anti-alias).
    const startIdx = Math.floor(o * ratio), endIdx = Math.floor((o + 1) * ratio);
    let acc = 0, n = 0;
    for (let i = startIdx; i < endIdx; i++) {
      while (pi < parts.length && i - consumed >= parts[pi].length) { consumed += parts[pi].length; pi++; }
      if (pi >= parts.length) break;
      acc += parts[pi][i - consumed]; n++;
    }
    const v = n ? acc / n : 0;
    samples[po++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return new Blob([buf], { type: 'audio/wav' });
}
