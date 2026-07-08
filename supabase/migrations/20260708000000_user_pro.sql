-- Dayflow Pro entitlement — moved OUT of user_state.data.
--
-- Why this table exists
-- ---------------------
-- `user_state.data` is one JSONB blob that the browser upserts under the signed-in
-- user's own JWT. RLS keeps *other people* out of that row; it does not keep the
-- row's owner out. While `pro` lived inside that blob, any customer could open
-- devtools and grant themselves Pro forever:
--
--     proState = {active:true}; cloudSave();
--
-- The same shape caused a second bug: the Stripe webhook and the browser both did
-- read-modify-write over that one row, so a debounced client save that started
-- before the webhook could land after it and reset a paying customer's `pro` to
-- null.
--
-- Entitlement now lives here. The user may SELECT their own row and do nothing
-- else. The only writer is the stripe-webhook Edge Function, which uses the
-- service role and bypasses RLS — so there is deliberately no write policy below.
--
-- Note: this repo has no migration for `user_state` itself; that table was created
-- by hand in the dashboard before migrations existed. Run this file in the SQL Editor
-- (Supabase → SQL Editor → New query). `supabase db push` would apply it too, but it
-- prompts for the database password and would record this as the project's entire
-- migration history while `user_state` stays uncaptured. The editor also shows you
-- the output of the verification query at the bottom, which you want to read.

create table if not exists public.user_pro (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  active       boolean     not null default false,
  plan         text        not null default '',
  since        timestamptz,
  until        timestamptz,
  customer     text,
  subscription text,
  updated_at   timestamptz not null default now()
);

alter table public.user_pro enable row level security;

-- Reading your own entitlement is the entire surface the client gets.
drop policy if exists "user reads own pro" on public.user_pro;
create policy "user reads own pro"
  on public.user_pro
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy, on purpose: with RLS enabled and no policy for
-- an action, that action is denied. Belt and braces with explicit grants, since
-- Supabase's default privileges hand new public tables to these roles.
grant select on public.user_pro to authenticated;
revoke insert, update, delete on public.user_pro from authenticated;
revoke all on public.user_pro from anon;
grant all on public.user_pro to service_role;  -- the webhook's identity

-- Backfill from the old blob — but only trust rows that look like Stripe wrote them.
-- A real purchase carries a customer id (`cus_…`) written by checkout.session.completed.
--
-- Do NOT cast `active` with ::boolean. Every value under `pro` came from a blob the
-- user could write, so a stray `{"pro":{"active":"lol"}}` would abort this migration
-- on a cast error. Compare as text instead.
--
-- ⚠ This cannot fully distinguish a real subscriber from someone who forged a
-- plausible `cus_…` string into their own blob. It is safe here because the blob has
-- only ever held values this app wrote. If you have real paying subscribers, reconcile
-- against Stripe after running this — see the verification query at the bottom.
insert into public.user_pro (user_id, active, plan, since, customer, subscription)
select
  s.user_id,
  (s.data->'pro'->>'active') in ('true','t','1')
    and (s.data->'pro'->>'customer') like 'cus_%',
  coalesce(s.data->'pro'->>'plan', ''),
  case when s.data->'pro'->>'since' ~ '^[0-9]+$'
       then to_timestamp((s.data->'pro'->>'since')::bigint / 1000.0) end,
  case when (s.data->'pro'->>'customer') like 'cus_%'
       then s.data->'pro'->>'customer' end,
  case when (s.data->'pro'->>'subscription') like 'sub_%'
       then s.data->'pro'->>'subscription' end
from public.user_state s
where jsonb_typeof(s.data->'pro') = 'object'
on conflict (user_id) do nothing;

-- Now drop the old key. It is dead weight to the new client, and leaving it would
-- let a browser still running a cached copy of the old app.html keep reading (and
-- believing) a value it can write itself.
update public.user_state set data = data - 'pro' where data ? 'pro';

-- Let the app hear about activation the instant the webhook writes, the same way
-- it already listens to user_state. Guarded: adding a table twice is an error, and
-- a FOR ALL TABLES publication already covers it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'user_pro'
     )
  then
    execute 'alter publication supabase_realtime add table public.user_pro';
  end if;
end $$;

-- ── After running: check who this granted Pro to ─────────────────────────────
-- Every row it returns should be a customer you can find in Stripe → Customers.
-- If one isn't, that account forged its entitlement under the old scheme:
--     update public.user_pro set active = false where user_id = '…';
--
--   select user_id, plan, since, customer, subscription
--   from public.user_pro where active;
--
-- Expect zero rows if nobody has subscribed yet — that is the healthy result.
