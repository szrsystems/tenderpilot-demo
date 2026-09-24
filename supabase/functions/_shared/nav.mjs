// =========================================================================
// NAV Online Számla API v3 — queryTaxpayer (company data by tax number)
// =========================================================================
// Official, free API of the Hungarian Tax Authority. Needs a NAV "technical
// user" (login, password, signature key) of any Hungarian taxpayer — create
// it at onlineszamla.nav.gov.hu → Felhasználók → Technikai felhasználó.
// Returns: name, short name, type (company / sole trader), seat address.
// It does NOT return TEÁOR, headcount or founding year — the user fills
// those in by hand.
// Pure functions; hashing is injected so the same code runs in Deno & Node.
// =========================================================================

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function normalizeTaxNumber(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (d.length === 8 || d.length === 11) return d.slice(0, 8);
  return null;
}

export function newRequestId(now = Date.now()) {
  return ('AIP' + now.toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 30).toUpperCase();
}

// sha512Hex / sha3_512Hex: (string) => Promise<string>|string (hex)
export async function buildQueryTaxpayerXml({ login, password, signKey, ownTaxNumber, software, targetTaxNumber, requestId, date }, { sha512Hex, sha3_512Hex }) {
  const iso = date.toISOString();                                    // 2026-09-25T10:00:00.000Z
  const mask = iso.slice(0, 19).replace(/[-:T]/g, '');                // 20260925100000
  const passwordHash = String(await sha512Hex(password)).toUpperCase();
  const signature = String(await sha3_512Hex(requestId + mask + signKey)).toUpperCase();
  const sw = software;
  return `<?xml version="1.0" encoding="UTF-8"?>
<QueryTaxpayerRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>${esc(requestId)}</common:requestId>
    <common:timestamp>${iso}</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>${esc(login)}</common:login>
    <common:passwordHash cryptoType="SHA-512">${passwordHash}</common:passwordHash>
    <common:taxNumber>${esc(ownTaxNumber)}</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">${signature}</common:requestSignature>
  </common:user>
  <software>
    <softwareId>${esc(sw.id)}</softwareId>
    <softwareName>${esc(sw.name)}</softwareName>
    <softwareOperation>ONLINE_SERVICE</softwareOperation>
    <softwareMainVersion>${esc(sw.version)}</softwareMainVersion>
    <softwareDevName>${esc(sw.devName)}</softwareDevName>
    <softwareDevContact>${esc(sw.devContact)}</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
    <softwareDevTaxNumber>${esc(sw.devTaxNumber)}</softwareDevTaxNumber>
  </software>
  <taxNumber>${esc(targetTaxNumber)}</taxNumber>
</QueryTaxpayerRequest>`;
}

// Namespace-prefix tolerant tag reader.
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`)); return m ? m[1].trim() : null; };
const decode = (s) => s == null ? null : String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseTaxpayerResponse(xml) {
  const funcCode = tag(xml, 'funcCode');
  if (funcCode && funcCode !== 'OK') return { ok: false, error: tag(xml, 'errorCode') || 'ERROR', message: decode(tag(xml, 'message')) };
  const validity = tag(xml, 'taxpayerValidity');
  if (validity !== 'true') return { ok: true, found: false };
  // Prefer the HQ (székhely) address.
  const items = [...String(xml).matchAll(/<(?:[\w-]+:)?taxpayerAddressItem\b[\s\S]*?<\/(?:[\w-]+:)?taxpayerAddressItem>/g)].map((m) => m[0]);
  const hq = items.find((x) => tag(x, 'taxpayerAddressType') === 'HQ') || items[0] || '';
  const addr = hq ? {
    postalCode: tag(hq, 'postalCode'), city: decode(tag(hq, 'city')),
    street: [decode(tag(hq, 'streetName')), decode(tag(hq, 'publicPlaceCategory')), tag(hq, 'number')].filter(Boolean).join(' ') || decode(tag(hq, 'additionalAddressDetail')),
  } : {};
  const name = decode(tag(xml, 'taxpayerName'));
  const incorporation = tag(xml, 'incorporation');
  return { ok: true, found: true, name, shortName: decode(tag(xml, 'taxpayerShortName')), incorporation, legalForm: legalFormOf(name, incorporation), ...addr };
}

export function legalFormOf(name, incorporation) {
  if (incorporation === 'SELF_EMPLOYED') return 'EV';
  const n = String(name || '');
  if (/\bKft\.?|korlátolt felelősségű/i.test(n)) return 'Kft';
  if (/\bBt\.?|betéti társaság/i.test(n)) return 'Bt';
  if (/\bNyrt\.?/i.test(n)) return 'Nyrt';
  if (/\bZrt\.?|zártkörűen/i.test(n)) return 'Zrt';
  if (/szövetkezet/i.test(n)) return 'Szövetkezet';
  return incorporation === 'ORGANIZATION' ? 'Egyéb' : '';
}
