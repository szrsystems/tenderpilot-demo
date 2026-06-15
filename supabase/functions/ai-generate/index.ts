// =========================================================================
// AIpályázó — AI generation proxy (Supabase Edge Function)
// =========================================================================
// One endpoint, two tasks:
//   task:"draft" → full Hungarian grant-draft (9 sections). Pro-only.
//   task:"needs" → interprets a free-text need into categories + keywords
//                  (the client ranks the local grant list with them — cheap,
//                  no need to ship the whole DB to the model). Any signed-in user.
//
// Provider-agnostic: defaults to Gemini, swap to Claude with one secret
// (AI_PROVIDER=anthropic). The API key NEVER reaches the browser — it lives
// here as a Supabase secret. The frontend calls this via
// supabase.functions.invoke('ai-generate'), which carries the user's JWT.
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

// ---- Provider calls -----------------------------------------------------
async function callGemini(prompt: string, schema: any): Promise<any> {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
  };
  if (schema) body.generationConfig.responseSchema = schema;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return JSON.parse(text);
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

function generate(prompt: string, schema: any): Promise<any> {
  return PROVIDER === 'anthropic' ? callAnthropic(prompt) : callGemini(prompt, schema);
}

// ---- Handler ------------------------------------------------------------
Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    // 1. Require an authenticated Supabase user (blocks anonymous abuse of the paid API).
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const { task, payload } = await req.json();

    if (task === 'draft') {
      // 2. Drafts are Pro-only — verify server-side (never trust the client).
      const { data: prof } = await admin.from('user_with_tier')
        .select('tier, subscription_status').eq('id', user.id).single();
      const isPro = prof?.tier === 'pro' && ['trialing', 'active'].includes(prof?.subscription_status);
      if (!isPro) return json({ error: 'pro_required' }, 403);

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

    return json({ error: 'unknown_task' }, 400);
  } catch (e) {
    // The client falls back to its built-in logic on any error.
    return json({ error: 'ai_failed', detail: String(e).slice(0, 200) }, 502);
  }
});
