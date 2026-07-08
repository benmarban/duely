-- Dayflow — Gmail connections vault (for one-click "Connect Gmail" auto-intake).
--
-- Holds the long-lived Google refresh token per user, which is what lets the
-- background checker read their mail forever without them lifting a finger. A
-- refresh token is as sensitive as a password, so this table is service-role ONLY:
-- the browser can never read or write it. There is deliberately no RLS policy for
-- authenticated/anon, and their grants are revoked — only the Edge Functions
-- (gmail-oauth-callback, gmail-poll), which run as the service role and bypass RLS,
-- ever touch it.
--
-- The app shows "Gmail connected ✓" from a NON-secret flag the callback writes into
-- user_state.data.gmail ({ connected, email }) — never from this table — so the
-- token never has a path to the browser. Same split we used for Pro entitlement.

create table if not exists public.gmail_accounts (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  email           text,               -- the connected Gmail address (for display)
  refresh_token   text not null,      -- Google offline token — SECRET
  last_history_id text,               -- Gmail historyId marker for incremental sync
  connected_at    timestamptz not null default now(),
  last_sync_at    timestamptz,
  last_error      text                -- surfaced for debugging a stuck connection
);

alter table public.gmail_accounts enable row level security;

-- No policies on purpose: with RLS enabled and no policy, every action by
-- authenticated/anon is denied. Belt-and-braces with explicit grant revocation.
revoke all on public.gmail_accounts from anon;
revoke all on public.gmail_accounts from authenticated;
grant all on public.gmail_accounts to service_role;

-- One-time OAuth "state" codes: when a user clicks Connect Gmail we mint a random
-- state tied to their id, hand it to Google, and match it back on the callback —
-- so the returning request proves which Dayflow account is linking. Short-lived,
-- single-use, service-role only.
create table if not exists public.gmail_oauth_state (
  state       text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

alter table public.gmail_oauth_state enable row level security;
revoke all on public.gmail_oauth_state from anon;
revoke all on public.gmail_oauth_state from authenticated;
grant all on public.gmail_oauth_state to service_role;
