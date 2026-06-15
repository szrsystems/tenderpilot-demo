// =========================================================================
// AIpályázó — Paddle webhook handler (Supabase Edge Function)
// =========================================================================
// Receives subscription lifecycle events from Paddle and updates the
// public.subscriptions + public.profiles.tier rows. This is the ONLY
// writer of the tier field; the frontend can never set it.
//
// Deploy:
//   supabase functions deploy paddle-webhook --no-verify-jwt
//
// Required env vars (set with `supabase secrets set`):
//   PADDLE_WEBHOOK_SECRET   — signing secret from Paddle dashboard
//   SUPABASE_URL            — auto-set by Supabase Edge runtime
//   SUPABASE_SERVICE_ROLE_KEY — service role key (auto-set)
//
// Paddle Billing v2 events handled:
//   subscription.created      → create row, set tier=pro
//   subscription.updated      → update period, status
//   subscription.canceled     → mark canceled_at, status=canceled
//   subscription.past_due     → status=past_due (still pro until period end)
//   subscription.activated    → status=active
//   transaction.completed     → store last_invoice_id, last_invoice_url
// =========================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PADDLE_SECRET = Deno.env.get('PADDLE_WEBHOOK_SECRET') ?? '';

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// -------------------------------------------------------------------------
// Paddle signature verification (HMAC-SHA256, Billing v2 style)
// Paddle-Signature: ts=<unix>;h1=<hmac>
// -------------------------------------------------------------------------
async function verifyPaddleSignature(rawBody: string, header: string | null): Promise<boolean> {
  // FAIL CLOSED: never accept an unsigned webhook. An unset secret in
  // production would let anyone forge a subscription.created and grant
  // themselves Pro for free, so we refuse instead of skipping verification.
  if (!PADDLE_SECRET) {
    console.error('[paddle-webhook] PADDLE_WEBHOOK_SECRET unset — refusing all events (fail closed)');
    return false;
  }
  if (!header) return false;
  const parts = Object.fromEntries(header.split(';').map(p => p.split('=')));
  const ts = parts.ts;
  const sig = parts.h1;
  if (!ts || !sig) return false;

  // Replay protection: reject signatures whose timestamp is more than 5 min
  // off from now (Paddle signs `ts:body`; a stale ts means a replayed event).
  const tsNum = parseInt(ts, 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > 300) return false;

  const payload = `${ts}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(PADDLE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(macBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// -------------------------------------------------------------------------
// Map Paddle status → our subscription.status enum
// -------------------------------------------------------------------------
function mapStatus(s: string): string {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active':   return 'active';
    case 'past_due': return 'past_due';
    case 'paused':   return 'past_due';
    case 'canceled': return 'canceled';
    default:         return 'expired';
  }
}

// -------------------------------------------------------------------------
// Find the user_id given a Paddle customer email or custom_data.user_id
// -------------------------------------------------------------------------
async function resolveUserId(data: any): Promise<string | null> {
  // Preferred: we pass user_id in custom_data when creating the checkout
  const customId = data?.custom_data?.user_id;
  if (customId) return customId;

  // Fallback: match by email on auth.users
  const email = data?.customer?.email || data?.customer_email;
  if (!email) return null;

  // Look up the profile by email (RLS bypass since we use service role)
  const { data: prof, error } = await db
    .from('profiles')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error || !prof) return null;
  return prof.id;
}

// -------------------------------------------------------------------------
// Apply tier to public.profiles. Service role bypasses the "can't change tier" RLS.
// -------------------------------------------------------------------------
async function setTier(userId: string, tier: 'basic' | 'pro') {
  const { error } = await db
    .from('profiles')
    .update({ tier, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) console.error('[paddle-webhook] setTier error', error);
}

// -------------------------------------------------------------------------
// Upsert subscription row
// -------------------------------------------------------------------------
async function upsertSubscription(row: Record<string, any>) {
  const { error } = await db
    .from('subscriptions')
    .upsert(row, { onConflict: 'paddle_subscription_id' });
  if (error) console.error('[paddle-webhook] upsertSubscription error', error);
}

// -------------------------------------------------------------------------
// Main handler
// -------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const raw = await req.text();
  const sigHeader = req.headers.get('paddle-signature');
  const valid = await verifyPaddleSignature(raw, sigHeader);
  if (!valid) {
    console.warn('[paddle-webhook] invalid signature');
    return new Response('invalid signature', { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const eventType = evt?.event_type ?? evt?.alert_name;
  const data = evt?.data ?? evt;

  console.log('[paddle-webhook]', eventType);

  try {
    switch (eventType) {
      case 'subscription.created':
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.past_due':
      case 'subscription.paused':
      case 'subscription.resumed': {
        const userId = await resolveUserId(data);
        if (!userId) {
          console.warn('[paddle-webhook] no user_id resolved for', eventType);
          return new Response('user not found', { status: 200 }); // 200 so Paddle doesn't retry forever
        }
        const status = mapStatus(data?.status);
        const periodEnd = data?.current_billing_period?.ends_at ?? data?.next_billed_at ?? data?.current_period_end;
        const periodStart = data?.current_billing_period?.starts_at ?? data?.current_period_start;
        const interval = (data?.billing_cycle?.interval === 'year') ? 'annual' : 'monthly';

        await upsertSubscription({
          user_id: userId,
          paddle_customer_id: data?.customer_id ?? data?.customer?.id,
          paddle_subscription_id: data?.id ?? data?.subscription_id,
          status,
          billing_interval: interval,
          current_period_start: periodStart,
          current_period_end: periodEnd,
        });

        // Active or trialing → pro tier. Past-due keeps pro until period end.
        if (['trialing', 'active', 'past_due'].includes(status)) {
          await setTier(userId, 'pro');
        }
        break;
      }

      case 'subscription.canceled':
      case 'subscription.expired': {
        const userId = await resolveUserId(data);
        if (!userId) return new Response('user not found', { status: 200 });

        const status = eventType === 'subscription.canceled' ? 'canceled' : 'expired';
        await upsertSubscription({
          user_id: userId,
          paddle_subscription_id: data?.id ?? data?.subscription_id,
          status,
          billing_interval: 'monthly',
          current_period_end: data?.canceled_at ?? data?.current_billing_period?.ends_at ?? new Date().toISOString(),
          canceled_at: data?.canceled_at ?? new Date().toISOString(),
        });
        await setTier(userId, 'basic');
        break;
      }

      case 'transaction.completed': {
        // Store invoice info on the matching subscription
        const subId = data?.subscription_id;
        if (subId) {
          await db.from('subscriptions').update({
            last_invoice_id: data?.invoice_id ?? data?.id,
            last_invoice_url: data?.invoice_pdf_url ?? data?.invoice_url,
            updated_at: new Date().toISOString(),
          }).eq('paddle_subscription_id', subId);
        }
        break;
      }

      default:
        console.log('[paddle-webhook] ignored event', eventType);
    }
  } catch (e) {
    console.error('[paddle-webhook] handler error', e);
    return new Response('handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});
