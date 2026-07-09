-- Dayflow — the Sunday plan, checked once an hour.
--
-- The function itself decides who gets mail: it only sends to a Pro user whose
-- *local* clock reads Sunday 7pm. That's why this runs hourly rather than once a
-- week — "Sunday at 7pm" is a different instant in every timezone, and a single
-- weekly UTC cron would reach California at 4pm and Berlin on Monday.
--
-- Runs at :05 past the hour to stay clear of the gmail-poll job at */5.
--
-- ⚠ The committed copy has PLACEHOLDERS so the real secret never lands in git.
-- Run the filled-in version in the Supabase SQL Editor, substituting
-- __DIGEST_URL__ and __DIGEST_SECRET__.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any prior schedule so re-running this file is safe.
do $$
begin
  perform cron.unschedule('dayflow-weekly-digest');
exception when others then null;
end $$;

select cron.schedule('dayflow-weekly-digest', '5 * * * *', $CRON$
  select net.http_post(
    url     := '__DIGEST_URL__',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-digest-secret', '__DIGEST_SECRET__'),
    body    := '{}'::jsonb
  );
$CRON$);
