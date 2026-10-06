-- Ledgerline · background sync every 6 hours (run AFTER the functions are deployed)
-- Before running, replace the two placeholders:
--   YOUR-PROJECT-REF  → the part before .supabase.co in your Project URL
--   YOUR-CRON-SECRET  → the same CRON_SECRET you saved under Edge Functions → Secrets
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('ledgerline-sync') where exists (select 1 from cron.job where jobname = 'ledgerline-sync');
select cron.schedule('ledgerline-sync', '17 */6 * * *', $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/plaid',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body    := jsonb_build_object('action', 'sync_all'),
    timeout_milliseconds := 120000
  );
$$);
