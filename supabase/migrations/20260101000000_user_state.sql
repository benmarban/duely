-- Dayflow — public.user_state (the per-user app blob) captured into version control.
--
-- This table predates migrations; it was created by hand in the dashboard, which is
-- exactly why the Pro entitlement hole went unreviewed for so long — the security
-- rules lived somewhere nobody could read them in a diff. This file is that capture.
--
-- It is written to be SAFE TO RUN against the existing project:
--   • CREATE TABLE IF NOT EXISTS won't touch the live table or its data.
--   • Column definitions are best-effort (the app uses user_id, data, updated_at); if
--     the real table differs, IF NOT EXISTS means the real one wins — reconcile by
--     hand if a column is missing.
--   • The RLS policies are DROP-then-CREATE, so running this makes the live policy set
--     exactly match what's written here. That is the point: this file is now the
--     source of truth for who can read and write user_state.
--
-- Verified against production before writing: an anonymous caller gets [] from SELECT
-- (owner-scoped) and 401 on INSERT (RLS). These policies reproduce that.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

-- A signed-in user may see, create, change, and delete ONLY their own row. This is
-- the boundary that keeps one user out of another's schedule — note it does NOT stop
-- a user editing their own data.* blob, which is why the Pro entitlement had to move
-- to its own service-role-only table (see 20260708000000_user_pro.sql).
drop policy if exists "own row select" on public.user_state;
create policy "own row select" on public.user_state
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own row insert" on public.user_state;
create policy "own row insert" on public.user_state
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own row update" on public.user_state;
create policy "own row update" on public.user_state
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own row delete" on public.user_state;
create policy "own row delete" on public.user_state
  for delete to authenticated using (auth.uid() = user_id);

-- The email-inbound / stripe-webhook functions write here with the service role, which
-- bypasses RLS — no policy needed for them. anon gets nothing.
revoke all on public.user_state from anon;
grant select, insert, update, delete on public.user_state to authenticated;

-- Realtime: the app subscribes to its own row for live cross-device sync.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_state'
     )
  then
    execute 'alter publication supabase_realtime add table public.user_state';
  end if;
end $$;
