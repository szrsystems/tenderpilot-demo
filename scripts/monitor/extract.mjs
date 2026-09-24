// =========================================================================
// AIpályázó monitor — grounded extraction ("fact check") of one page
// =========================================================================
// An LLM reads the official page text and returns the call's facts, each
// with a VERBATIM quote from the page. Nothing is trusted on the model's
// word: every quote must appear in the page text, and the deadline must be
// a date written inside its own quote. Items that fail go to human review.
//
// Providers (env): GEMINI_API_KEY (+ GEMINI_MODEL, default
// gemini-flash-lite-latest) or ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL,
// default claude-haiku-4-5). Keys are sent in headers, never in URLs.
// =========================================================================
import { norm, datesIn } from './lib.mjs';

const MAX_CHARS = 24000; // page text sent to the model (cost cap)

export const SCHEMA_HINT = `{
 "is_funding_call": true|false,        // a concrete call/product a business can apply for (not news, not a list page, not a past result)
 "status": "open"|"upcoming"|"closed"|"suspended"|"unclear",
 "title": "official name",
 "code": "official call code or null",
 "type": "grant"|"loan"|"loan+grant"|"guarantee"|"equity"|"in-kind"|"wage-subsidy"|"other",
 "cat": "KKV fejlesztés"|"Digitális átalakulás"|"Kutatás-fejlesztés"|"Energiahatékonyság"|"Export"|"Mezőgazdaság"|"Környezetvédelem"|"Turizmus"|"Oktatás"|"Munkahelyteremtés",
 "note_hu": "one short Hungarian sentence: the key eligibility condition",
 "deadline": "YYYY-MM-DD or null",     // final submission date
 "rolling": true|false,                 // continuous, until funds run out, no fixed date
 "window_open": "YYYY-MM-DD or null",   // submission starts later than today
 "amount": "short display string in the page's language, or null",
 "businesses_can_apply": true|false|null,
 "sizes": ["mikro","kis","közép","nagy"],
 "regions_note": "short, or null",
 "evidence": {                          // EXACT substrings copied from the page text, max 200 chars each
   "title": "...", "status": "...", "deadline": "... or null", "amount": "... or null", "eligibility": "... or null"
 }
}`;

export function buildPrompt(pageText, url, today) {
  return `Today is ${today} (Budapest). You check Hungarian and EU funding calls for a grant-finder used by Hungarian companies.
Read the page text below (from ${url}) and answer ONLY with JSON in this shape:
${SCHEMA_HINT}
Rules: copy evidence strings character-for-character from the page text; if a fact is not on the page use null — never guess; "closed" if the page says submission ended, the budget ran out or the call was suspended; dates in the page may be Hungarian ("2026. október 30.").

PAGE TEXT:
${pageText.slice(0, MAX_CHARS)}`;
}

async function callGemini(prompt, { key, model, fetchImpl }) {
  const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

async function callAnthropic(prompt, { key, model, fetchImpl }) {
  const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1200, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const j = await r.json();
  return (j?.content || []).map((c) => c.text || '').join('');
}

export function llmFromEnv(env = process.env, fetchImpl = fetch) {
  if (env.GEMINI_API_KEY) return (p) => callGemini(p, { key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-flash-lite-latest', fetchImpl });
  if (env.ANTHROPIC_API_KEY) return (p) => callAnthropic(p, { key: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5', fetchImpl });
  return null;
}

export function parseJsonLoose(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Does the quote really occur on the page? (whitespace/quote-mark tolerant)
export const grounded = (quote, pageText) => !!quote && quote.length >= 4 && norm(pageText).includes(norm(quote));

// Check the model's answer against the page. Returns { ok, problems, facts }.
export function validate(x, pageText, today) {
  const problems = [];
  if (!x || typeof x !== 'object') return { ok: false, problems: ['no JSON'] };
  const ev = x.evidence || {};
  if (!x.is_funding_call) problems.push('not a funding call');
  if (!grounded(ev.title, pageText)) problems.push('title not on page');
  if (!grounded(ev.status, pageText)) problems.push('status not on page');
  if (x.deadline) {
    if (!grounded(ev.deadline, pageText)) problems.push('deadline quote not on page');
    else if (!datesIn(ev.deadline).includes(x.deadline)) problems.push(`deadline ${x.deadline} not in its quote`);
    if (x.deadline < today) problems.push('deadline passed');
  } else if (!x.rolling) problems.push('no deadline and not rolling');
  if (x.amount && ev.amount && !grounded(ev.amount, pageText)) problems.push('amount quote not on page');
  if (x.businesses_can_apply === false) problems.push('businesses cannot apply');
  if (x.businesses_can_apply == null) problems.push('eligibility unclear');
  if (!['open', 'upcoming'].includes(x.status)) problems.push(`status ${x.status}`);
  return { ok: problems.length === 0, problems, facts: x };
}

export async function extractFacts(page, { llm, today }) {
  if (!llm) return { ok: false, problems: ['no LLM key configured'] };
  const raw = await llm(buildPrompt(page.text, page.finalUrl || page.url, today));
  return validate(parseJsonLoose(raw), page.text, today);
}
