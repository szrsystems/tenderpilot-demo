# paddle-webhook

Supabase Edge Function that receives Paddle subscription lifecycle events
and updates `public.subscriptions` + `public.profiles.tier`.

## Deploy

```bash
# from repo root
supabase functions deploy paddle-webhook --no-verify-jwt
supabase secrets set PADDLE_WEBHOOK_SECRET=pdl_ntfset_...
```

The function URL ends up at:
```
https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1/paddle-webhook
```

Register that URL in the Paddle dashboard → Notifications → Add destination.
Subscribe to at minimum:
- subscription.created
- subscription.updated
- subscription.activated
- subscription.canceled
- subscription.past_due
- subscription.paused
- subscription.resumed
- transaction.completed

## How tier flips

| Paddle event                | profiles.tier  | subscriptions.status |
|-----------------------------|----------------|----------------------|
| subscription.created/active | `pro`          | `trialing`/`active`  |
| subscription.past_due       | `pro` (kept)   | `past_due`           |
| subscription.canceled       | `basic`        | `canceled`           |
| subscription.expired        | `basic`        | `expired`            |

The `getTier()` helper in `lib/supabase.js` reads the `user_with_tier` view
which joins these two; it only reports `pro` if BOTH the profile tier is `pro`
AND the subscription status is `trialing` or `active`.

## Custom data

When creating the Paddle checkout from the frontend, always pass:
```js
custom_data: { user_id: '<the supabase auth.users.id>' }
```
This is how the webhook resolves the buyer back to the GrantPilot user.
Email fallback exists but is fragile (people pay with a different email).
