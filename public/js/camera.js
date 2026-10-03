// Photo capture.
//
// The live in-page viewfinder (getUserMedia) is the primary path: the shutter
// timestamp is exact and speech recognition keeps running. The native camera
// (<input capture>) is a fallback; its photos are placed using EXIF capture
// time when it is available, else the moment the analyst tapped the button.

export function liveCameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export class LiveCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this.onEnded = null;
  }

  get active() {
    return !!(this.stream && this.stream.getVideoTracks().some(t => t.readyState === 'live'));
  }

  async start(facing = this.facing) {
    this.stop();
    this.facing = facing;
    // Video only: asking for audio here would fight speech recognition for
    // the microphone on iOS.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.srcObject = this.stream;
    this.stream.getVideoTracks().forEach(t => {
      t.addEventListener('ended', () => this.onEnded && this.onEnded());
    });
    try { await this.video.play(); } catch (_) { /* autoplay will resume on gesture */ }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  async flip() {
    await this.start(this.facing === 'environment' ? 'user' : 'environment');
  }

  /** Grab the current frame. Resolves `{blob, width, height}`. */
  async capture(maxSide = 2048, quality = 0.86) {
    const v = this.video;
    if (!this.active || !v.videoWidth) throw new Error('Camera is not running');
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob, width: w, height: h };
  }
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

async function loadImage(blob) {
  if (globalThis.createImageBitmap) {
    try {
      return await globalThis.createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (_) { /* fall through to <img> (older Safari) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Downscale an image blob; used for timeline thumbnails and big native photos. */
export async function resizeImage(blob, maxSide, quality = 0.8) {
  const img = await loadImage(blob);
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  return { blob: await canvasToBlob(canvas, 'image/jpeg', quality), width: w, height: h };
}

// ── EXIF capture time ───────────────────────────────────────────────────────
/**
 * Read DateTimeOriginal (+ OffsetTimeOriginal / SubSecTimeOriginal) from a
 * JPEG. Returns epoch ms, or null when absent.
 */
export async function readExifTime(blob) {
  try {
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    return parseExifTime(new DataView(buf));
  } catch (_) {
    return null;
  }
}

export function parseExifTime(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off + 4 < dv.byteLength) {
    if (dv.getUint8(off) !== 0xFF) return null;
    const marker = dv.getUint8(off + 1);
    const len = dv.getUint16(off + 2);
    if (marker === 0xE1 && dv.getUint32(off + 4) === 0x45786966) {   // "Exif"
      return parseTiff(dv, off + 10);
    }
    if (marker === 0xDA) return null;   // start of scan: no EXIF before image data
    off += 2 + len;
  }
  return null;
}

function parseTiff(dv, base) {
  const little = dv.getUint16(base) === 0x4949;
  const u16 = o => dv.getUint16(base + o, little);
  const u32 = o => dv.getUint32(base + o, little);
  const readAscii = (entry) => {
    const count = u32(entry + 4);
    const valOff = count > 4 ? u32(entry + 8) : entry + 8;
    let s = '';
    for (let i = 0; i < count - 1 && base + valOff + i < dv.byteLength; i++) {
      const c = dv.getUint8(base + valOff + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const findTags = (ifdOff, wanted) => {
    const found = {};
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const entry = ifdOff + 2 + i * 12;
      const tag = u16(entry);
      if (wanted.includes(tag)) found[tag] = entry;
    }
    return found;
  };
  const ifd0 = u32(4);
  const t0 = findTags(ifd0, [0x8769, 0x0132]);
  let dateStr = null, offset = null, subsec = null;
  if (t0[0x8769]) {
    const exifIfd = u32(t0[0x8769] + 8);
    const t = findTags(exifIfd, [0x9003, 0x9011, 0x9291]);
    if (t[0x9003]) dateStr = readAscii(t[0x9003]);
    if (t[0x9011]) offset = readAscii(t[0x9011]);
    if (t[0x9291]) subsec = readAscii(t[0x9291]);
  }
  if (!dateStr && t0[0x0132]) dateStr = readAscii(t0[0x0132]);
  return exifDateToEpoch(dateStr, offset, subsec);
}

export function exifDateToEpoch(dateStr, offset, subsec) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dateStr || '');
  if (!m) return null;
  const ms = subsec ? Math.round(Number('0.' + subsec.replace(/\D/g, '')) * 1000) : 0;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const om = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (om) {
    const sign = om[1] === '-' ? -1 : 1;
    const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    return utc - sign * (Number(om[2]) * 60 + Number(om[3])) * 60000;
  }
  return new Date(y, mo - 1, d, h, mi, s, ms).getTime();   // camera local time
}
