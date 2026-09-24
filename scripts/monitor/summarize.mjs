// =========================================================================
// AIpályázó — official call summaries ("A felhívás röviden")
// =========================================================================
// For every listed call the AI reads the OFFICIAL source text (the issuer's
// page, or for EU topics the portal's own topicDetails JSON) and writes a
// short sheet: who can apply, what the money is for, how much, own
// contribution, how to apply, what to watch out for.
// Every line must carry a verbatim quote from the source; lines whose quote
// is not on the page are dropped. A summary is published only with at least
// 3 grounded lines, and regenerated only when the source text changes.
// =========================================================================
import { hash, htmlToText } from './lib.mjs';
import { grounded, parseJsonLoose } from './extract.mjs';

export const SECTIONS = [
  ['who', 'Ki pályázhat'],
  ['what', 'Mire fordítható'],
  ['money', 'Összeg és támogatási arány'],
  ['own', 'Önerő és feltételek'],
  ['how', 'Beadás és határidők'],
  ['watch', 'Mire figyeljen'],
];
const MIN_TEXT = 700;       // shorter pages (JS shells, empty pages) are skipped
const MAX_CHARS = 30000;

export function summaryPrompt(text, url, title) {
  return `Egy magyar pályázatkereső oldalnak készítesz rövid, közérthető összefoglalót egy támogatási felhívásról (${title}, forrás: ${url}).
CSAK az alábbi hivatalos szövegből dolgozz. Válasz KIZÁRÓLAG JSON, ebben a formában:
{"items":[{"section":"who|what|money|own|how|watch","text":"egy rövid magyar mondat, max 160 karakter","quote":"a forrásszöveg PONTOS, betű szerinti részlete (max 200 karakter), amire a mondat épül"}]}
Szabályok: szekciónként 1–3 pont; ami nincs a szövegben, azt hagyd ki, ne találj ki semmit; angol forrásnál a "text" magyar, a "quote" az eredeti angol részlet; ne ismételd a címet.

HIVATALOS SZÖVEG:
${text.slice(0, MAX_CHARS)}`;
}

// Keep only lines whose quote is really in the source; group by section.
export function validateSummary(raw, sourceText) {
  const x = typeof raw === 'string' ? parseJsonLoose(raw) : raw;
  const items = Array.isArray(x && x.items) ? x.items : [];
  const valid = new Set(SECTIONS.map(([k]) => k));
  const kept = [];
  let dropped = 0;
  for (const it of items) {
    if (!it || !valid.has(it.section) || !it.text || String(it.text).length > 240) { dropped++; continue; }
    if (!grounded(String(it.quote || ''), sourceText)) { dropped++; continue; }
    kept.push({ section: it.section, text: String(it.text).trim(), quote: String(it.quote).trim().slice(0, 240) });
  }
  const sections = SECTIONS.map(([key, title]) => ({ key, title, items: kept.filter((k) => k.section === key).slice(0, 3).map(({ text, quote }) => ({ text, quote })) }))
    .filter((s) => s.items.length);
  return { ok: kept.length >= 3, sections, kept: kept.length, dropped };
}

// Official source text for an item: EU topic JSON (description + conditions)
// or the page itself. Returns { text, url } or null.
export async function sourceText(g, fetchPage) {
  const m = String(g.url || '').match(/\/topic-details\/([a-z0-9._-]+)/i);
  if (m) {
    const url = `https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/${m[1].toLowerCase()}.json`;
    const r = await fetchPage(url);
    const t = r.json && (r.json.TopicDetails || r.json);
    if (!t) return null;
    const text = [t.title, htmlToText(t.description || ''), htmlToText(t.conditions || '')].filter(Boolean).join('\n\n');
    return text.length >= MIN_TEXT ? { text, url: g.url } : null;
  }
  if (!g.url) return null;
  const r = await fetchPage(g.url);
  if (r.status !== 200 || !r.text || r.text.length < MIN_TEXT) return null;
  return { text: r.text, url: r.finalUrl || g.url };
}

// Update summaries for all items; only new/changed sources hit the LLM.
export async function updateSummaries({ items, prev = {}, fetchPage, llm, today, maxCalls = 40 }) {
  const out = {};
  const ids = new Set(items.map((g) => g.id));
  let calls = 0, made = 0, kept = 0, skipped = 0, failed = 0;
  for (const [id, s] of Object.entries(prev)) if (ids.has(id)) out[id] = s; // drop summaries of removed calls
  for (const g of items) {
    const src = await sourceText(g, fetchPage).catch(() => null);
    if (!src) { skipped++; continue; }
    const h = hash(src.text);
    if (out[g.id] && out[g.id].sourceHash === h) { kept++; continue; }
    if (!llm || calls >= maxCalls) { skipped++; continue; }
    calls++;
    try {
      const v = validateSummary(await llm(summaryPrompt(src.text, src.url, g.title)), src.text);
      if (v.ok) { out[g.id] = { sourceUrl: src.url, sourceHash: h, generatedAt: today, sections: v.sections }; made++; }
      else failed++;
    } catch { failed++; }
  }
  return { summaries: out, stats: { calls, made, kept, skipped, failed } };
}
