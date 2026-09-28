// =========================================================================
// AIpályázó — AI generation proxy (Supabase Edge Function)
// =========================================================================
// Tasks:
//   task:"draft"   → Hungarian grant-draft (9 sections). Any signed-in user.
//   task:"needs"   → free-text need → categories + keywords. Any signed-in user.
//   task:"extract" → cron only (x-cron-secret): scraped page → grant record.
//
// Hardening (2026-09-28):
//   * every client field is length-capped (strings ≤2k, arrays ≤50 items);
//   * the grant is looked up server-side in the live feed (GRANTS_URL) by
//     payload.grant.id (then code, then exact title); client grant text is
//     only a capped fallback when the call is not in the feed;
//   * the per-user limiter fails CLOSED (RPC error → 429) and a global daily
//     cap (AI_GLOBAL_DAILY_CAP, default 500) protects the budget;
//   * the Gemini key goes in the x-goog-api-key header, never the URL;
//   * error details are logged, never returned.
//
// Deploy:  supabase functions deploy ai-generate --project-ref kacnvchwfwvpkkyhyupb
// Secrets: GEMINI_API_KEY, (ANTHROPIC_API_KEY), AI_PROVIDER, GEMINI_MODEL,
//          ANTHROPIC_MODEL, CRON_SECRET, AI_GLOBAL_DAILY_CAP, GRANTS_URL
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearer, corsHeaders, jsonResponse, makeEnv, type Env } from '../_shared/http.ts';
import { createGrantFeed, type Grant, type GrantFeed } from '../_shared/grants.ts';
import { timingSafeEqual } from '../_shared/lead-token.ts';

export const LIMIT_DRAFT = 25;   // drafts per user per day
export const LIMIT_NEEDS = 100;  // needs-finder calls per user per day
const MAX_STR = 2000;
const MAX_ARR = 50;

export type Deps = {
  env?: Record<string, string | undefined>;
  getUserId?: (jwt: string) => Promise<string | null>;
  /** per-user daily counter; true = allowed. Throwing = not allowed. */
  bumpUser?: (userId: string, limit: number) => Promise<boolean>;
  /** global daily counter; true = allowed. Throwing = not allowed. */
  bumpGlobal?: (limit: number) => Promise<boolean>;
  generate?: (prompt: string, schema: any) => Promise<any>;
  grants?: GrantFeed;
};

const SECTION_TITLES = [
  'Projekt összefoglaló', 'Pályázó bemutatása', 'Projekt célja és indokoltsága',
  'Tervezett tevékenységek', 'Indikátorok és vállalások', 'Költségvetés-tervezet',
  'Megvalósítási ütemterv', 'Fenntarthatósági terv', 'Kockázatok és kezelésük',
];

// ---- Input caps -----------------------------------------------------------
export function capStr(v: unknown, n = MAX_STR): string {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return '';
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
}
export function capArr(v: unknown, n = MAX_ARR, each = 200): string[] {
  return Array.isArray(v) ? v.slice(0, n).map((x) => capStr(x, each)).filter(Boolean) : [];
}

type GrantFields = { title: string; cat: string; amount: string; deadline: string; source: string; code: string; issuer: string; type: string; rate: string; note: string; url: string };

function grantFromClient(g: any): GrantFields {
  const o = g && typeof g === 'object' ? g : {};
  return {
    title: capStr(o.title, 300), cat: capStr(o.cat, 100), amount: capStr(o.amount, 200), deadline: capStr(o.deadline, 40),
    source: capStr(o.source, 200), code: capStr(o.code, 80), issuer: capStr(o.issuer, 200), type: capStr(o.type, 30),
    rate: capStr(o.rate, 120), note: capStr(o.note, MAX_STR), url: capStr(o.url, 300),
  };
}
function grantFromFeed(g: Grant, client: GrantFields): GrantFields {
  return {
    title: capStr(g.title, 300), cat: capStr(g.cat, 100), amount: capStr(g.amount, 200), deadline: capStr(g.deadline, 40),
    source: capStr(g.source, 200), code: capStr(g.code, 80), issuer: capStr(g.issuer, 200), type: capStr(g.type, 30),
    rate: capStr((g as any).rate ?? client.rate, 120), note: capStr(g.note, MAX_STR), url: capStr(g.url, 300),
  };
}

/** Official grant data: by id, else by call code, else by exact title. */
export async function resolveGrant(raw: any, feed: GrantFeed): Promise<{ grant: GrantFields; fromFeed: boolean }> {
  const client = grantFromClient(raw);
  try {
    const id = typeof raw?.id === 'string' ? raw.id.slice(0, 200) : '';
    let g: Grant | null = id ? await feed.byId(id) : null;
    if (!g && (client.code || client.title)) {
      const all = await feed.all();
      g = (client.code && all.find((x) => x.code === client.code)) || (client.title && all.find((x) => x.title === client.title)) || null;
    }
    if (g) return { grant: grantFromFeed(g, client), fromFeed: true };
  } catch (e) {
    console.warn('[ai-generate] grant feed unavailable, using capped client fields', String(e).slice(0, 120));
  }
  return { grant: client, fromFeed: false };
}

function cleanProfile(p: any) {
  const o = p && typeof p === 'object' ? p : {};
  const f = (k: string) => capStr(o[k], 200);
  return { company: f('company'), industry: f('industry'), employees: f('employees'), revenue: f('revenue'), location: f('location'), years_operating: f('years_operating'), legal_form: f('legal_form') };
}

// ---- Prompts ----------------------------------------------------------------
export function draftPrompt(grant: GrantFields, p: ReturnType<typeof cleanProfile>): string {
  return `Magyar pályázatíró szakértő vagy. Készíts egy ELSŐ VÁZLATOT a megadott pályázathoz, a magyar pályázati struktúrának megfelelően, pontosan 9 szekcióban, ebben a sorrendben: ${SECTION_TITLES.join('; ')}.

A PÁLYÁZAT:
- Cím: ${grant.title}
- Kategória: ${grant.cat}
- Keretösszeg: ${grant.amount}
- Határidő: ${grant.deadline}
- Forrás: ${grant.source}
- Felhívás kódja: ${grant.code}
- Kiíró: ${grant.issuer}
- Támogatás típusa: ${grant.type} ${grant.rate}
- Fontos jogosultsági feltétel: ${grant.note.slice(0, 400)}
- Hivatalos felhívás: ${grant.url}

A PÁLYÁZÓ CÉG:
- Cégnév: ${p.company || 'A Pályázó'}
- Iparág: ${p.industry}
- Létszám: ${p.employees}
- Éves árbevétel: ${p.revenue}
- Székhely: ${p.location || 'Magyarország'}
- Lezárt üzleti évek: ${p.years_operating}
- Cégforma: ${p.legal_form}

KÖVETELMÉNYEK:
- Magyar nyelven, hivatalos pályázati stílusban, a cégprofilra konkrétan szabva.
- Szekciónként 2-4 bekezdés sima szöveg (NE használj HTML-t, jelölést, csillagot vagy markdownt). Bekezdéseket üres sorral válassz el.
- Reális, de a hivatalos felhívással ellenőrizendő tartalmak. A költségvetésnél adj kerek becsült összegeket és arányokat.
- Ne találj ki konkrét számszerű referenciát (pl. korábbi pályázati azonosítót).
- Ha a támogatás hitel vagy kombinált termék, a költségvetésnél a visszafizetést és a hitelképességet is vedd figyelembe; ha a feltétel szűkít (pl. régió, cégméret, lezárt évek), a Pályázó bemutatásánál mutasd meg, hogy megfelel.`;
}

export function needsPrompt(query: string, categories: string[]): string {
  return `Egy magyar KKV ezt írta arról, mire kér támogatást: "${query}".
Elérhető pályázati kategóriák: ${categories.join(', ')}.
Add vissza a legjobban illeszkedő kategóriákat és magyar kulcsszavakat, amikkel a releváns pályázatok megtalálhatók.`;
}

// Turns a scraped webpage's text into a clean structured grant record (or
// rejects it as not-a-grant). Used by the daily scraper pipeline (cron).
function extractPrompt(p: any): string {
  const text = capStr(p?.pageText, 60000).replace(/\s+/g, ' ').slice(0, 12000);
  return `Az alábbi szöveg egy magyar weboldal tartalma (forrás: ${capStr(p?.source, 200)}, URL: ${capStr(p?.sourceUrl, 500)}).
Döntsd el, hogy ez EGY KONKRÉT, JELENLEG NYITOTT pályázati felhívás-e — NEM hír, NEM programkezdőlap, NEM általános tájékoztató, NEM lezárt felhívás.
Csak akkor isGrant=true, ha ez egy tényleges, beadható pályázati felhívás.

Mezők:
- isGrant: boolean
- title: a felhívás pontos címe, tisztítva ("Betöltés...", menü- és lábléc-szöveg nélkül)
- category: egy kategória magyarul (Digitális átalakulás | Energiahatékonyság | K+F | Képzés | Export | Mezőgazdaság | Turizmus | KKV fejlesztés | Egyéb)
- amount: az elérhető támogatás/keret szövegként, ha szerepel (pl. "5-50M Ft"); különben ""
- deadline: benyújtási határidő ISO formátumban (YYYY-MM-DD), ha szerepel; különben ""
- region: támogatott régió, ha van korlátozás (pl. "Konvergencia régió", "Budapest kivételével"); különben ""
- eligibility: 1-2 mondat a jogosultsági feltételekről, ha kiderül; különben ""
- summary: 1 mondatos magyar összefoglaló

Szöveg:
"""${text}"""

Válaszolj KIZÁRÓLAG a megadott JSON sémával, magyarázat nélkül.`;
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    isGrant: { type: 'boolean' }, title: { type: 'string' }, category: { type: 'string' }, amount: { type: 'string' },
    deadline: { type: 'string' }, region: { type: 'string' }, eligibility: { type: 'string' }, summary: { type: 'string' },
  },
  required: ['isGrant'],
};
const DRAFT_SCHEMA = {
  type: 'object',
  properties: { sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } } },
  required: ['sections'],
};
const NEEDS_SCHEMA = {
  type: 'object',
  properties: { categories: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } } },
  required: ['categories', 'keywords'],
};

// ---- Provider calls -------------------------------------------------------
export function geminiRequest(env: Env, prompt: string, schema: any): { url: string; init: RequestInit } {
  const model = env('GEMINI_MODEL') || 'gemini-flash-lite-latest';
  const body: any = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, responseMimeType: 'application/json' } };
  if (schema) body.generationConfig.responseSchema = schema;
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') ?? '' }, body: JSON.stringify(body) },
  };
}

async function callGemini(env: Env, prompt: string, schema: any, doFetch: typeof fetch): Promise<any> {
  if (!env('GEMINI_API_KEY')) throw new Error('GEMINI_API_KEY not set');
  const { url, init } = geminiRequest(env, prompt, schema);
  // Gemini's free tier returns 429/503 in spikes — retry with backoff.
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const DELAYS = [800, 1800, 3500, 6000];
  let lastErr = '';
  for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
    const r = await doFetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    if (r.ok) {
      const j = await r.json();
      return JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
    }
    lastErr = 'gemini ' + r.status + ' ' + (await r.text()).slice(0, 200);
    if (!RETRY_STATUS.has(r.status) || attempt === DELAYS.length) break;
    await new Promise((res) => setTimeout(res, DELAYS[attempt]));
  }
  throw new Error(lastErr);
}

async function callAnthropic(env: Env, prompt: string, doFetch: typeof fetch): Promise<any> {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await doFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env('ANTHROPIC_MODEL') || 'claude-haiku-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt + '\n\nVálaszolj KIZÁRÓLAG érvényes JSON-nal, magyarázat nélkül.' }],
    }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return JSON.parse((j?.content?.[0]?.text ?? '').replace(/^```json\s*|\s*```$/g, ''));
}

// Gemini first (free), Claude as automatic fallback; AI_PROVIDER=anthropic flips the order.
function makeGenerate(env: Env, doFetch: typeof fetch = fetch) {
  return async (prompt: string, schema: any): Promise<any> => {
    const order: Array<'gemini' | 'anthropic'> = (env('AI_PROVIDER') ?? 'gemini').toLowerCase() === 'anthropic' ? ['anthropic', 'gemini'] : ['gemini', 'anthropic'];
    let lastErr: unknown = null;
    for (const p of order) {
      if (p === 'anthropic' && !env('ANTHROPIC_API_KEY')) continue;
      if (p === 'gemini' && !env('GEMINI_API_KEY')) continue;
      try { return p === 'anthropic' ? await callAnthropic(env, prompt, doFetch) : await callGemini(env, prompt, schema, doFetch); } catch (e) {
        lastErr = e;
        console.error(`[ai-generate] ${p} failed; trying fallback`, String(e).slice(0, 160));
      }
    }
    throw lastErr ?? new Error('no_ai_provider_configured');
  };
}

// ---- Handler ----------------------------------------------------------------
export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'));
  const reply = (b: unknown, s = 200) => jsonResponse(b, s, cors);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const env = makeEnv(deps.env);
  let admin: any = null;
  const getAdmin = () => admin ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const generate = deps.generate ?? makeGenerate(env);

  let text: string;
  try { text = await req.text(); } catch { return reply({ error: 'bad_request' }, 400); }
  if (text.length > 200_000) return reply({ error: 'bad_request' }, 400);
  let body: any;
  try { body = JSON.parse(text); } catch { return reply({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object') return reply({ error: 'bad_request' }, 400);
  const task = body.task;
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};

  try {
    // 0. Cron-only "extract" task — gated by the shared cron secret.
    const cronHeader = req.headers.get('x-cron-secret') ?? '';
    const cronSecret = env('CRON_SECRET') ?? '';
    if (cronHeader && cronSecret && timingSafeEqual(cronHeader, cronSecret)) {
      if (task === 'extract') return reply((await generate(extractPrompt(payload), EXTRACT_SCHEMA)) ?? { isGrant: false });
      return reply({ error: 'unknown_cron_task' }, 400);
    }

    // 1. Signed-in users only.
    const jwt = bearer(req);
    if (!jwt) return reply({ error: 'unauthorized' }, 401);
    const getUserId = deps.getUserId ?? (async (t: string) => {
      const { data, error } = await getAdmin().auth.getUser(t);
      return error ? null : data?.user?.id ?? null;
    });
    let userId: string | null = null;
    try { userId = await getUserId(jwt); } catch { userId = null; }
    if (!userId) return reply({ error: 'unauthorized' }, 401);

    if (task !== 'draft' && task !== 'needs') return reply({ error: 'unknown_task' }, 400);

    // 2. Limits — fail CLOSED: any error counts as "over the limit".
    const bumpUser = deps.bumpUser ?? (async (u: string, limit: number) => {
      const { data, error } = await getAdmin().rpc('bump_ai_usage', { p_user: u, p_limit: limit });
      if (error) throw new Error(error.message);
      return data === true;
    });
    const bumpGlobal = deps.bumpGlobal ?? (async (limit: number) => {
      const { data, error } = await getAdmin().rpc('bump_ai_global', { p_limit: limit });
      if (error) throw new Error(error.message);
      return data === true;
    });
    const capEnv = parseInt(env('AI_GLOBAL_DAILY_CAP') ?? '', 10);
    const globalCap = capEnv > 0 ? capEnv : 500;
    try {
      if (!(await bumpUser(userId, task === 'draft' ? LIMIT_DRAFT : LIMIT_NEEDS))) return reply({ error: 'rate_limited' }, 429);
      if (!(await bumpGlobal(globalCap))) {
        console.warn('[ai-generate] global daily cap reached', globalCap);
        return reply({ error: 'rate_limited' }, 429);
      }
    } catch (e) {
      console.error('[ai-generate] usage limiter unavailable — refusing', String(e).slice(0, 160));
      return reply({ error: 'rate_limited' }, 429);
    }

    if (task === 'draft') {
      const feed = deps.grants ?? createGrantFeed({ url: env('GRANTS_URL') || undefined });
      const { grant } = await resolveGrant(payload.grant, feed);
      const out = await generate(draftPrompt(grant, cleanProfile(payload.profile)), DRAFT_SCHEMA);
      const sections = Array.isArray(out?.sections) ? out.sections.slice(0, 9).map((s: any) => ({ title: capStr(s?.title, 200), body: capStr(s?.body, 20000) })) : [];
      return reply({ sections });
    }

    // task === 'needs'
    const cats = capArr(payload.categories, MAX_ARR, 100);
    const out = await generate(needsPrompt(capStr(payload.query, 500), cats), NEEDS_SCHEMA);
    return reply({
      categories: capArr(out?.categories, 6, 100),
      keywords: capArr(out?.keywords, 12, 100),
    });
  } catch (e) {
    // Logged server-side only; the client falls back to its built-in logic.
    console.error('[ai-generate] failed', String(e).slice(0, 300));
    return reply({ error: 'ai_failed' }, 502);
  }
}

if (import.meta.main) Deno.serve((req) => handler(req));
