-- ה-dispatcher כל דקה (אחרי שהפונקציה נפרסה).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- כל דקה. ההחלטה מה לשלוח לפי send_at (שחושב בשעון ישראל) — cron ב-UTC לא קובע אף פעם "בשעה X".
select cron.schedule(
  'dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://nklintfbsfagcwlbfwob.supabase.co/functions/v1/dispatcher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Dispatcher-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatcher_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
