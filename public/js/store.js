// On-device persistence (IndexedDB). Studies and photo blobs never leave the
// device unless the analyst exports them; iPad Safari can reload a tab at any
// time, so every change is written here immediately.

const DB_NAME = 'watts-voice';
const DB_VERSION = 1;
let dbPromise = null;
const memory = { studies: new Map(), photos: new Map(), kv: new Map() };
let useMemory = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      useMemory = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('studies')) db.createObjectStore('studies', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const ps = db.createObjectStore('photos', { keyPath: 'id' });
        ps.createIndex('studyId', 'studyId', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { useMemory = true; resolve(null); };
    req.onblocked = () => { useMemory = true; resolve(null); };
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function isPersistentStorage() {
  return !useMemory;
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (_) { /* not supported */ }
  return null;
}

// ── Studies ───────────────────────────────────────────────────────────────
export async function saveStudy(study) {
  study.updatedAt = Date.now();
  const db = await openDb();
  // Structured clone keeps the stored copy independent of the live object.
  const copy = JSON.parse(JSON.stringify(study));
  if (!db) { memory.studies.set(study.id, copy); return; }
  await tx(db, 'studies', 'readwrite', s => s.put(copy));
}

export async function getStudy(id) {
  const db = await openDb();
  if (!db) return memory.studies.get(id) || null;
  return (await tx(db, 'studies', 'readonly', s => reqP(s.get(id)))) || null;
}

export async function listStudies() {
  const db = await openDb();
  const all = db ? await tx(db, 'studies', 'readonly', s => reqP(s.getAll())) : [...memory.studies.values()];
  return (all || []).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function deleteStudy(id) {
  const db = await openDb();
  await deletePhotosForStudy(id);
  if (!db) { memory.studies.delete(id); return; }
  await tx(db, 'studies', 'readwrite', s => s.delete(id));
}

// ── Photos ────────────────────────────────────────────────────────────────
export async function savePhoto({ id, studyId, blob, thumb }) {
  const db = await openDb();
  const rec = { id, studyId, blob, thumb, savedAt: Date.now() };
  if (!db) { memory.photos.set(id, rec); return; }
  await tx(db, 'photos', 'readwrite', s => s.put(rec));
}

export async function getPhoto(id) {
  const db = await openDb();
  if (!db) return memory.photos.get(id) || null;
  return (await tx(db, 'photos', 'readonly', s => reqP(s.get(id)))) || null;
}

export async function getPhotosForStudy(studyId) {
  const db = await openDb();
  if (!db) return [...memory.photos.values()].filter(p => p.studyId === studyId);
  return tx(db, 'photos', 'readonly', s => reqP(s.index('studyId').getAll(studyId)));
}

export async function deletePhoto(id) {
  const db = await openDb();
  if (!db) { memory.photos.delete(id); return; }
  await tx(db, 'photos', 'readwrite', s => s.delete(id));
}

export async function deletePhotosForStudy(studyId) {
  const db = await openDb();
  if (!db) {
    for (const [k, v] of memory.photos) if (v.studyId === studyId) memory.photos.delete(k);
    return;
  }
  const keys = await tx(db, 'photos', 'readonly', s => reqP(s.index('studyId').getAllKeys(studyId)));
  if (keys && keys.length) await tx(db, 'photos', 'readwrite', s => { keys.forEach(k => s.delete(k)); });
}

// ── Key/value (settings, cached catalog) ──────────────────────────────────
export async function kvGet(key) {
  const db = await openDb();
  if (!db) return memory.kv.get(key);
  return tx(db, 'kv', 'readonly', s => reqP(s.get(key)));
}

export async function kvSet(key, value) {
  const db = await openDb();
  if (!db) { memory.kv.set(key, value); return; }
  await tx(db, 'kv', 'readwrite', s => s.put(value, key));
}
