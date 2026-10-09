#!/usr/bin/env node
// =========================================================================
// AIpályázó — offline feed rebuild (no network)
// =========================================================================
// Re-applies the hand-verified layer to the CURRENT aipalyazo/grants_live.json
// without calling the palyazat.gov.hu or EU APIs:
//   - API items (pg-*): yesterday's items, with scripts/api-verified.json
//     re-applied (excludes, overlays, eligibility tags); expired ones dropped
//   - hand-verified items: rebuilt from scripts/verified-grants.json + the
//     monitor's flags/auto items (same code path as the daily build)
//   - auto EU items: yesterday's, if still open
// Writes grants_live.json, grants-meta.json and the change log. Use it after
// editing the verified lists when the APIs are unreachable; the daily job
// (fetch-live-grants.mjs) replaces the result with fresh API data.
//
// Run: node scripts/rebuild-offline.mjs [--today YYYY-MM-DD]
// =========================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildFeed, prevApiItems, diff } from './fetch-live-grants.mjs';
import { mergeChanges } from './changes-log.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function rebuildOffline({ prevGrants, verifiedItems, apiVerified, monitor, today }) {
  const { items: prebuiltApi, excluded } = prevApiItems(prevGrants, apiVerified, today);
  const euItems = prevGrants.filter((g) => g.auto && g.scope === 'eu' && g.deadline >= today);
  return buildFeed({ tenders: [], verifiedItems, apiVerified, euItems, prevGrants, today, monitor, prebuiltApi })
    .then((out) => ({ ...out, excluded: [...excluded, ...out.excluded] }));
}

async function main() {
  const i = process.argv.indexOf('--today');
  const today = i > 0 ? process.argv[i + 1] : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const prevGrants = readJson('aipalyazo/grants_live.json', []);
  if (!prevGrants.length) throw new Error('aipalyazo/grants_live.json missing — nothing to rebuild from');
  const out = await rebuildOffline({
    prevGrants,
    verifiedItems: readJson('scripts/verified-grants.json', { items: [] }).items,
    apiVerified: readJson('scripts/api-verified.json', {}),
    monitor: { flags: readJson('scripts/monitor/flags.json', {}), auto: readJson('scripts/monitor/auto-grants.json', []) },
    today,
  });
  const { grants } = out;
  const changes = diff(prevGrants, grants);
  const prevMeta = readJson('aipalyazo/grants-meta.json', {});
  writeFileSync('aipalyazo/grants_live.json', JSON.stringify(grants, null, 1));
  writeFileSync('aipalyazo/grants-meta.json', JSON.stringify({
    ...prevMeta,
    updatedAt: new Date().toISOString(),
    offlineRebuild: { at: today, apiDataFrom: prevMeta.updatedAt || null },
    // Source status is carried over from the last live run (no API called).
    sourcesOk: prevMeta.sourcesOk ?? !(prevMeta.apiFailed || prevMeta.euApiFailed),
    apiFailed: !!prevMeta.apiFailed,
    euApiFailed: !!prevMeta.euApiFailed,
    sources: prevMeta.sources || {
      palyazatApi: { ok: !prevMeta.apiFailed, items: out.apiGrants.length, lastOk: prevMeta.apiFailed ? null : prevMeta.updatedAt || null },
      euApi: { ok: !prevMeta.euApiFailed, items: out.euAuto.length, lastOk: prevMeta.euApiFailed ? null : prevMeta.updatedAt || null },
    },
    counts: {
      total: grants.length, api: out.apiGrants.length, verified: out.verified.length, euAuto: out.euAuto.length,
      hazai: grants.filter((g) => g.scope !== 'eu').length, eu: grants.filter((g) => g.scope === 'eu').length,
      excluded: out.excluded.length,
    },
    staleVerified: out.stale,
    droppedVerified: out.dropped,
    changes: changes.slice(0, 100),
  }, null, 1));
  const log = existsSync('aipalyazo/changes.json') ? readJson('aipalyazo/changes.json', {}) : {};
  writeFileSync('aipalyazo/changes.json', JSON.stringify(mergeChanges(log, changes, today), null, 1));
  console.log(`offline rebuild: ${grants.length} grants (${out.apiGrants.length} API, ${out.verified.length} verified, ${out.euAuto.length} EU auto) | dropped ${out.dropped.length} | ${changes.length} changes`);
  for (const c of changes) console.log(`  ${c.type}: ${c.id}${c.from !== undefined ? ` ${c.from} → ${c.to}` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
