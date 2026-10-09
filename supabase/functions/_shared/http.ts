// Small HTTP helpers shared by the AIpályázó edge functions.

export const SITE_ORIGINS = [
  'https://aipalyazo.hu',
  'https://www.aipalyazo.hu',
];

export type Env = (key: string) => string | undefined;

/** deps.env (tests) or the real environment. */
export function makeEnv(vars?: Record<string, string | undefined>): Env {
  if (vars) return (k) => vars[k];
  return (k) => Deno.env.get(k);
}

export function corsHeaders(origin: string | null, methods = 'POST, OPTIONS', allowed = SITE_ORIGINS): Record<string, string> {
  const allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': methods,
    'Vary': 'Origin',
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** HTML-escape anything (text nodes and attribute values). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Only http(s) URLs may become href values. */
export function safeUrl(u: unknown): string | null {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return null;
  return s;
}

export function bearer(req: Request): string {
  return (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
}

/** Read a JSON object body with a hard size cap. Returns null when unusable. */
export async function readJsonObject(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  let text: string;
  try { text = await req.text(); } catch { return null; }
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same as public.email_hash() in SQL: sha256(lower(trim(email))) hex. */
export function emailHash(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

// deno-lint-ignore no-control-regex
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// deno-lint-ignore no-control-regex
export const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;

/** Europe/Budapest calendar date (YYYY-MM-DD) of an instant. */
export function budapestDate(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Budapest' });
}

export function budapestDateTime(d: Date): string {
  return d.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
