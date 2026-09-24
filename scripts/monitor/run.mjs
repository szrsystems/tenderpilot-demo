#!/usr/bin/env node
// =========================================================================
// AIpályázó daily monitor — discover new calls + fact-check listed ones
// =========================================================================
// 1. RE-CHECK every hand-verified / auto-verified item on its official page:
//    - EU topics: the portal's own topicDetails JSON (exact deadline/status)
//    - other pages: HTTP status + page hash; when the page changed, the
//      grounded extractor re-reads it (quotes must be on the page)
//    Two failed checks in a row (page gone, or page says closed) → hidden.
// 2. DISCOVER new calls from the official listing pages in sources.json.
//    New links are read by the grounded extractor:
//      all checks pass + official domain → published automatically
//      anything else                     → review-queue.json for a human
// 3. WRITE state.json (page hashes, counters), flags.json (hide/override),
//    auto-grants.json, review-queue.json, report.md (GitHub summary/issue).
//
// Without an LLM key it still does the deterministic parts (EU JSON checks,
// dead pages, discovery → queue). Cost with a key: only NEW or CHANGED pages
// are sent to the model, capped by MAX_LLM_CALLS.
// =========================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFetcher, extractLinks, hash, pool, todayBudapest } from './lib.mjs';
import { extractFacts, llmFromEnv } from './extract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (f) => join(HERE, f);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const EU_TOPIC = /\/topic-details\/([a-z0-9._-]+)/i;
const topicJsonUrl = (id) => `https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/${id.toLowerCase()}.json`;

// Next deadline + status from the EU portal's topicDetails JSON.
export function euTopicFacts(json, today) {
  const t = json && (json.TopicDetails || json.topicDetails || json);
  if (!t) return null;
  const dates = [];
  for (const a of t.actions || []) for (const d of a.deadlineDates || []) {
    const iso = typeof d === 'number' ? new Date(d).toISOString().slice(0, 10) : String(d).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) dates.push(iso);
  }
  dates.sort();
  const next = dates.find((d) => d >= today) || null;
  const statusTxt = JSON.stringify((t.actions || []).map((a) => a.status)).toLowerCase();
  return { next, closed: !next || /closed/.test(statusTxt) && !/open|forthcoming/.test(statusTxt) };
}

export async function runMonitor({
  items, sources, officialDomains, state, fetchImpl = fetch, llm = null, today = todayBudapest(),
  maxLlmCalls = 60, maxNewPerSource = 15, delayMs = 1200, prevAuto = [],
}) {
  const fetchPage = makeFetcher({ fetchImpl, delayMs });
  state.pages = state.pages || {};
  state.seen = state.seen || {};
  const flags = { hide: {}, overrides: {} };
  const review = [];
  const log = [];
  let llmCalls = 0;
  const canLlm = () => llm && llmCalls < maxLlmCalls;
  const official = (url) => { try { const h = new URL(url).hostname; return officialDomains.some((d) => h === d || h.endsWith('.' + d)); } catch { return false; } };

  // ---------------------------------------------------------------- 1) re-check
  const checkable = items.filter((g) => g.url && !String(g.id).startsWith('pg-') && !g.auto);
  const results = await pool(checkable, 8, async (g) => {
    const st = state.pages[g.url] || (state.pages[g.url] = {});
    const m = g.url.match(EU_TOPIC);
    if (m) {
      const r = await fetchPage(topicJsonUrl(m[1]));
      if (r.status !== 200 || !r.json) return { g, outcome: 'unreachable', detail: `topicDetails HTTP ${r.status}` };
      const f = euTopicFacts(r.json, today);
      if (!f || f.closed) { st.closedHits = (st.closedHits || 0) + 1; return { g, outcome: 'closed', detail: 'EU portál: nincs jövőbeli határidő' }; }
      st.closedHits = 0; st.lastOk = today;
      if (g.deadline && g.deadline !== 'Folyamatos' && f.next !== g.deadline) return { g, outcome: 'deadline', deadline: f.next, detail: `EU portál: ${g.deadline} → ${f.next}` };
      return { g, outcome: 'ok' };
    }
    const r = await fetchPage(g.url);
    if (r.status === 404 || r.status === 410) { st.goneHits = (st.goneHits || 0) + 1; return { g, outcome: 'gone', detail: `HTTP ${r.status}` }; }
    if (r.status !== 200) return { g, outcome: 'unreachable', detail: r.blocked ? 'robots.txt' : `HTTP ${r.status || r.error}` };
    st.goneHits = 0;
    const h = hash(r.text);
    const changed = st.hash && st.hash !== h;
    const first = !st.hash;
    st.hash = h;
    if (!changed && !first) { st.lastOk = today; return { g, outcome: 'ok' }; }
    if (!canLlm()) return { g, outcome: first ? 'baseline' : 'changed-unchecked', detail: first ? 'első mentés' : 'az oldal megváltozott, LLM nélkül nem ellenőrizhető' };
    llmCalls++;
    const v = await extractFacts(r, { llm, today }).catch((e) => ({ ok: false, problems: [String(e.message || e)] }));
    const f = v.facts || {};
    if (['closed', 'suspended'].includes(f.status) && f.evidence && v.problems && !v.problems.includes('status not on page')) {
      st.closedHits = (st.closedHits || 0) + 1;
      return { g, outcome: 'closed', detail: `az oldal szerint: „${String(f.evidence.status).slice(0, 120)}”` };
    }
    st.closedHits = 0;
    if (v.ok) {
      st.lastOk = today;
      if (f.deadline && g.deadline !== f.deadline) return { g, outcome: 'deadline', deadline: f.deadline, detail: `oldal szerint: „${f.evidence.deadline}”` };
      return { g, outcome: 'ok' };
    }
    return { g, outcome: 'changed-unverified', detail: v.problems.join('; ') };
  });

  for (const x of results) {
    const st = state.pages[x.g.url];
    if (x.outcome === 'ok') flags.overrides[x.g.id] = { ...(flags.overrides[x.g.id] || {}), lastChecked: today };
    if (x.outcome === 'deadline') {
      flags.overrides[x.g.id] = { deadline: x.deadline, lastChecked: today, note: x.detail };
      review.push({ kind: 'deadline-changed', id: x.g.id, title: x.g.title, url: x.g.url, outcome: 'auto-fixed', detail: x.detail });
    }
    if ((x.outcome === 'closed' && st.closedHits >= 2) || (x.outcome === 'gone' && st.goneHits >= 2)) flags.hide[x.g.id] = `${x.outcome}: ${x.detail}`;
    if (['closed', 'gone', 'changed-unverified', 'changed-unchecked'].includes(x.outcome) && !flags.hide[x.g.id]) {
      review.push({ kind: 'recheck', id: x.g.id, title: x.g.title, url: x.g.url, outcome: x.outcome, detail: x.detail });
    }
  }
  const counts = results.reduce((a, x) => (a[x.outcome] = (a[x.outcome] || 0) + 1, a), {});
  log.push(`Re-check: ${checkable.length} items — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // --------------------------------------------------------------- 2) discover
  const knownUrls = new Set(items.map((g) => String(g.url || '').replace(/\/$/, '')));
  const auto = new Map(prevAuto.filter((g) => !g.deadline || g.deadline === 'Folyamatos' || g.deadline >= today).map((g) => [g.id, g]));
  for (const src of sources) {
    const re = new RegExp(src.pattern);
    const links = new Set();
    let ok = 0;
    for (const u of src.list) {
      const r = await fetchPage(u);
      if (r.status === 200) { ok++; for (const l of extractLinks(r.html, r.finalUrl || u)) if (re.test(l)) links.add(l); }
    }
    const seen = new Set(state.seen[src.id] || []);
    const fresh = [...links].filter((l) => !seen.has(l) && !knownUrls.has(l));
    log.push(`Source ${src.id}: ${ok}/${src.list.length} list pages, ${links.size} call links, ${fresh.length} new${links.size === 0 && ok ? ' — ⚠ 0 matches: check the pattern' : ''}${ok === 0 ? ' — ⚠ list pages unreachable' : ''}`);
    for (const l of fresh.slice(0, maxNewPerSource)) {
      const r = await fetchPage(l);
      if (r.status !== 200) continue; // try again tomorrow (not marked seen)
      seen.add(l);
      if (!canLlm()) { review.push({ kind: 'new', source: src.id, url: l, detail: 'új oldal — LLM kulcs nélkül kézi ellenőrzés kell' }); continue; }
      llmCalls++;
      const v = await extractFacts(r, { llm, today }).catch((e) => ({ ok: false, problems: [String(e.message || e)] }));
      const f = v.facts || {};
      if (v.ok && official(l)) {
        const id = 'a-' + slug(f.code || f.title);
        auto.set(id, {
          id, code: f.code || null, title: f.title, issuer: src.name, cat: f.cat || 'KKV fejlesztés', type: f.type === 'other' ? 'grant' : f.type,
          amount: f.amount || '', rate: null, deadline: f.deadline || null, rolling: !!f.rolling, windowOpen: f.window_open || null,
          sizeClasses: (f.sizes || []).map((s) => ({ mikro: 'mikrovállalkozás', kis: 'kisvállalkozás', 'közép': 'középvállalkozás', nagy: 'nagyvállalkozás' })[s]).filter(Boolean),
          regions: [], regionNote: f.regions_note || null, note: f.note_hu || null,
          url: l, source: new URL(l).hostname.replace(/^www\./, ''), sources: [l], verifiedAt: today, confidence: 'auto',
          autoVerified: true, scope: src.scope, singleApplicant: src.scope === 'eu' ? null : undefined,
          evidence: f.evidence,
        });
      } else if (f.is_funding_call !== false) {
        review.push({ kind: 'new', source: src.id, url: l, title: f.title || null, detail: (v.problems || []).join('; ') });
      }
    }
    state.seen[src.id] = [...seen].slice(-2000);
  }
  log.push(`LLM calls: ${llmCalls}${llm ? '' : ' (no key — extraction off)'}; auto-published: ${auto.size}; review queue: ${review.length}; hidden: ${Object.keys(flags.hide).length}`);
  return { flags, review, auto: [...auto.values()], state, log };
}

// ------------------------------------------------------------------ CLI
async function main() {
  const REPO = join(HERE, '..', '..');
  const today = todayBudapest();
  const verified = readJson(join(REPO, 'scripts/verified-grants.json'), { items: [] }).items;
  const prevAuto = readJson(P('auto-grants.json'), []);
  const cfg = readJson(P('sources.json'), { sources: [], officialDomains: [] });
  const state = readJson(P('state.json'), {});
  const out = await runMonitor({
    items: [...verified, ...prevAuto], sources: cfg.sources, officialDomains: cfg.officialDomains, state,
    llm: llmFromEnv(), today, prevAuto, maxLlmCalls: +(process.env.MAX_LLM_CALLS || 60),
  });
  writeFileSync(P('state.json'), JSON.stringify(out.state, null, 1));
  writeFileSync(P('flags.json'), JSON.stringify({ updatedAt: today, ...out.flags }, null, 1));
  writeFileSync(P('auto-grants.json'), JSON.stringify(out.auto, null, 1));
  writeFileSync(P('review-queue.json'), JSON.stringify({ updatedAt: today, items: out.review }, null, 1));
  const md = [`## AIpályázó napi ellenőrzés — ${today}`, '', ...out.log.map((l) => `- ${l}`), '',
    out.review.length ? '### Kézi ellenőrzésre vár\n\n' + out.review.slice(0, 80).map((r) => `- [${r.kind}] ${r.title || r.id || ''} — ${r.detail || ''} — ${r.url}`).join('\n') : 'Nincs kézi teendő.',
    Object.keys(out.flags.hide).length ? '\n### Elrejtve (2 egymást követő sikertelen ellenőrzés)\n\n' + Object.entries(out.flags.hide).map(([k, v]) => `- ${k}: ${v}`).join('\n') : ''].join('\n');
  writeFileSync(P('report.md'), md);
  console.log(out.log.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
