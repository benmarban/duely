-- Dayflow — run the Gmail auto-checker every 5 minutes.
--
-- Uses pg_cron (scheduler) + pg_net (outbound HTTP from Postgres) to POST to the
-- gmail-poll Edge Function on a timer. The function is guarded by POLL_SECRET so
-- only this scheduled call can trigger it.
--
-- ⚠ The committed copy has PLACEHOLDERS so the real secret never lands in git.
-- Run the filled-in version (Claude hands it to you with __POLL_URL__ and
-- __POLL_SECRET__ substituted) in the Supabase SQL Editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any prior schedule so re-running is safe.
do $$
begin
  perform cron.unschedule('dayflow-gmail-poll');
exception when others then null;
end $$;

select cron.schedule('dayflow-gmail-poll', '*/5 * * * *', $CRON$
  select net.http_post(
    url     := '__POLL_URL__',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-poll-secret', '__POLL_SECRET__'),
    body    := '{}'::jsonb
  );
$CRON$);
