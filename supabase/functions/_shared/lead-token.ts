// Signed status links for the grant-writer partner.
// token = first 32 hex chars of HMAC-SHA256(LEAD_STATUS_SECRET, ref + '|' + status)

export const REF_RE = /^L-[A-Z2-7]{6}$/;
export const TOKEN_RE = /^[0-9a-f]{32}$/;

/** Statuses the partner can set from an e-mail link. */
export const LINK_STATUSES = ['contacted', 'applied', 'won', 'lost', 'spam'] as const;
export type LinkStatus = typeof LINK_STATUSES[number];

export const ALL_STATUSES = ['new', 'sent', 'contacted', 'applied', 'won', 'lost', 'paid', 'spam'] as const;
export type LeadStatus = typeof ALL_STATUSES[number];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Új',
  sent: 'Továbbítva a partnernek',
  contacted: 'Felvették a kapcsolatot',
  applied: 'Pályázat beadva',
  won: 'Nyertes pályázat',
  lost: 'Nem valósult meg',
  paid: 'Jutalék kifizetve',
  spam: 'Spam / érvénytelen',
};

export const STATUS_PAGE = 'https://aipalyazo.hu/aipalyazo/lead-status.html';

export async function statusToken(secret: string, ref: string, status: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ref}|${status}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Constant-time for equal-length inputs; length mismatch returns early (length is public). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStatusToken(secret: string, ref: string, status: string, token: string): Promise<boolean> {
  if (!secret || !REF_RE.test(ref) || !TOKEN_RE.test(token)) return false;
  if (!(LINK_STATUSES as readonly string[]).includes(status)) return false;
  return timingSafeEqual(await statusToken(secret, ref, status), token);
}

export async function statusLink(secret: string, ref: string, status: LinkStatus, page = STATUS_PAGE): Promise<string> {
  const t = await statusToken(secret, ref, status);
  return `${page}?ref=${encodeURIComponent(ref)}&s=${status}&t=${t}`;
}
