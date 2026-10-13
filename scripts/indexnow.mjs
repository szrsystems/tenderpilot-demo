#!/usr/bin/env node
// =========================================================================
// AIpályázó — IndexNow ping (Bing, Yandex, Seznam, Naver …)
// =========================================================================
// Tells search engines which pages changed today, so new and updated calls
// are re-crawled within hours instead of weeks. Bing's index also feeds
// ChatGPT / Copilot search, so this matters for AI answers too.
// Sends every sitemap URL whose <lastmod> is today plus the list and topic
// pages (they change daily). The key is public by design: the file
// https://aipalyazo.hu/<KEY>.txt proves we own the host.
// Run after the pages are built: node scripts/indexnow.mjs [--all] [--dry]
// (--all: every sitemap URL — used on a manual run of the workflow)
// =========================================================================
import { readFileSync } from 'node:fs';

export const KEY = 'e98c152f1d6c05ecdc5365c6edd85ec6';
const HOST = 'aipalyazo.hu';

export function changedUrls(sitemapXml, today, all = false) {
  const out = [];
  for (const m of sitemapXml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<changefreq>([^<]+)<\/changefreq>/g)) {
    const [, loc, lastmod, freq] = m;
    if (all || lastmod === today || freq === 'daily') out.push(loc.replace(/&amp;/g, '&'));
  }
  return [...new Set(out)].slice(0, 10000);
}

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
  const xml = readFileSync(new URL('../aipalyazo/sitemap.xml', import.meta.url), 'utf8');
  const urlList = changedUrls(xml, today, process.argv.includes('--all'));
  if (!urlList.length) { console.log('indexnow: nothing changed today'); return; }
  if (process.argv.includes('--dry')) { console.log('indexnow (dry):', urlList.length, 'URLs'); return; }
  const r = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(`indexnow: ${urlList.length} URLs → HTTP ${r.status}`); // 200/202 = accepted
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main().catch((e) => { console.error('indexnow failed:', String(e).slice(0, 200)); });
