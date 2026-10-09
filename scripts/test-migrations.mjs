// Run: node --test scripts/test-migrations.mjs
// Applies every supabase/migrations/*.sql in order onto an in-process
// Postgres (PGlite) with minimal Supabase stubs (auth schema, auth.uid(),
// auth.email(), roles anon/authenticated/service_role) and checks the
// security properties the app relies on.
//
// Needs @electric-sql/pglite: `npm i --no-save @electric-sql/pglite`, or point
// PGLITE_PATH at an installed copy's dist/index.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url);
const LATEST = '20260928000001_lead_pipeline.sql';

async function loadPGlite() {
  const tries = [process.env.PGLITE_PATH, '@electric-sql/pglite'].filter(Boolean);
  for (const t of tries) {
    try { return (await import(isAbsolute(t) ? pathToFileURL(t).href : t)).PGlite; } catch { /* next */ }
  }
  throw new Error('PGlite not found: npm i --no-save @electric-sql/pglite, or set PGLITE_PATH');
}

const STUBS = `
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz
);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.email() returns text language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
-- Supabase's default grants: everything to every API role, RLS decides.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const sql = (f) => readFileSync(new URL(f, MIG_DIR), 'utf8');

let db;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// Run fn as a given API role (+ optional JWT identity), always resetting.
async function as(role, user, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.email', '', false);`);
  if (user) {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.email', $2, false)`, [user.id, user.email]);
  }
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rejects = async (p, re) => { await assert.rejects(p, re); };

before(async () => {
  const PGlite = await loadPGlite();
  db = new PGlite();
  await db.exec(STUBS);
  assert.ok(files.includes(LATEST), 'latest migration present');
  for (const f of files) {
    if (f === LATEST) {
      // legacy data that the new migration must convert
      await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
      await db.exec(`insert into public.leads (user_id, grant_id, grant_title, name, email) values ('${A}', 'g-legacy', 'Régi', 'Régi Kérő', 'Old@Example.com');`);
      await db.exec(`insert into public.deleted_emails (email, reason) values ('Gone@Example.com', 'user_requested');`);
    }
    try { await db.exec(sql(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  // idempotent: the new migration can be applied again
  await db.exec(sql(LATEST));
});

test('anon and authenticated cannot insert leads', async () => {
  const row = `insert into public.leads (grant_id, name, email) values ('g1', 'Kiss Anna', 'anna@example.com')`;
  await as('anon', null, () => rejects(db.exec(row), /permission denied/));
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    rejects(db.exec(`insert into public.leads (user_id, grant_id, name, email) values ('${A}', 'g1', 'Kiss Anna', 'anna@example.com')`), /permission denied/));
});

test('service role inserts get a server-side ref and status new', async () => {
  const r = await as('service_role', null, () =>
    db.query(`insert into public.leads (grant_id, name, email) values ('g1', 'Kiss Anna', 'anna@example.com') returning lead_ref, status, notify_attempts`));
  assert.match(r.rows[0].lead_ref, /^L-[A-Z2-7]{6}$/);
  assert.equal(r.rows[0].status, 'new');
  assert.equal(r.rows[0].notify_attempts, 0);
});

test('legacy leads are backfilled and excluded from auto-forwarding', async () => {
  const r = await db.query(`select lead_ref, email, notify_attempts, notify_error from public.leads where grant_id = 'g-legacy'`);
  assert.match(r.rows[0].lead_ref, /^L-[A-Z2-7]{6}$/);
  assert.equal(r.rows[0].email, 'old@example.com');
  assert.equal(r.rows[0].notify_attempts, 5);
  assert.equal(r.rows[0].notify_error, 'legacy_pre_pipeline');
});

test('lead constraints reject oversized or malformed input', async () => {
  const ins = (cols, vals) => as('service_role', null, () => db.query(`insert into public.leads (${cols}) values (${vals.map((_, i) => '$' + (i + 1)).join(',')})`, vals));
  const base = ['grant_id', 'name', 'email'];
  const ok = ['g1', 'Kiss Anna', 'anna@example.com'];
  await rejects(ins(base.join(), ['g1', 'K', 'anna@example.com']), /leads_name_len/);
  await rejects(ins(base.join(), ['g1', 'x'.repeat(121), 'anna@example.com']), /leads_name_len/);
  await rejects(ins(base.join(), ['g1', 'Kiss Anna', 'not-an-email']), /leads_email_fmt/);
  await rejects(ins(base.join(), ['g1', 'Kiss Anna', 'a'.repeat(250) + '@x.hu']), /leads_email_fmt/);
  await rejects(ins(base.join() + ',phone', [...ok, '1'.repeat(41)]), /leads_phone_len/);
  await rejects(ins(base.join() + ',grant_title', [...ok, 't'.repeat(301)]), /leads_grant_title_len/);
  await rejects(ins(base.join() + ',company', [...ok, 'c'.repeat(201)]), /leads_company_len/);
  await rejects(ins(base.join() + ',message', [...ok, 'm'.repeat(2001)]), /leads_message_len/);
  await rejects(ins(base.join() + ',status', [...ok, 'bogus']), /leads_status_check/);
  const big = JSON.stringify({ blob: randomBytes(30000).toString('base64') });
  await rejects(ins(base.join() + ',match_snapshot', [...ok, big]), /leads_match_size/);
  // within limits passes
  await ins(base.join() + ',phone,company,message,match_snapshot', [...ok, '+36 30 123 4567', 'Teszt Kft.', 'm'.repeat(2000), JSON.stringify({ score: 80 })]);
});

test('claim_lead_notify: one sender at a time, never after success, client roles cannot call it', async () => {
  const { rows: [l] } = await as('service_role', null, () =>
    db.query(`insert into public.leads (grant_id, name, email) values ('g2', 'Nagy Béla', 'bela@example.com') returning id`));
  const claim = () => as('service_role', null, () => db.query('select public.claim_lead_notify($1) as ok', [l.id]));
  assert.equal((await claim()).rows[0].ok, true);
  assert.equal((await claim()).rows[0].ok, false, 'locked while the first sender works');
  await db.query(`update public.leads set notify_locked_until = null, notified_at = now() where id = $1`, [l.id]);
  assert.equal((await claim()).rows[0].ok, false, 'already notified');
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    rejects(db.query('select public.claim_lead_notify($1)', [l.id]), /permission denied/));
});

test('status change stamps status_updated_at', async () => {
  const { rows: [l] } = await db.query(`insert into public.leads (grant_id, name, email) values ('g3', 'Tóth Éva', 'eva@example.com') returning id`);
  const { rows: [u] } = await db.query(`update public.leads set status = 'contacted' where id = $1 returning status_updated_at`, [l.id]);
  assert.ok(u.status_updated_at);
});

test('users read only their own leads and only the public columns', async () => {
  await db.exec(`insert into public.leads (user_id, grant_id, name, email) values ('${B}', 'g4', 'B User', 'b@example.com')`);
  const r = await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    db.query('select grant_id, lead_ref, status from public.leads'));
  assert.deepEqual(r.rows.map((x) => x.grant_id), ['g-legacy']);
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    rejects(db.query('select ip_hash from public.leads'), /permission denied/));
});

test('profiles: a user cannot update another user or their own email', async () => {
  const userA = { id: A, email: 'a@example.com' };
  await as('authenticated', userA, async () => {
    const r = await db.query(`update public.profiles set company = 'Hacked' where id = $1`, [B]);
    assert.equal(r.affectedRows, 0);
  });
  assert.notEqual((await db.query(`select company from public.profiles where id = $1`, [B])).rows[0].company, 'Hacked');
  await as('authenticated', userA, () =>
    rejects(db.query(`update public.profiles set email = 'x@evil.com' where id = $1`, [A]), /permission denied/));
  await as('authenticated', userA, () =>
    rejects(db.query(`update public.profiles set gdpr_consent_at = now() where id = $1`, [A]), /permission denied/));
  await as('authenticated', userA, async () => {
    const r = await db.query(`update public.profiles set company = 'A Kft.', phone = '+3612345', teaor = '6201', industries = '{IT}' where id = $1`, [A]);
    assert.equal(r.affectedRows, 1);
  });
  await as('anon', null, () => rejects(db.query(`update public.profiles set company = 'x'`), /permission denied/));
});

test('notif_prefs.calendar_token exists, readable by owner, not writable', async () => {
  const r = await db.query(`select calendar_token from public.notif_prefs where user_id = $1`, [A]);
  assert.match(r.rows[0].calendar_token, /^[0-9a-f-]{36}$/);
  const userA = { id: A, email: 'a@example.com' };
  const own = await as('authenticated', userA, () => db.query('select user_id, calendar_token from public.notif_prefs'));
  assert.deepEqual(own.rows.map((x) => x.user_id), [A]);
  await as('authenticated', userA, () =>
    rejects(db.query(`update public.notif_prefs set calendar_token = gen_random_uuid() where user_id = $1`, [A]), /permission denied/));
  const rot = await as('authenticated', userA, () => db.query('select public.rotate_calendar_token() as t'));
  assert.notEqual(rot.rows[0].t, r.rows[0].calendar_token);
  // still switchable: existing column grants unaffected
  await as('authenticated', userA, () => db.query(`update public.notif_prefs set weekly_enabled = true where user_id = $1`, [A]));
});

test('deleted_emails stores hashes only; re-sign-up is still blocked', async () => {
  const legacy = await db.query(`select email, email_hash from public.deleted_emails`);
  assert.equal(legacy.rows.length, 1);
  assert.equal(legacy.rows[0].email, null);
  assert.equal(legacy.rows[0].email_hash, (await db.query(`select encode(sha256('gone@example.com'::bytea), 'hex') as h`)).rows[0].h);
  // legacy client insert shape {email} is hashed by the trigger
  const C = '33333333-3333-4333-8333-333333333333';
  await db.exec(`insert into auth.users (id, email) values ('${C}', 'c@example.com')`);
  await as('authenticated', { id: C, email: 'C@example.com' }, () =>
    db.query(`insert into public.deleted_emails (email, user_id) values ('c@example.com', $1)`, [C]));
  await as('authenticated', { id: C, email: 'c@example.com' }, () =>
    rejects(db.query(`insert into public.deleted_emails (email) values ('someone-else@example.com')`), /row-level security/));
  assert.equal((await db.query(`select count(*)::int as n from public.deleted_emails where email is not null`)).rows[0].n, 0);
  // the blocked user sees only their own row and the RPC says blocked
  const seen = await as('authenticated', { id: C, email: 'c@example.com' }, () => db.query('select email_hash from public.deleted_emails'));
  assert.equal(seen.rows.length, 1);
  const blocked = await as('authenticated', { id: C, email: 'c@example.com' }, () => db.query('select public.is_email_deleted() as b'));
  assert.equal(blocked.rows[0].b, true);
  const notBlocked = await as('authenticated', { id: A, email: 'a@example.com' }, () => db.query('select public.is_email_deleted() as b'));
  assert.equal(notBlocked.rows[0].b, false);
  await as('anon', null, () => rejects(db.query('select * from public.deleted_emails'), /permission denied/));
  // OAuth re-sign-up with a deleted address → profile carries the sentinel
  await db.exec(`insert into auth.users (email) values ('GONE@example.com')`);
  const p = await db.query(`select display_name from public.profiles where email = 'GONE@example.com'`);
  assert.equal(p.rows[0].display_name, '__DELETED__');
  const p2 = await db.query(`select display_name from public.profiles where id = $1`, [A]);
  assert.notEqual(p2.rows[0].display_name, '__DELETED__');
});

test('delete-user writes are valid: lead anonymisation, hash upsert, profile scrub', async () => {
  await as('service_role', null, async () => {
    const { rows: [l] } = await db.query(`insert into public.leads (user_id, grant_id, grant_title, name, email, phone, company, message, match_snapshot, ip_hash, status)
      values ($1, 'g9', 'Cím', 'Kiss Anna', 'anna@example.com', '+361', 'Kft', 'msg', '{"score":1}', 'abc', 'won') returning id, lead_ref`, [A]);
    await db.query(`update public.leads set user_id = null, name = 'Törölt felhasználó', email = 'torolt@deleted.invalid', phone = null, company = null,
      message = null, match_snapshot = null, ip_hash = null, status_note = null where user_id = $1`, [A]);
    const { rows: [after] } = await db.query('select lead_ref, status, grant_id, name, email, phone from public.leads where id = $1', [l.id]);
    assert.deepEqual(after, { lead_ref: l.lead_ref, status: 'won', grant_id: 'g9', name: 'Törölt felhasználó', email: 'torolt@deleted.invalid', phone: null });
    const h = (await db.query(`select public.email_hash('A@Example.com ') as h`)).rows[0].h;
    await db.query(`insert into public.deleted_emails (email_hash, reason) values ($1, 'user_requested') on conflict (email_hash) do nothing`, [h]);
    await db.query(`insert into public.deleted_emails (email_hash, reason) values ($1, 'user_requested') on conflict (email_hash) do nothing`, [h]);
    await db.query(`update public.profiles set display_name = '__DELETED__', email = 'deleted-' || id || '@aipalyazo.hu', company = null where id = $1`, [A]);
  });
});

test('purge_deleted_emails removes rows older than 180 days only', async () => {
  await db.exec(`insert into public.deleted_emails (email_hash, created_at) values (repeat('a', 64), now() - interval '181 days'), (repeat('b', 64), now() - interval '10 days')`);
  const r = await as('service_role', null, () => db.query('select public.purge_deleted_emails() as n'));
  assert.equal(r.rows[0].n, 1);
  assert.equal((await db.query(`select count(*)::int as n from public.deleted_emails where email_hash = repeat('b', 64)`)).rows[0].n, 1);
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    rejects(db.query('select public.purge_deleted_emails()'), /permission denied/));
});

test('global AI cap counts across users and is service-role only', async () => {
  const bump = () => as('service_role', null, () => db.query('select public.bump_ai_global(2) as ok'));
  assert.equal((await bump()).rows[0].ok, true);
  assert.equal((await bump()).rows[0].ok, true);
  assert.equal((await bump()).rows[0].ok, false);
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    rejects(db.query('select public.bump_ai_global(1000)'), /permission denied/));
});

test('attribution: user sets own campaign once (first touch kept); bad tags rejected; others untouchable', async () => {
  await db.exec(sql('20260928000003_attribution.sql')); // idempotent
  const prof = await db.query(`select id from public.profiles where id = '${A}'`);
  assert.equal(prof.rows.length, 1, 'profile row exists (handle_new_user)');
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    db.exec(`update public.profiles set acq_source = 'dft', acq_campaign = 'okt-2026', acq_at = now() + interval '5 days' where id = '${A}'`));
  await as('authenticated', { id: A, email: 'a@example.com' }, () =>
    db.exec(`update public.profiles set acq_source = 'google', acq_campaign = 'x' where id = '${A}'`));
  const r = await db.query(`select acq_source, acq_campaign, acq_at <= now() as sane from public.profiles where id = '${A}'`);
  assert.deepEqual([r.rows[0].acq_source, r.rows[0].acq_campaign, r.rows[0].sane], ['dft', 'okt-2026', true]);
  await as('authenticated', { id: B, email: 'b@example.com' }, () =>
    db.exec(`update public.profiles set acq_source = 'evil' where id = '${A}'`)); // RLS: affects 0 rows
  assert.equal((await db.query(`select acq_source from public.profiles where id = '${A}'`)).rows[0].acq_source, 'dft');
  await rejects(as('service_role', null, () => db.exec(`insert into public.leads (grant_id, name, email, utm_source) values ('g1', 'Kiss Anna', 'x@example.com', 'Bad Tag!')`)), /leads_utm_fmt/);
});

test('retention: ip_hash cleared after 90 days, leads anonymised after 5 years', async () => {
  await db.exec(sql('20261009000001_retention_and_limits.sql')); // idempotent
  await as('service_role', null, () => db.exec(`
    insert into public.leads (grant_id, name, email, phone, message, ip_hash, created_at) values
      ('g-ret-old', 'Régi Ügyfél', 'old5@example.com', '+36 30 123 4567', 'szia', 'h1', now() - interval '5 years 2 days'),
      ('g-ret-mid', 'Közép Ügyfél', 'mid@example.com', null, null, 'h2', now() - interval '100 days'),
      ('g-ret-new', 'Új Ügyfél', 'new@example.com', null, null, 'h3', now() - interval '2 days')`));
  await as('service_role', null, () => db.query('select public.purge_deleted_emails()'));
  const r = await db.query(`select grant_id, name, email, phone, message, ip_hash, lead_ref from public.leads where grant_id like 'g-ret-%' order by grant_id`);
  const by = Object.fromEntries(r.rows.map((x) => [x.grant_id, x]));
  assert.equal(by['g-ret-old'].name, 'Anonimizált');
  assert.equal(by['g-ret-old'].email, 'anonim+' + by['g-ret-old'].lead_ref + '@invalid.aipalyazo.hu');
  assert.equal(by['g-ret-old'].phone, null);
  assert.equal(by['g-ret-old'].message, null);
  assert.equal(by['g-ret-mid'].ip_hash, null);
  assert.equal(by['g-ret-mid'].name, 'Közép Ügyfél');
  assert.equal(by['g-ret-new'].ip_hash, 'h3');
});

test('limits: oversized profile/bookmark text rejected; drafts closed; deleted marker sticky', async () => {
  await as('authenticated', { id: B, email: 'b@example.com' }, () =>
    rejects(db.exec(`update public.profiles set company = repeat('x', 201) where id = '${B}'`), /profiles_company_len/));
  await as('authenticated', { id: B, email: 'b@example.com' }, () =>
    rejects(db.exec(`insert into public.bookmarks (user_id, grant_id, note) values ('${B}', 'g1', repeat('x', 2001))`), /bookmarks_note_len/));
  await as('authenticated', { id: B, email: 'b@example.com' }, () =>
    rejects(db.query(`select * from public.drafts`), /permission denied/));
  await db.exec(`update public.profiles set display_name = '__DELETED__' where id = '${B}'`);
  await as('authenticated', { id: B, email: 'b@example.com' }, () =>
    db.exec(`update public.profiles set display_name = 'Visszajöttem' where id = '${B}'`));
  assert.equal((await db.query(`select display_name from public.profiles where id = '${B}'`)).rows[0].display_name, '__DELETED__');
});
