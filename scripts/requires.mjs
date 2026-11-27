// =========================================================================
// Pályázati Értesítő — eligibility tags ("requires") vocabulary
// =========================================================================
// Every listed call may carry
//   requires:         { <key>: true | number }   — hard eligibility conditions
//   requiresEvidence: { <key>: "quote/paraphrase from the official text" }
// Only the keys below are allowed. A key is set only when the condition is a
// real requirement of the call (not a mere preference), and every key must
// carry its evidence (≤160 chars). When unsure, the key is left out.
// =========================================================================

export const REQUIRES_VOCAB = {
  consortium: 'bool',         // needs partners / multi-country consortium
  women_led: 'bool',
  youth_founder: 'bool',      // founder under ~30/35
  jobseeker: 'bool',          // for unemployed people starting a business
  startup_max_years: 'number',// company at most N years old
  research_led: 'bool',       // a research organisation / university must lead / apply
  rnd_project: 'bool',        // an R&D / innovation project is the object of support
  deeptech: 'bool',
  farmer: 'bool',             // primary agricultural producer / őstermelő / agri enterprise
  fisheries: 'bool',
  forestry: 'bool',           // forest owner / manager
  tourism_ntak: 'bool',       // NTAK-registered accommodation / tourism service
  restaurant: 'bool',
  social_enterprise: 'bool',
  cluster_manager: 'bool',    // only accredited cluster management organisations
  employer: 'bool',           // must already have employees
  hires_disadvantaged: 'bool',// wage subsidy for hiring a target group
  min_revenue_huf: 'number',
  bank_loan: 'bool',          // financial product applied for via a bank / intermediary
  no_kata: 'bool',            // KATA (kisadózó) taxpayers are excluded
  de_minimis: 'bool',         // the aid is granted as de minimis aid
  favoured_district: 'bool',  // only in a kedvezményezett járás / favoured settlement
  // --- DFT eligibility model (2026-11-25) ---
  no_sole_trader: 'bool',     // egyéni vállalkozók nem pályázhatnak
  min_headcount: 'number',    // minimum average statistical headcount (fő)
  min_closed_years: 'number', // at least N closed full business years
  teaor_codes: 'codes',       // only these TEÁOR activities (main or project activity)
  excluded_teaor: 'codes',    // these TEÁOR activities are excluded
  szvz: 'bool',               // only in a szabad vállalkozási zóna
  max_settlement_pop: 'number', // only settlements below N inhabitants
  premises_min_days: 'number',// project site registered at least N days before submission
  export: 'bool',             // for exporting companies
  positive_equity: 'bool',    // equity must not be negative
  equity_vs_capital: 'bool',  // equity must reach the registered (share) capital
  aid_max_equity: 'bool',     // the aid may not exceed the applicant's equity
  project_max_revenue_pct: 'number', // project cost ≤ N% of last year's net revenue
  loan_max_ebit_x: 'number',  // loan ≤ N × operating profit (EBIT)
  not_started: 'bool',        // the project must not start before the application (incentive effect)
  new_assets_only: 'bool',    // only new (not used) assets are eligible
};
const MAX_CODES = 80;
// "47.11", "4711", "56" → "4711", "56"; anything else is dropped.
export function cleanCodes(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((c) => String(c).replace(/\D/g, '')).filter((c) => c.length >= 2 && c.length <= 6);
  return [...new Set(list)].slice(0, MAX_CODES);
}
export const REQUIRES_KEYS = Object.keys(REQUIRES_VOCAB);
export const MAX_EVIDENCE = 160;

// Problems with one item's tags ([] = fine).
export function checkRequires(item) {
  const problems = [];
  const r = item.requires, ev = item.requiresEvidence;
  if (r === undefined) { if (ev !== undefined) problems.push('requiresEvidence without requires'); return problems; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['requires is not an object'];
  if (!Object.keys(r).length) problems.push('empty requires object (omit it instead)');
  for (const [k, v] of Object.entries(r)) {
    const t = REQUIRES_VOCAB[k];
    if (!t) { problems.push(`unknown key ${k}`); continue; }
    if (t === 'bool' && v !== true) problems.push(`${k} must be true`);
    if (t === 'number' && !(typeof v === 'number' && v > 0)) problems.push(`${k} must be a positive number`);
    if (t === 'codes' && !(Array.isArray(v) && v.length && v.length <= MAX_CODES && v.every((c) => /^\d{2,6}$/.test(c)))) problems.push(`${k} must be a list of 2–6 digit codes`);
    const e = ev && ev[k];
    if (typeof e !== 'string' || e.trim().length < 4) problems.push(`${k} has no evidence`);
    else if (e.length > MAX_EVIDENCE) problems.push(`${k} evidence longer than ${MAX_EVIDENCE}`);
  }
  for (const k of Object.keys(ev || {})) if (!(k in r)) problems.push(`evidence for unset key ${k}`);
  return problems;
}

// Clean an untrusted tag set (e.g. from the LLM): keep only vocabulary keys
// with a valid value and evidence that passes `isGrounded(evidence)`.
export function cleanRequires(raw, isGrounded = () => true) {
  const requires = {}, requiresEvidence = {};
  if (!raw || typeof raw !== 'object') return null;
  for (const [k, x] of Object.entries(raw)) {
    const t = REQUIRES_VOCAB[k];
    if (!t || !x || typeof x !== 'object') continue;
    const v = t === 'number' ? Number(x.value) : t === 'codes' ? cleanCodes(x.value) : x.value === true;
    if (t === 'number' ? !(v > 0) : t === 'codes' ? !v.length : !v) continue;
    const e = typeof x.evidence === 'string' ? x.evidence.trim() : '';
    if (!e || e.length > MAX_EVIDENCE * 2 || !isGrounded(e)) continue;
    requires[k] = v;
    requiresEvidence[k] = e.length > MAX_EVIDENCE ? e.slice(0, MAX_EVIDENCE - 1) + '…' : e;
  }
  return Object.keys(requires).length ? { requires, requiresEvidence } : null;
}

// The clause of a note that states the partner requirement (≤160 chars).
export function consortiumEvidence(note) {
  const text = String(note || '').trim();
  if (!text) return 'Konzorciumban lehet pályázni.';
  const clauses = text.split(/;\s*|(?<=\.)\s(?=[A-ZÁÉÍÓÖŐÚÜŰ])/).map((c) => c.trim()).filter(Boolean);
  const hit = clauses.find((c) => /konzorc|partner|consortium|min\.\s*\d+ (?:független )?(?:szervezet|ország)|legalább (?:két|2|3) /i.test(c)) || text;
  return hit.length > MAX_EVIDENCE ? hit.slice(0, MAX_EVIDENCE - 1) + '…' : hit;
}

// EU calls that are not single-applicant need a consortium. Adds the tag
// (with the item's own note as evidence) when it is missing.
export function withConsortiumTag(g) {
  if (g.scope !== 'eu' || g.singleApplicant !== false || (g.requires && g.requires.consortium)) return g;
  return { ...g, requires: { ...(g.requires || {}), consortium: true }, requiresEvidence: { ...(g.requiresEvidence || {}), consortium: consortiumEvidence(g.note) } };
}
