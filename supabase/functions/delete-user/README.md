# delete-user

GDPR Art. 17 account deletion for the signed-in caller. Runs four checked
steps and reports exactly where it stopped (see the header of `index.ts`):

1. `block` — sha256(lower(email)) into `deleted_emails` (180-day retention)
2. `leads` — personal data in the user's leads erased; lead_ref / grant /
   status / dates kept for commission accounting
3. `data` — bookmarks, drafts, notif_prefs, alert_log, ai_usage deleted;
   profile scrubbed to the `__DELETED__` sentinel
4. `account` — `auth.users` row deleted (profile cascades)

Responses: `200 {ok:true}` · `401 {error:'unauthorized'}` ·
`500 {error:'delete_failed', step, dataDeleted}`. Safe to retry.

## Deploy

```bash
supabase functions deploy delete-user --project-ref kacnvchwfwvpkkyhyupb
```

JWT verification stays ON (default): send the user's access token as
`Authorization: Bearer <token>`.

## Tests

```bash
deno test -A --config <deno.json mapping jsr:@supabase/supabase-js@2 → npm:@supabase/supabase-js@2> supabase/functions/delete-user/test.ts
```
