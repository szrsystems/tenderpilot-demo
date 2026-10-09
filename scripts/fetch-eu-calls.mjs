// =========================================================================
// AIpályázó — EU calls from the official EU Funding & Tenders Portal
// =========================================================================
// Source: the portal's own public search API (SEDIA). One POST per page,
// multipart/form-data, every part must carry Content-Type: application/json
// (plain-string parts → HTTP 500; a raw JSON body is silently ignored).
//   type 1 = grant topics, type 8 = cascade / FSTP open calls (third-party
//   funding run by EU projects — the most SME-usable EU money).
//   status 31094501 = forthcoming, 31094502 = open.
// The status facet goes stale (old topics stay "open"), and range filters are
// ignored, so deadlines are always checked here, client-side.
//
// Only programmes a Hungarian company can realistically use are kept (see
// PROGRAMMES). Owner policy: every call an organisation can apply for stays —
// research (RIA), innovation (IA), EIC, large-company and consortium calls
// included. Dropped: calls for private persons (isForIndividuals), calls
// closed to everyone but named beneficiaries / public bodies / civil society
// (NON_BUSINESS_ID_RE), cancelled topics, and in Horizon Europe the
// coordination & support actions (CSA) that are not SME-targeted plus
// Programme Cofund actions (applicants are national funding bodies).
// Cascade (type 8) calls get their own id from their portal URL
// (competitive-calls-cs/<n>): the identifier is the PARENT topic, shared by
// several cascades and by hand-verified items.
// =========================================================================

const ENDPOINT = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
const TOPIC_URL = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/';
const UA = 'Mozilla/5.0 (compatible; AIpalyazoBot/1.0; +https://aipalyazo.hu)';

// frameworkProgramme id → display name (ids from the portal's own facets).
export const PROGRAMMES = {
  '43108390': 'Horizon Europe',
  '43152860': 'Digital Europe',
  '43252476': 'Single Market Programme',
  '43252405': 'LIFE',
  '44416173': 'Interregional Innovation Investments (I3)',
  '43089234': 'Innovation Fund',
  '43392145': 'EMFAF (halászat)',
  '43251882': 'Agrárpromóció (IMCAP)',
  '43251814': 'Creative Europe',
};

const CAT_RULES = [
  [/agri|food|farm|fish|aquacult|forest|rural/i, 'Mezőgazdaság'],
  [/cyber|digital|\bAI\b|artificial intelligence|data|software|cloud|semiconductor|quantum|robot/i, 'Digitális átalakulás'],
  [/energy|hydrogen|battery|renewable|solar|geotherm|heat/i, 'Energiahatékonyság'],
  [/climate|circular|biodiversity|environment|water|pollution|waste|nature/i, 'Környezetvédelem'],
  [/touris|cultur|creative|media|film/i, 'Turizmus'],
  [/skill|education|training|erasmus/i, 'Oktatás'],
  [/export|internationali|market access/i, 'Export'],
];

const one = (m, k) => { const v = m?.[k]; return Array.isArray(v) ? (v[0] == null ? null : String(v[0])) : (v == null ? null : String(v)); };
const many = (m, k) => { const v = m?.[k]; return Array.isArray(v) ? v.filter((x) => x != null).map(String) : []; };

// "2026-10-28T00:00:00.000+0000" | "2026-10-28" | epoch ms → "YYYY-MM-DD"
export function euDate(s) {
  if (s == null || s === '') return null;
  if (/^\d{12,}$/.test(String(s))) return new Date(Number(s)).toISOString().slice(0, 10);
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function fmtEur(n) {
  if (!n) return '';
  return n >= 1e6 ? `€${+(n / 1e6).toFixed(2)}M` : `€${Math.round(n / 1000)}k`;
}

function amountFrom(meta) {
  try {
    const raw = one(meta, 'budgetOverview');
    if (!raw) return '';
    const map = JSON.parse(raw).budgetTopicActionMap || {};
    let min = Infinity, max = 0;
    for (const arr of Object.values(map)) for (const e of arr || []) {
      if (e.minContribution) min = Math.min(min, Number(e.minContribution));
      if (e.maxContribution) max = Math.max(max, Number(e.maxContribution));
    }
    if (max && min < Infinity && min < max) return `${fmtEur(min)}–${fmtEur(max)}`;
    if (max) return `max ${fmtEur(max)}`;
  } catch { /* budget not parseable → no amount */ }
  return '';
}

// Calls whose applicant is a private person, not an organisation: fellowships,
// scholarships, individual researcher grants, natural-person prizes. Every
// call an organisation can apply for stays in — consortium and large-company
// calls included.
export const INDIVIDUAL_RE = /\b(fellowships?|scholarships?|postdoctoral|doctoral (networks?|candidates?)|phd (students?|candidates?|positions?)|individual (researchers?|applicants?|artists?|grants?)|for individuals|natural persons?|ösztöndíj\w*|magánszemély\w*|lakossági)\b/i;
export const INDIVIDUAL_ID_RE = /^(HORIZON-MSCA|HORIZON-ERC|ERC-|MSCA-)|-PF-|-ERC-/i;
export function isForIndividuals(title, identifier = '') {
  return INDIVIDUAL_ID_RE.test(identifier || '') || INDIVIDUAL_RE.test(title || '');
}

// Calls a business cannot apply to, by identifier: cancelled topics; -IBA
// (identified beneficiary actions, e.g. EIT KIC business plans); -SGA
// (specific grant agreement for a named FPA consortium); EEN-01 (Enterprise
// Europe Network host organisations); -NCC- (national coordination centres);
// CERV- (citizens, equality, rights & values — civil society). Horizon
// INFRA, WIDERA and Digital Europe education calls stay (companies can be
// partners).
export const NON_BUSINESS_ID_RE = /CANCELLED|-IBA(?:-|$)|-SGA(?:-|$)|-EEN-01|-NCC(?:-|$)|^CERV-/i;
export const isNonBusinessId = (identifier) => NON_BUSINESS_ID_RE.test(String(identifier || ''));

// Horizon Europe action types. Kept: RIA, IA, EIC, PCP/PPI, lump sum — any
// call an organisation can join. Dropped only: coordination & support actions
// (networking/support services, not funding for a company's own project)
// unless SME-targeted, and Programme Cofund actions (national funders apply).
const SME_TARGET_RE = /\bSMEs?\b|SME's|start-?ups?|scale-?ups?|small and medium|\bKKV/i;
export function horizonActionDropped(actions, title = '', identifier = '') {
  const a = `${actions || ''} ${title || ''}`;
  if (/Programme Cofund|\bCOFUND\b/i.test(a)) return 'cofund';
  if (/Coordination and Support|\bCSA\b/i.test(a) && !SME_TARGET_RE.test(`${title} ${identifier}`)) return 'csa';
  return null;
}

const CS_RE = /\/competitive-calls-cs\/(\d+)/i;
// Cascade id from its own portal URL; null when the URL has no cs number.
export const cascadeId = (url) => { const m = String(url || '').match(CS_RE); return m ? 'eu-cs-' + m[1] : null; };

// Re-apply today's rules to an already-mapped EU item (yesterday's feed when
// the EU API is down, or the offline rebuild): drop non-business/cancelled
// identifiers and give old-style cascade items their own id.
export function normalizeEuItem(g) {
  if (!g) return null;
  const ident = g.parentTopic || g.code || '';
  if (isNonBusinessId(ident) || isNonBusinessId(g.id)) return null;
  if (isForIndividuals(g.title, ident)) return null;
  const cs = cascadeId(g.url);
  if (cs && g.id !== cs) return { ...g, id: cs, code: null, parentTopic: g.parentTopic || g.code || null };
  return g;
}

// Map one search hit → portal grant, or null when it should not be shown.
export function mapEuHit(hit, today) {
  const m = hit.metadata || {};
  const type = one(m, 'type');
  const fp = one(m, 'frameworkProgramme');
  const identifier = one(m, 'identifier') || hit.reference || '';
  // Titles come from a third-party API and end up in HTML: strip markup.
  const title = (one(m, 'title') || hit.title || hit.summary || '').replace(/[<>"]/g, '').trim();
  if (!identifier || !title) return null;
  if (isForIndividuals(title, identifier)) return null;
  if (isNonBusinessId(identifier)) return null;

  const isCascade = type === '8';
  if (!isCascade && !PROGRAMMES[fp]) return null;
  const actions = many(m, 'typesOfAction').join(' ');
  const isEic = /EIC/i.test(identifier);
  if (fp === '43108390' && !isCascade && !isEic && horizonActionDropped(actions, title, identifier)) return null;

  // First deadline on/after today (multi-cut-off topics list several).
  const deadlines = many(m, 'deadlineDate').map(euDate).filter(Boolean).sort();
  const deadline = deadlines.find((d) => d >= today) || null;
  if (!deadline) return null;
  const start = euDate(one(m, 'startDate'));
  const status = one(m, 'status');
  const text = `${title} ${one(m, 'callTitle') || ''} ${many(m, 'keywords').join(' ')}`;
  const cat = (CAT_RULES.find(([re]) => re.test(text)) || [null, isEic ? 'Kutatás-fejlesztés' : 'KKV fejlesztés'])[1];
  const single = isCascade || /ACCELERATOR|PATHFINDER|WOMENTECH/i.test(identifier);
  const url = one(m, 'url') || hit.url || (isCascade ? '' : TOPIC_URL + identifier.toLowerCase());
  if (!/^https:\/\//.test(url)) return null;
  // A cascade's identifier is its PARENT topic: use the cascade's own URL.
  const cs = isCascade ? cascadeId(url) : null;

  return {
    id: cs || 'eu-' + identifier.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    code: isCascade ? null : identifier,
    ...(isCascade ? { parentTopic: identifier } : {}),
    // cascade calls often reuse the parent programme's name: mark them so they don't look like a duplicate of it
    title: isCascade && !/kaszkád|cascade|open call/i.test(title) ? `${title} — kaszkád (FSTP) nyílt felhívás` : title,
    issuer: isCascade ? 'EU kaszkád (FSTP) felhívás' : `Európai Bizottság — ${PROGRAMMES[fp] || 'EU'}`,
    cat,
    type: 'grant',
    amount: amountFrom(m),
    deadline,
    rolling: false,
    windowOpen: status === '31094501' && start && start > today ? start : null,
    regions: [],
    sizeClasses: [],
    note: single
      ? 'Angol nyelvű EU felhívás; egyedül is pályázható.'
      : 'Angol nyelvű EU felhívás; jellemzően nemzetközi konzorcium szükséges.',
    url,
    source: 'ec.europa.eu',
    scope: 'eu',
    singleApplicant: single,
    auto: true, // straight from the official EU API, not hand-checked
  };
}

function form(parts) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) fd.append(k, new Blob([JSON.stringify(v)], { type: 'application/json' }), 'blob');
  return fd;
}

// Fetch all open + forthcoming type-1 and type-8 calls, mapped and filtered.
// Throws on HTTP/API errors so the caller can keep yesterday's EU items.
export async function fetchEuCalls({ today, fetchImpl = fetch, pageSize = 100, maxPages = 30 } = {}) {
  const out = new Map();
  let total = Infinity;
  for (let page = 1; page <= maxPages && (page - 1) * pageSize < total; page++) {
    const url = `${ENDPOINT}?apiKey=SEDIA&text=***&pageSize=${pageSize}&pageNumber=${page}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': UA },
      body: form({
        query: { bool: { must: [{ terms: { type: ['1', '8'] } }, { terms: { status: ['31094501', '31094502'] } }] } },
        languages: ['en'],
        sort: { field: 'deadlineDate', order: 'ASC' },
      }),
    });
    if (!res.ok) throw new Error(`EU API ${res.status}`);
    const data = await res.json();
    if (data.type === 'throwable') throw new Error(`EU API: ${data.message || 'error'}`);
    total = Number(data.totalResults || 0);
    for (const hit of data.results || []) {
      const g = mapEuHit(hit, today);
      if (g && !out.has(g.id)) out.set(g.id, g);
    }
  }
  return [...out.values()];
}
