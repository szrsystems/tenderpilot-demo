// Extracts the `const G = [...]` grant array from aipalyazo/portal.html into
// aipalyazo/grants.json so the backend (weekly-digest Edge Function) can read
// the same grant list. Re-run after editing the G array in portal.html:
//   node scripts/export-grants.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('aipalyazo/portal.html', 'utf8');
const marker = src.indexOf('const G = [');
if (marker === -1) { console.error('const G = [ not found'); process.exit(1); }
const arrStart = src.indexOf('[', marker);

// String-aware bracket matcher (so a "]" inside a title doesn't end the array).
let depth = 0, inStr = null, esc = false, end = -1;
for (let i = arrStart; i < src.length; i++) {
  const c = src[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === '\\') esc = true;
    else if (c === inStr) inStr = null;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
  if (c === '[') depth++;
  else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
}
if (end === -1) { console.error('array end not found'); process.exit(1); }

const arrStr = src.slice(arrStart, end + 1);
// The array is valid JS (single quotes, unquoted keys) — eval it, then re-serialise as JSON.
const G = (0, eval)('(' + arrStr + ')');
writeFileSync('aipalyazo/grants.json', JSON.stringify(G));
console.log(`exported ${G.length} grants → aipalyazo/grants.json`);
