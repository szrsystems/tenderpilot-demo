// Server-side view of the public grant feed (grants_live.json).
// Edge functions use it so that grant titles, codes, deadlines and links
// come from the official feed, not from whatever the browser sent.

export const DEFAULT_GRANTS_URL = 'https://aipalyazo.hu/aipalyazo/grants_live.json';

export type Grant = {
  id: string;
  title: string;
  code?: string;
  deadline?: string;
  url?: string;
  amount?: string;
  cat?: string;
  issuer?: string;
  type?: string;
  note?: string;
  source?: string;
  rollingDeadline?: boolean;
  [k: string]: unknown;
};

export type GrantFeed = {
  all(): Promise<Grant[]>;
  byId(id: string): Promise<Grant | null>;
};

type Cache = { at: number; list: Grant[]; index: Map<string, Grant> };
const sharedCache = new Map<string, Cache>();

/**
 * Feed loader with a per-isolate in-memory cache (default 10 min). On a
 * failed refresh it serves the previous copy; with no copy at all it throws.
 */
export function createGrantFeed(opts: {
  url?: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
  cache?: Map<string, Cache>;
} = {}): GrantFeed {
  const url = opts.url || DEFAULT_GRANTS_URL;
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? sharedCache;

  async function load(): Promise<Cache> {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit;
    try {
      const r = await doFetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`feed http ${r.status}`);
      const raw = await r.json();
      const arr: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.grants) ? raw.grants : [];
      const list = arr.filter((g): g is Grant =>
        !!g && typeof g === 'object' && typeof (g as Grant).id === 'string' && typeof (g as Grant).title === 'string');
      if (!list.length) throw new Error('feed empty');
      const fresh = { at: now(), list, index: new Map(list.map((g) => [g.id, g])) };
      cache.set(url, fresh);
      return fresh;
    } catch (e) {
      if (hit) { console.warn('[grants] refresh failed, serving stale copy:', String(e).slice(0, 120)); return hit; }
      throw e;
    }
  }

  return {
    async all() { return (await load()).list; },
    async byId(id: string) { return (await load()).index.get(id) ?? null; },
  };
}
