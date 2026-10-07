-- עבודת הזיכרון כל שעה (אחרי שהפונקציה נפרסה).
-- עבודת רקע שעתית (חילוץ; ובשלוש בלילה גם איחוד). אותו סוד Vault כמו ה-dispatcher.
select cron.schedule(
  'memory-worker',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://nklintfbsfagcwlbfwob.supabase.co/functions/v1/memory-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Dispatcher-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatcher_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
