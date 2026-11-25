// =========================================================================
// AIpályázó — Hungarian titles for English-language (EU) calls
// =========================================================================
// The site is Hungarian; most EU calls only have an English name. Every
// English title gets a short Hungarian title (shown everywhere as `title`),
// the official English name is kept in `titleOriginal`.
// Sources, in order:
//   1. aipalyazo/titles-hu.json cache  { id: { en, hu } }  (LLM-made, once per call)
//   2. a Hungarian gloss already in the title: "Textile circularity … (Textilkörforgás …)"
// New titles are translated by scripts/translate-titles.mjs (daily job).
// =========================================================================
const HU_CHARS = /[áéíóöőúüű]/i;
const GLOSS = /^(.*\S)\s*\(([^()]{6,})\)\s*$/;

export function isEnglishTitle(g) {
  return !!g && g.scope === 'eu' && typeof g.title === 'string' && !g.titleOriginal;
}

// { en, hu } for a call, or null when no Hungarian title is known yet.
export function hungarianTitle(g, cache = {}) {
  const title = String(g.title || '').trim();
  const m = title.match(GLOSS);
  const en = m && HU_CHARS.test(m[2]) ? m[1] : title;
  const c = cache[g.id];
  if (c && c.en === en && c.hu) return { en, hu: c.hu };
  if (m && HU_CHARS.test(m[2])) return { en: m[1], hu: m[2].trim() };
  if (HU_CHARS.test(title)) return null; // already Hungarian
  return null;
}

// Mutates and returns the list: title = Hungarian, titleOriginal = English.
export function applyHungarianTitles(grants, cache = {}) {
  let n = 0;
  for (const g of grants) {
    if (!isEnglishTitle(g)) continue;
    const t = hungarianTitle(g, cache);
    if (!t) continue;
    g.titleOriginal = t.en;
    g.title = t.hu;
    n++;
  }
  return n;
}

// Titles still needing a translation: [{ id, en }]
export function missingTitles(grants, cache = {}) {
  const out = [];
  for (const g of grants) {
    if (!isEnglishTitle(g)) continue;
    if (hungarianTitle(g, cache)) continue;
    if (HU_CHARS.test(g.title)) continue;
    out.push({ id: g.id, en: String(g.title).trim() });
  }
  return out;
}

export function buildPrompt(batch) {
  return `Translate these EU funding call titles into short, natural Hungarian titles for Hungarian company owners browsing a grant finder.
Rules: keep the meaning, plain business Hungarian, no quotation marks, max 90 characters, keep programme names and acronyms (EIC, Horizon, AI, SME→KKV), do not add facts.
Answer ONLY with JSON: {"<id>": "<Hungarian title>", ...}

${batch.map((x) => `${x.id}\t${x.en}`).join('\n')}`;
}

// Clean an untrusted model answer against the batch.
export function cleanTranslations(raw, batch) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const x of batch) {
    const hu = typeof raw[x.id] === 'string' ? raw[x.id].replace(/\s+/g, ' ').replace(/^["„”']+|["„”']+$/g, '').trim() : '';
    if (hu.length < 4 || hu.length > 140) continue;
    if (hu.toLowerCase() === x.en.toLowerCase()) continue;
    out[x.id] = { en: x.en, hu };
  }
  return out;
}
