// =========================================================================
// AIpályázó — AI generation proxy (Supabase Edge Function)
// =========================================================================
// One endpoint, two tasks:
//   task:"draft" → full Hungarian grant-draft (9 sections). Pro-only.
//   task:"needs" → interprets a free-text need into categories + keywords
//                  (the client ranks the local grant list with them — cheap,
//                  no need to ship the whole DB to the model). Any signed-in user.
//
// Dual-provider: Gemini is primary (free); Claude is the automatic fallback
// when Gemini is overloaded/fails, and the FIRST choice for hard tasks. Just
// set ANTHROPIC_API_KEY to activate it — no key = Gemini-only (unchanged).
// API keys NEVER reach the browser — they live here as Supabase secrets. The
// frontend calls this via supabase.functions.invoke('ai-generate') (carries JWT).
//
// Deploy:
//   supabase functions deploy ai-generate
// Secrets (set once):
//   supabase secrets set GEMINI_API_KEY=...           # required (Gemini)
//   supabase secrets set AI_PROVIDER=gemini           # optional, default gemini
//   supabase secrets set GEMINI_MODEL=gemini-flash-lite-latest   # optional
//   # to switch to Claude later:
//   #   supabase secrets set AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-haiku-4-5
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''; // for cron-only tasks (extract)

const PROVIDER = (Deno.env.get('AI_PROVIDER') ?? 'gemini').toLowerCase();
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-flash-lite-latest';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';

// Origins allowed to call this function (CSP already restricts the browser side).
const ALLOWED_ORIGINS = [
  'https://szrsystems.github.io',
  'https://aipalyazo.hu',
  'https://www.aipalyazo.hu',
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const SECTION_TITLES = [
  'Projekt összefoglaló', 'Pályázó bemutatása', 'Projekt célja és indokoltsága',
  'Tervezett tevékenységek', 'Indikátorok és vállalások', 'Költségvetés-tervezet',
  'Megvalósítási ütemterv', 'Fenntarthatósági terv', 'Kockázatok és kezelésük',
];

function draftPrompt(grant: any, profile: any): string {
  const p = profile || {};
  return `Magyar pályázatíró szakértő vagy. Készíts egy ELSŐ VÁZLATOT a megadott pályázathoz, a magyar pályázati struktúrának megfelelően, pontosan 9 szekcióban, ebben a sorrendben: ${SECTION_TITLES.join('; ')}.

A PÁLYÁZAT:
- Cím: ${grant?.title ?? ''}
- Kategória: ${grant?.cat ?? ''}
- Keretösszeg: ${grant?.amount ?? ''}
- Határidő: ${grant?.deadline ?? ''}
- Forrás: ${grant?.source ?? ''}

A PÁLYÁZÓ CÉG:
- Cégnév: ${p.company ?? 'A Pályázó'}
- Iparág: ${p.industry ?? ''}
- Létszám: ${p.employees ?? ''}
- Éves árbevétel: ${p.revenue ?? ''}
- Székhely: ${p.location ?? 'Magyarország'}
- Lezárt üzleti évek: ${p.years_operating ?? ''}
- Cégforma: ${p.legal_form ?? ''}

KÖVETELMÉNYEK:
- Magyar nyelven, hivatalos pályázati stílusban, a cégprofilra konkrétan szabva.
- Szekciónként 2-4 bekezdés sima szöveg (NE használj HTML-t, jelölést, csillagot vagy markdownt). Bekezdéseket üres sorral válassz el.
- Reális, de a hivatalos felhívással ellenőrizendő tartalmak. A költségvetésnél adj kerek becsült összegeket és arányokat.
- Ne találj ki konkrét számszerű referenciát (pl. korábbi pályázati azonosítót).`;
}

function needsPrompt(query: string, categories: string[]): string {
  return `Egy magyar KKV ezt írta arról, mire kér támogatást: "${query}".
Elérhető pályázati kategóriák: ${categories.join(', ')}.
Add vissza a legjobban illeszkedő kategóriákat és magyar kulcsszavakat, amikkel a releváns pályázatok megtalálhatók.`;
}

// Sales-call review: a transcript goes in, structured coaching comes out.
// `me` is the seller's label in the transcript (e.g. a name or "Sales");
// everything else is treated as the prospect side. Transcripts are Hungarian,
// so the feedback is written in Hungarian — including the verbatim quotes,
// which stay in the transcript's original wording.
function callReviewPrompt(transcript: string, me: string, context: string): string {
  return `You are an elite B2B sales coach reviewing a recorded Hungarian sales call. Be blunt, specific and useful — name the exact moments where the deal slipped, not generic advice.

The seller (the person being coached) is labelled "${me || 'unknown — infer the seller from context'}" in the transcript. Everyone else is the prospect/buyer side.
${context ? `\nDEAL CONTEXT the seller gave you: ${context}\n` : ''}
Rules:
- The transcript is in Hungarian. Write ALL of your feedback in Hungarian (magyarul), in natural, professional Hungarian sales language.
- Every criticism must point to a concrete moment and, where possible, quote the actual words VERBATIM (short, in the original Hungarian) so the seller recognises it.
- "better_line" / "say" fields must be a ready-to-use Hungarian sentence the seller could have said out loud — not a description of one.
- Score honestly. A call that lost the deal should score low. Do not inflate.
- If the transcript is too short or unclear to judge, say so in the summary and score conservatively.

TRANSCRIPT (Hungarian):
${transcript}`;
}

const CALLREVIEW_SCHEMA = {
  type: 'object',
  properties: {
    overall_score: { type: 'integer' }, // 0-100
    headline: { type: 'string' },       // one-line verdict
    summary: { type: 'string' },        // 2-4 sentences: what happened on the call
    outcome: { type: 'string' },        // likely result: won / advancing / stalled / lost — with why
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string' }, // e.g. Discovery, Rapport, Objection handling, Closing, Talk ratio
          score: { type: 'integer' },    // 0-100
          note: { type: 'string' },
        },
        required: ['dimension', 'score', 'note'],
      },
    },
    went_well: {
      type: 'array',
      items: {
        type: 'object',
        properties: { point: { type: 'string' }, quote: { type: 'string' } },
        required: ['point'],
      },
    },
    mistakes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string' },     // where in the call
          what_happened: { type: 'string' },
          why_it_hurt: { type: 'string' },
          quote: { type: 'string' },      // the seller's actual words, if any
          severity: { type: 'string' },   // low / medium / high
        },
        required: ['moment', 'what_happened', 'why_it_hurt'],
      },
    },
    missed_opportunities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string' },
          what_you_couldve_done: { type: 'string' },
          better_line: { type: 'string' },
        },
        required: ['what_you_couldve_done'],
      },
    },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          objection: { type: 'string' },     // what the prospect pushed back with
          how_handled: { type: 'string' },   // what the seller actually did
          better_response: { type: 'string' },
        },
        required: ['objection', 'better_response'],
      },
    },
    rewrites: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instead_of: { type: 'string' }, // weak line the seller said
          say: { type: 'string' },        // stronger replacement
        },
        required: ['instead_of', 'say'],
      },
    },
    next_steps: { type: 'array', items: { type: 'string' } }, // concrete follow-up actions
  },
  required: ['overall_score', 'headline', 'summary', 'mistakes', 'next_steps'],
};

// ---- Provider calls -----------------------------------------------------
async function callGemini(prompt: string, schema: any): Promise<any> {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
  };
  if (schema) body.generationConfig.responseSchema = schema;
  // Gemini's free tier returns 429/503 ("high demand") in spikes — retry with
  // exponential backoff so transient overloads self-heal instead of failing.
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const DELAYS = [800, 1800, 3500, 6000];
  let lastErr = '';
  for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return JSON.parse(text);
    }
    lastErr = 'gemini ' + r.status + ' ' + (await r.text()).slice(0, 200);
    if (!RETRY_STATUS.has(r.status) || attempt === DELAYS.length) break;
    await new Promise((res) => setTimeout(res, DELAYS[attempt]));
  }
  throw new Error(lastErr);
}

async function callAnthropic(prompt: string): Promise<any> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, max_tokens: 4096,
      messages: [{ role: 'user', content: prompt + '\n\nVálaszolj KIZÁRÓLAG érvényes JSON-nal, magyarázat nélkül.' }],
    }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const text = (j?.content?.[0]?.text ?? '').replace(/^```json\s*|\s*```$/g, '');
  return JSON.parse(text);
}

// Dual-provider routing. Gemini is the default (free) and Claude is the
// automatic fallback when Gemini fails after its retries (429/503 spikes,
// timeouts). For "hard" tasks (e.g. eligibility verdicts) Claude goes FIRST,
// with Gemini as the fallback. Without ANTHROPIC_API_KEY set, this is
// Gemini-only — identical to the previous behaviour, no regression.
// AI_PROVIDER=anthropic forces Claude-first for everything.
async function generate(prompt: string, schema: any, opts: { hard?: boolean } = {}): Promise<any> {
  const claudeFirst = PROVIDER === 'anthropic' || (!!opts.hard && !!ANTHROPIC_KEY);
  const order: Array<'gemini' | 'anthropic'> = claudeFirst ? ['anthropic', 'gemini'] : ['gemini', 'anthropic'];
  let lastErr: unknown = null;
  for (const provider of order) {
    if (provider === 'anthropic' && !ANTHROPIC_KEY) continue;
    if (provider === 'gemini' && !GEMINI_KEY) continue;
    try {
      return provider === 'anthropic' ? await callAnthropic(prompt) : await callGemini(prompt, schema);
    } catch (e) {
      lastErr = e;
      console.error(`[ai-generate] ${provider} failed; trying fallback`, String(e).slice(0, 160));
    }
  }
  throw lastErr ?? new Error('no_ai_provider_configured');
}

// Per-user/day rate limit via the bump_ai_usage RPC (service role only).
// Returns true if the caller is still under the limit. Fails OPEN on infra
// error so a transient DB hiccup doesn't break paying users — abuse is still
// bounded the moment the RPC is reachable again.
async function allowUsage(admin: any, userId: string, limit: number): Promise<boolean> {
  const { data, error } = await admin.rpc('bump_ai_usage', { p_user: userId, p_limit: limit });
  if (error) { console.error('[ai-generate] usage rpc error', error); return true; }
  return data === true;
}
const LIMIT_DRAFT = 25;   // Pro drafts per user per day
const LIMIT_NEEDS = 100;  // needs-finder calls per user per day
const LIMIT_CALLREVIEW = 40; // sales-call reviews per user per day

// Turns a scraped webpage's text into a clean structured grant record (or
// rejects it as not-a-grant). Used by the daily scraper pipeline (cron).
function extractPrompt(p: any): string {
  const text = String(p?.pageText ?? '').replace(/\s+/g, ' ').slice(0, 12000);
  return `Az alábbi szöveg egy magyar weboldal tartalma (forrás: ${p?.source ?? ''}, URL: ${p?.sourceUrl ?? ''}).
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
    isGrant: { type: 'boolean' },
    title: { type: 'string' },
    category: { type: 'string' },
    amount: { type: 'string' },
    deadline: { type: 'string' },
    region: { type: 'string' },
    eligibility: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['isGrant'],
};

// ---- Handler ------------------------------------------------------------
Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    // 0. Cron-only "extract" task — no user, gated by the shared cron secret.
    //    Used by the daily scraper pipeline to structure grant pages with the LLM.
    const cronSecret = req.headers.get('x-cron-secret');
    if (cronSecret && CRON_SECRET && cronSecret === CRON_SECRET) {
      const { task, payload } = await req.json();
      if (task === 'extract') {
        const out = await generate(extractPrompt(payload), EXTRACT_SCHEMA);
        return json(out ?? { isGrant: false });
      }
      return json({ error: 'unknown_cron_task' }, 400);
    }

    // 1. Require an authenticated Supabase user (blocks anonymous abuse of the paid API).
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const { task, payload } = await req.json();

    if (task === 'draft') {
      // Drafts are free for every signed-in user (the JWT was verified above).
      // Still rate-limited per user/day to cap LLM cost and abuse.
      if (!(await allowUsage(admin, user.id, LIMIT_DRAFT))) return json({ error: 'rate_limited' }, 429);

      const schema = {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
          },
        },
        required: ['sections'],
      };
      const out = await generate(draftPrompt(payload?.grant, payload?.profile), schema);
      return json({ sections: Array.isArray(out?.sections) ? out.sections.slice(0, 9) : [] });
    }

    if (task === 'needs') {
      if (!(await allowUsage(admin, user.id, LIMIT_NEEDS))) return json({ error: 'rate_limited' }, 429);
      const cats: string[] = Array.isArray(payload?.categories) ? payload.categories : [];
      const schema = {
        type: 'object',
        properties: {
          categories: { type: 'array', items: { type: 'string' } },
          keywords: { type: 'array', items: { type: 'string' } },
        },
        required: ['categories', 'keywords'],
      };
      const out = await generate(needsPrompt(String(payload?.query ?? '').slice(0, 500), cats), schema);
      return json({
        categories: Array.isArray(out?.categories) ? out.categories.slice(0, 6) : [],
        keywords: Array.isArray(out?.keywords) ? out.keywords.slice(0, 12) : [],
      });
    }

    if (task === 'callreview') {
      if (!(await allowUsage(admin, user.id, LIMIT_CALLREVIEW))) return json({ error: 'rate_limited' }, 429);
      const transcript = String(payload?.transcript ?? '').slice(0, 60000); // ~15k tokens, plenty for one call
      if (transcript.trim().length < 40) return json({ error: 'transcript_too_short' }, 400);
      const me = String(payload?.me ?? '').slice(0, 80);
      const context = String(payload?.context ?? '').slice(0, 1000);
      const out = await generate(callReviewPrompt(transcript, me, context), CALLREVIEW_SCHEMA);
      return json(out);
    }

    return json({ error: 'unknown_task' }, 400);
  } catch (e) {
    // The client falls back to its built-in logic on any error.
    return json({ error: 'ai_failed', detail: String(e).slice(0, 200) }, 502);
  }
});
