// =========================================================================
// AIpályázó — calendar Edge Function (personal iCal feed)
// =========================================================================
// Subscribable calendar of the user's SAVED calls' deadlines:
//   GET /functions/v1/calendar?t=<notif_prefs.calendar_token>
// → text/calendar, one all-day event per deadline with reminders 14 and 3
// days before; rolling calls are skipped. Titles/dates come from the live
// feed (GRANTS_URL), never from the client.
// Unknown token → 404 with an empty calendar. Feed down → 503 (so calendar
// apps keep their previous copy instead of wiping every event).
// The token is the only secret; users can rotate it (rpc rotate_calendar_token).
//
// Deploy: supabase functions deploy calendar --no-verify-jwt --project-ref kacnvchwfwvpkkyhyupb
// =========================================================================
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { makeEnv } from '../_shared/http.ts';
import { createGrantFeed, type GrantFeed } from '../_shared/grants.ts';
import { buildICS } from '../_shared/ics.mjs';

export type CalendarStore = {
  userByToken(token: string): Promise<string | null>;
  bookmarkIds(userId: string): Promise<string[]>;
};
export type Deps = {
  env?: Record<string, string | undefined>;
  store?: CalendarStore;
  grants?: GrantFeed;
  now?: () => Date;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAL_NAME = 'AIpályázó — mentett pályázatok';

export function supabaseCalendarStore(admin: any): CalendarStore {
  return {
    async userByToken(token) {
      const { data, error } = await admin.from('notif_prefs').select('user_id').eq('calendar_token', token).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.user_id ?? null;
    },
    async bookmarkIds(userId) {
      const { data, error } = await admin.from('bookmarks').select('grant_id').eq('user_id', userId).limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((b: any) => String(b.grant_id));
    },
  };
}

function ics(text: string, status: number, cache: string) {
  return new Response(status === 503 ? 'unavailable' : text, {
    status,
    headers: {
      'Content-Type': status === 503 ? 'text/plain; charset=utf-8' : 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="aipalyazo-hataridok.ics"',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(status === 503 ? { 'Retry-After': '900' } : {}),
    },
  });
}

export async function handler(req: Request, deps: Deps = {}): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method_not_allowed', { status: 405 });
  const env = makeEnv(deps.env);
  const now = (deps.now ?? (() => new Date()))();
  const empty = buildICS([], { now, calName: CAL_NAME }).text;

  const token = (new URL(req.url).searchParams.get('t') ?? '').trim();
  if (!UUID_RE.test(token)) return ics(empty, 404, 'no-store');

  try {
    const store = deps.store ?? supabaseCalendarStore(createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }));
    const userId = await store.userByToken(token.toLowerCase());
    if (!userId) return ics(empty, 404, 'no-store');
    const ids = new Set(await store.bookmarkIds(userId));
    const grants = deps.grants ?? createGrantFeed({ url: env('GRANTS_URL') || undefined });
    const list = (await grants.all()).filter((g) => ids.has(g.id));
    const { text } = buildICS(list, { now, calName: CAL_NAME, refresh: 'PT12H' });
    return ics(req.method === 'HEAD' ? '' : text, 200, 'private, max-age=3600');
  } catch (e) {
    console.error('[calendar] failed', String(e).slice(0, 200));
    return ics('', 503, 'no-store');
  }
}

if (import.meta.main) Deno.serve((req) => handler(req));
