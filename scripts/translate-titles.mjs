// Run: GEMINI_API_KEY=… node scripts/translate-titles.mjs
// Translates English call titles once (cached in aipalyazo/titles-hu.json),
// then re-applies all known Hungarian titles to aipalyazo/grants_live.json.
// Without a key it only re-applies the cache. Never fails the daily job.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { llmFromEnv, parseJsonLoose } from './monitor/extract.mjs';
import { applyHungarianTitles, missingTitles, buildPrompt, cleanTranslations } from './titles-hu.mjs';

const FEED = 'aipalyazo/grants_live.json';
const CACHE = 'aipalyazo/titles-hu.json';
const BATCH = 40;
const MAX_CALLS = +(process.env.MAX_TITLE_CALLS || 12);

const grants = JSON.parse(readFileSync(FEED, 'utf8'));
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const llm = llmFromEnv();
const todo = missingTitles(grants, cache);
let calls = 0, added = 0;
if (llm) {
  for (let i = 0; i < todo.length && calls < MAX_CALLS; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    calls++;
    try {
      const got = cleanTranslations(parseJsonLoose(await llm(buildPrompt(batch))), batch);
      Object.assign(cache, got);
      added += Object.keys(got).length;
    } catch (e) {
      console.log('translation batch failed:', String(e.message || e).slice(0, 120));
    }
  }
}
// drop cache rows of calls no longer listed (keeps the file small)
const live = new Set(grants.map((g) => g.id));
for (const id of Object.keys(cache)) if (!live.has(id)) delete cache[id];
const applied = applyHungarianTitles(grants, cache);
writeFileSync(CACHE, JSON.stringify(cache, null, 1));
writeFileSync(FEED, JSON.stringify(grants, null, 1));
console.log(`titles: ${todo.length} missing, ${added} translated in ${calls} call(s), ${applied} shown in Hungarian${llm ? '' : ' (no LLM key — cache only)'}`);
