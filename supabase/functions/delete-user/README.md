# delete-user

Supabase Edge Function for full GDPR Article 17 account deletion. Wipes all
user-owned data + the `auth.users` row (which the user can't do themselves —
needs `service_role`).

## Deploy

```bash
supabase functions deploy delete-user
```

(Default flags — JWT verification ON. The caller must send their access token
in the Authorization header.)

URL becomes:
```
https://kacnvchwfwvpkkyhyupb.supabase.co/functions/v1/delete-user
```

## Frontend wiring

In `aipalyazo/portal.html`, `deleteAccount()` should `fetch()` this endpoint
with the user's session JWT:

```js
const { data: { session } } = await window.gp.client.auth.getSession();
const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-user`, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
    }
});
```

(Currently the frontend just clears user-owned rows + marks profile deleted +
signs out. Wire this in once the Edge Function is deployed.)

## Safety checks

- Refuses to delete if there's an active subscription (`active`/`trialing`/
  `past_due`) — user must cancel first.
- Always wipes user-owned rows BEFORE the auth.users delete (defensive — the
  FK cascade should handle it, but this protects against partial states).
- All errors logged to function logs.
