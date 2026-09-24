// =========================================================================
// AIpályázó — company-lookup Edge Function (tax number → company data)
// =========================================================================
// POST { taxNumber: "12345678" | "12345678-1-41" }  (signed-in users only)
// → { found, name, legalForm, postalCode, city, street, county, region }
// Source: NAV Online Számla API v3 queryTaxpayer (official, free).
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
import { buildQueryTaxpayerXml, parseTaxpayerResponse, normalizeTaxNumber, newRequestId } from '../_shared/nav.mjs';
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
const DAILY_LIMIT = 150; // shared per-user daily AI/lookup counter

const ALLOWED_ORIGINS = ['https://aipalyazo.hu', 'https://www.aipalyazo.hu', 'https://szrsystems.github.io', 'https://tenderpilot.onrender.com'];
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
    return json(origin, { error: 'nav_unreachable' }, 502);
  }
  const res: any = parseTaxpayerResponse(text);
  if (!res.ok) {
    console.error('NAV error', res.error); // never echo NAV credentials or raw XML to the client
    return json(origin, { error: 'nav_error' }, 502);
  }
  if (!res.found) return json(origin, { found: false });
  return json(origin, {
    found: true, name: res.shortName || res.name, fullName: res.name, legalForm: res.legalForm,
    postalCode: res.postalCode, city: res.city, street: res.street,
    county: AIPGeo.countyOf(res.postalCode), region: AIPGeo.regionOf(res.postalCode), source: 'NAV',
  });
});
