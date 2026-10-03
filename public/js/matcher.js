// Local (on-device) narration matcher.
//
// Gives an instant, offline best guess for which standard element an
// utterance names, plus a strict grammar for spoken app commands. The server
// LLM is consulted only when this matcher is unsure.

const STOPWORDS = new Set((
  'a an the and or but is are was were be been being am he she they it its his her their them ' +
  'him we i im i\'m you your s re ll ve d m to of on in at for with from by into onto over that ' +
  'this these those there here just okay ok um uh uhh so now currently still going gonna go goes ' +
  'start starting started starts begin begins beginning began doing does do did some more another ' +
  'again back mechanic mechanics guy guys person operator worker tech technician looks like ' +
  'appears seems kind sort basically actually also then next as well very really little bit ' +
  'one two three four five left right side area about please'
).split(/\s+/));

// Canonical forms applied before stemming (domain words the suffix rules mangle).
const CANON = {
  installation: 'install', installing: 'install', installed: 'install', installs: 'install',
  inspection: 'inspect', inspecting: 'inspect', inspector: 'inspect', inspected: 'inspect',
  verification: 'verify', verifying: 'verify', verified: 'verify',
  documentation: 'document', documenting: 'document', documented: 'document',
  sealant: 'seal', sealer: 'seal', sealants: 'seal',
  cannot: 'cant', "can't": 'cant', cant: 'cant',
  hilok: 'hilok', hiloks: 'hilok', 'hi-lok': 'hilok',
  csink: 'countersink', 'c-sink': 'countersink',
  qa: 'qa', q: 'qa',
  engr: 'engineer', engineering: 'engineer', engineers: 'engineer',
  equip: 'equipment',
  instr: 'instruction', instructions: 'instruction',
  insp: 'inspect',
  fasteners: 'fastener', fastening: 'fastener',
  clecko: 'cleco', clecoes: 'cleco', clekos: 'cleco',
  torqueing: 'torque', torquing: 'torque', torqued: 'torque', torques: 'torque',
  debur: 'deburr', debar: 'deburr', deburing: 'deburr',
  waiting: 'wait', waited: 'wait', waits: 'wait',
  searching: 'search', looking: 'look', hunting: 'search',
};

// Multi-word fixes for common speech-recognition spellings.
const PHRASE_FIXES = [
  [/\bhigh[\s-]?lo(?:c?k)s?\b/g, 'hilok'],
  [/\bhi[\s-]?lo(?:c?k)s?\b/g, 'hilok'],
  [/\bhi[\s-]?lite\b/g, 'hilite'],
  [/\bq\s*a\b/g, 'qa'],
  [/\bc[\s-]sink\b/g, 'countersink'],
  [/\bfae\b|\bfey\b|\bfay\b/g, 'fay'],
  [/\bzip[\s-]?ties?\b/g, 'zip tie'],
  [/\bn\s*d\s*i\b/g, 'ndi'],
  [/\bn\s*d\s*t\b/g, 'ndt'],
  [/\bf\s*o\s*d\b/g, 'fod'],
  [/\bm\s*e\s*s\b/g, 'mes'],
];

export function normalizeText(text) {
  let s = String(text || '').toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"');
  for (const [re, rep] of PHRASE_FIXES) s = s.replace(re, rep);
  // "re-drilling" / "re drilling" -> "redrilling" so rework stays distinct.
  s = s.replace(/\bre[\s-]+(?=[a-z]{4,})/g, 're');
  return s.replace(/[^a-z0-9'\s-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stem(word) {
  let w = word.replace(/'/g, '');
  // Canonical forms still go through the suffix rules so "torquing" -> "torque"
  // and "torque" end up as the same stem.
  w = CANON[word] || CANON[w] || w;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('ment') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('es') && w.length > 4 && /(sh|ch|x|ss|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  if (w.length > 3 && /([bcdfgklmnprtvz])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function tokenize(text, { keepStopwords = false } = {}) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const out = [];
  for (const w of words) {
    if (!keepStopwords && STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s) out.push(s);
  }
  return out;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function tokenSim(a, b) {
  if (a === b) return 1;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (short.length >= 4 && long.startsWith(short)) return 0.85;
  if (short.length >= 5) {
    const d = levenshtein(a, b, 2);
    if (d === 1) return 0.8;
    if (d === 2 && short.length >= 7) return 0.65;
  }
  return 0;
}

// Words that, when present, mark a later clause as the current action.
const CLAUSE_SPLIT = /\b(?:now|then|and then|switching to|switched to|moving on to|moved on to|moves on to|goes to|back to|onto)\b|[,.;!?]/;

const AUTO_SCORE = 0.72, AUTO_MARGIN = 0.12, TENTATIVE_SCORE = 0.45;

export function buildMatcher(catalog) {
  const elements = [];
  for (const cat of catalog.categories) {
    for (const el of cat.elements) {
      elements.push({ ...el, category: cat.name, categoryCode: cat.code });
    }
  }
  // Phrases per element: its name, its aliases and "category + name".
  const phrases = [];
  for (const el of elements) {
    const texts = [el.name, ...(el.aliases || [])];
    for (const text of texts) {
      const toks = tokenize(text);
      if (toks.length) phrases.push({ id: el.id, text, toks });
    }
  }
  // IDF over phrase vocabulary: distinctive words ("hilok") outweigh common ones ("test").
  const df = new Map();
  for (const el of elements) {
    const seen = new Set();
    for (const p of phrases) if (p.id === el.id) p.toks.forEach(t => seen.add(t));
    seen.forEach(t => df.set(t, (df.get(t) || 0) + 1));
  }
  const N = elements.length;
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + N / n)]));
  const maxIdf = Math.max(...idf.values());
  const weight = t => idf.get(t) ?? maxIdf * 0.25;  // unknown words count a little
  const byId = Object.fromEntries(elements.map(e => [e.id, e]));

  function bestSim(tok, toks) {
    let best = 0;
    for (const o of toks) { const s = tokenSim(tok, o); if (s > best) best = s; if (best === 1) break; }
    return best;
  }

  function contiguous(phraseToks, uttToks) {
    if (phraseToks.length < 2) return uttToks.includes(phraseToks[0]);
    outer: for (let i = 0; i + phraseToks.length <= uttToks.length; i++) {
      for (let j = 0; j < phraseToks.length; j++) if (uttToks[i + j] !== phraseToks[j]) continue outer;
      return true;
    }
    return false;
  }

  function scoreTokens(uttToks) {
    const scores = new Map();
    if (!uttToks.length) return scores;
    const uttW = uttToks.reduce((a, t) => a + weight(t), 0);
    for (const p of phrases) {
      const pW = p.toks.reduce((a, t) => a + weight(t), 0);
      let covP = 0;
      for (const t of p.toks) covP += weight(t) * bestSim(t, uttToks);
      covP /= pW;
      if (covP < 0.34) continue;
      let covU = 0;
      for (const t of uttToks) covU += weight(t) * bestSim(t, p.toks);
      covU /= uttW;
      // Raw score can exceed 1 (exact-phrase bonuses) so ties at "perfect"
      // still rank the more specific phrase first; it is capped for display.
      let score = 0.6 * covP + 0.4 * covU;
      if (covP === 1 && contiguous(p.toks, uttToks)) {
        score += Math.min(0.15, 0.05 * p.toks.length);
        if (covU === 1) score += 0.1;
      }
      if (score > (scores.get(p.id)?.score ?? 0)) scores.set(p.id, { score, phrase: p.text });
    }
    return scores;
  }

  function rank(scores) {
    return [...scores.entries()]
      .map(([id, v]) => ({ id, raw: v.score, score: Math.round(Math.min(1, v.score) * 1000) / 1000,
        phrase: v.phrase }))
      .sort((a, b) => b.raw - a.raw);
  }

  /** Rank catalog elements for an utterance. */
  function match(text) {
    const full = tokenize(text);
    let ranked = rank(scoreTokens(full));
    // "finished drilling, now deburring" -> the last clause is the current action.
    const clauses = String(text).toLowerCase().split(CLAUSE_SPLIT)
      .map(c => c && c.trim()).filter(Boolean);
    if (clauses.length > 1) {
      const lastToks = tokenize(clauses[clauses.length - 1]);
      if (lastToks.length) {
        const lastRanked = rank(scoreTokens(lastToks));
        if (lastRanked[0] && lastRanked[0].score >= TENTATIVE_SCORE) {
          const merged = new Map(lastRanked.map(r => [r.id, r]));
          for (const r of ranked) {
            const raw = r.raw * 0.8;
            const damped = { ...r, raw, score: Math.round(Math.min(1, raw) * 1000) / 1000 };
            if (!merged.has(r.id) || merged.get(r.id).raw < raw) merged.set(r.id, damped);
          }
          ranked = [...merged.values()].sort((a, b) => b.raw - a.raw);
        }
      }
    }
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    const margin = top ? Math.min(1, top.raw - (second ? second.raw : 0)) : 0;
    let decision = 'none';
    if (top && top.score >= AUTO_SCORE && margin >= AUTO_MARGIN && !byId[top.id]?.requiresDescription) {
      decision = 'auto';
    } else if (top && top.score >= TENTATIVE_SCORE) {
      decision = 'tentative';
    }
    return { decision, top, margin: Math.round(margin * 1000) / 1000, candidates: ranked.slice(0, 5) };
  }

  /** Free-text search for the element picker. */
  function search(query, limit = 12) {
    const toks = tokenize(query);
    if (!toks.length) return [];
    const q = normalizeText(query);
    const ranked = rank(scoreTokens(toks));
    // Prefix search on names/codes so typing "tor" finds Torquing quickly.
    for (const el of elements) {
      const name = normalizeText(el.name);
      if ((name.startsWith(q) || el.id.toLowerCase().startsWith(q)) && !ranked.some(r => r.id === el.id)) {
        ranked.push({ id: el.id, raw: 0.5, score: 0.5, phrase: el.name });
      }
    }
    return ranked.slice(0, limit);
  }

  return { match, search, elements, byId };
}

// ── Spoken app commands ────────────────────────────────────────────────────
const WAKE = /^(?:hey |ok |okay )?watts\b[\s,]*/;
const PLEASE = /\s*(?:please|now|thanks|thank you)$/;
const COMMANDS = [
  ['pause', /^(?:pause|hold|hold on|hold it|stop the clock|pause (?:the )?(?:study|timer|clock|recording|time study))$/],
  ['resume', /^(?:resume|unpause|continue|keep going|start again|restart the clock|resume (?:the )?(?:study|timer|clock|recording|time study)|continue (?:the )?(?:study|time study|timer))$/],
  ['undo', /^(?:undo|undo that|undo last|scratch that|cancel that|never ?mind|delete that|delete last|that'?s wrong|wrong one|remove that)$/],
  ['complete', /^(?:end|complete|finish|stop|close) (?:the )?(?:study|time study|observation|timing)$/],
];
const PHOTO = /^(?:(?:take|snap|grab|capture) (?:a |the )?(?:photo|picture|pic|snapshot|image|shot)|(?:photo|picture|snapshot|snap ?shot|snap|capture)(?: this| that| it)?)(?:\s+(?:of|showing|with)\s+(.*))?$/;
const NOTE = /^(?:note|comment|observation|remark|add (?:a )?note)\s*:?\s*(?:that\s+)?(.+)$/;

/**
 * Parse a spoken app command. Commands must be the whole utterance (optionally
 * prefixed with "Watts"), so narration like "he paused to read the drawing"
 * is never mistaken for "pause".
 */
export function parseCommand(text) {
  let s = normalizeText(text);
  const woke = WAKE.test(s);
  s = s.replace(WAKE, '').replace(PLEASE, '').trim();
  if (!s) return null;
  for (const [command, re] of COMMANDS) {
    if (re.test(s)) return { command, woke };
  }
  const photo = s.match(PHOTO);
  if (photo) return { command: 'photo', caption: (photo[1] || '').trim(), woke };
  const note = s.match(NOTE);
  if (note) return { command: 'note', note: String(text).replace(/^.*?\b(?:note|comment|observation|remark)\b\s*:?\s*(?:that\s+)?/i, '').trim() || note[1], woke };
  return null;
}
