// =========================================================================
// AIpályázó — company-lookup Edge Function (tax number → company data)
// =========================================================================
// POST { taxNumber: "12345678" | "12345678-1-41" }  (signed-in users only)
// → { found, name, legalForm, postalCode, city, street, county, region, sites[], cached }
// Source: NAV Online Számla API v3 queryTaxpayer (official, free).
// Asked once per company: the answer is cached in public.company_data for
// CACHE_DAYS, so repeat sign-ups / reloads never call NAV again. A successful
// lookup also stores the tax number on the caller's profile (server-side).
// company_verified_at means "NAV confirmed this tax number is valid" — it
// does NOT prove the user works for that company.
// TEÁOR, headcount, revenue, closed years are NOT available here: the
// onboarding asks the user for them.
//
// Deploy:  supabase functions deploy company-lookup --project-ref kacnvchwfwvpkkyhyupb
// Secrets (a NAV technical user — onlineszamla.nav.gov.hu → Felhasználók):
//   supabase secrets set NAV_LOGIN=... NAV_PASSWORD=... NAV_SIGN_KEY=... NAV_TAX_NUMBER=12345678 \
//     NAV_SOFTWARE_ID=HU12345678AIPALY01 --project-ref kacnvchwfwvpkkyhyupb
//   optional: NAV_API_URL (default: production queryTaxpayer endpoint)
// =========================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import jsSha3 from 'npm:js-sha3@0.9.3'; // CommonJS package → default import
const { sha3_512 } = jsSha3 as any;
import { buildQueryTaxpayerXml, parseTaxpayerResponse, normalizeTaxNumber, newRequestId, legalFormOf } from '../_shared/nav.mjs';
import '../_shared/hu-geo.js';
const AIPGeo = (globalThis as any).AIPGeo;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const NAV = {
  url: Deno.env.get('NAV_API_URL') ?? 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer',
  login: Deno.env.get('NAV_LOGIN') ?? '',
  password: Deno.env.get('NAV_PASSWORD') ?? '',
  signKey: Deno.env.get('NAV_SIGN_KEY') ?? '',
  taxNumber: Deno.env.get('NAV_TAX_NUMBER') ?? '',
  softwareId: Deno.env.get('NAV_SOFTWARE_ID') ?? '',
};
const DAILY_LIMIT = 150; // shared per-user daily AI/lookup counter (overall abuse ceiling)
const LOOKUP_LIMIT = 10;  // different tax numbers per user per 24 h (audit 2026-11-27)
const CACHE_DAYS = 30;

const ALLOWED_ORIGINS = ['https://aipalyazo.hu', 'https://www.aipalyazo.hu', 'https://palyazati-ertesito.hu', 'https://www.palyazati-ertesito.hu'];
function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (o: string | null, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(o), 'Content-Type': 'application/json' } });

async function sha512Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  if (req.method !== 'POST') return json(origin, { error: 'method_not_allowed' }, 405);
  if (!NAV.login || !NAV.password || !NAV.signKey || !NAV.taxNumber || !NAV.softwareId) return json(origin, { error: 'lookup_not_configured' }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(origin, { error: 'unauthorized' }, 401);
  const { data: allowed, error: rlErr } = await admin.rpc('bump_ai_usage', { p_user: user.id, p_limit: DAILY_LIMIT });
  if (rlErr || allowed !== true) return json(origin, { error: 'rate_limited' }, 429); // fail closed

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const target = normalizeTaxNumber(body?.taxNumber);
  if (!target) return json(origin, { error: 'invalid_tax_number' }, 400);

  // Per-user lookup limit + log: a free account must not become a people
  // search (sole traders are natural persons). Repeating one's own lookup is free.
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data: recent, error: logErr } = await admin.from('company_lookup_log').select('tax8').eq('user_id', user.id).gte('at', since).limit(200);
  if (logErr) return json(origin, { error: 'rate_limited' }, 429); // fail closed
  const seen = new Set((recent || []).map((r: any) => r.tax8));
  if (!seen.has(target) && seen.size >= LOOKUP_LIMIT) return json(origin, { error: 'rate_limited' }, 429);
  await admin.from('company_lookup_log').insert({ user_id: user.id, tax8: target }).then(() => {}, () => {});

  const shape = (res: any, cached: boolean) => ({
    found: true, name: res.shortName || res.name, fullName: res.name, legalForm: legalFormOf(res.name, res.incorporation, res.shortName), // recomputed: cached rows keep up with fixes
    // A sole trader's street address is usually a home address: never returned.
    postalCode: res.postalCode, city: res.city, street: res.incorporation === 'SELF_EMPLOYED' ? null : res.street,
    county: AIPGeo.countyOf(res.postalCode), region: AIPGeo.regionOf(res.postalCode),
    sites: (res.sites || []).map((x: any) => ({ ...x, region: AIPGeo.regionOf(x.postalCode) })),
    source: 'NAV', cached,
  });
  const markProfile = () => admin.from('profiles')
    .update({ tax_number: target, company_verified_at: new Date().toISOString() })
    .eq('id', user.id).then(() => {}, () => {}); // migration pending = harmless

  // 1) cache
  const { data: hit } = await admin.from('company_data').select('found, data, fetched_at').eq('tax8', target).maybeSingle()
    .then((r: any) => r, () => ({ data: null }));
  const age = hit ? Date.now() - Date.parse(hit.fetched_at) : Infinity;
  // "not found" is re-checked after a day (a brand-new company may appear soon)
  if (hit && age < (hit.found ? CACHE_DAYS : 1) * 864e5) {
    if (!hit.found) return json(origin, { found: false, cached: true });
    await markProfile();
    return json(origin, shape(hit.data, true));
  }

  // 2) NAV
  const xml = await buildQueryTaxpayerXml({
    login: NAV.login, password: NAV.password, signKey: NAV.signKey, ownTaxNumber: NAV.taxNumber,
    software: { id: NAV.softwareId, name: 'AIpalyazo', version: '1.0', devName: 'Szephelyi Oliver Soma EV', devContact: 'info@aipalyazo.hu', devTaxNumber: NAV.taxNumber },
    targetTaxNumber: target, requestId: newRequestId(), date: new Date(),
  }, { sha512Hex, sha3_512Hex: (s: string) => sha3_512(s) });

  let text = '';
  try {
    const r = await fetch(NAV.url, { method: 'POST', headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }, body: xml, signal: AbortSignal.timeout(15000) });
    text = await r.text();
  } catch {
    if (hit?.found) return json(origin, shape(hit.data, true)); // stale beats nothing
    return json(origin, { error: 'nav_unreachable' }, 502);
  }
  const res: any = parseTaxpayerResponse(text);
  if (!res.ok) {
    console.error('NAV error', res.error); // never echo NAV credentials or raw XML to the client
    if (hit?.found) return json(origin, shape(hit.data, true));
    return json(origin, { error: 'nav_error' }, 502);
  }
  const { ok: _ok, ...stored } = res;
  // Sole traders (EV) are natural persons: their data is personal data and is
  // NOT cached (it must disappear with the account — see adatvedelem.html).
  if (res.incorporation !== 'SELF_EMPLOYED') {
    await admin.from('company_data').upsert({ tax8: target, source: 'NAV', found: !!res.found, data: res.found ? stored : {}, fetched_at: new Date().toISOString() })
      .then(() => {}, () => {}); // cache write failure must not break the lookup
  }
  if (!res.found) return json(origin, { found: false });
  await markProfile();
  return json(origin, shape(res, false));
});
