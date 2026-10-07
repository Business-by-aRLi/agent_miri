-- שלב 2: תזכורות, מעקב, שבת וחג.

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'followup', 'followup_evening', 'nudge', 'question')),
  text text, -- לתזכורת חופשית; לתזכורת של משימה — הכותרת נלקחת מהמשימה בזמן השליחה
  send_at timestamptz not null, -- הזמן המבוקש; שבת/חג דוחים אותו בזמן השליחה
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index reminders_due_idx on public.reminders (send_at) where status = 'pending';
create index reminders_task_idx on public.reminders (task_id) where status = 'pending';
alter table public.reminders enable row level security;

-- חלונות שקט (שבת/חג) — מתעדכנים מ-Hebcal על ידי ה-dispatcher
create table public.quiet_windows (
  start_at timestamptz primary key,
  end_at timestamptz not null,
  fetched_at timestamptz not null default now()
);
alter table public.quiet_windows enable row level security;

-- ---------- שליפה בטוחה ----------
-- תופס תזכורות שהגיע זמנן ומסמן 'sending' באותה פעולה. SKIP LOCKED: שתי ריצות במקביל לא יתפסו אותה שורה.
-- 'sending' שנתקע יותר מ-5 דקות (קריסה באמצע) — חוזר לתור.
create function public.claim_due_reminders(p_now timestamptz, p_limit integer default 50)
returns setof public.reminders
language plpgsql
set search_path = public
as $$
begin
  update reminders set status = 'pending'
  where status = 'sending' and claimed_at < p_now - interval '5 minutes';

  return query
  update reminders r set status = 'sending', claimed_at = p_now, attempts = r.attempts + 1
  where r.id in (
    select id from reminders
    where status = 'pending' and send_at <= p_now
    order by send_at
    for update skip locked
    limit p_limit
  )
  returning r.*;
end;
$$;
revoke execute on function public.claim_due_reminders from public, anon, authenticated;

-- ---------- מעקב אוטומטי על משימות ----------
-- מועד השתנה → מעקב חדש 30 דקות אחרי המועד. משימה נסגרה → כל התזכורות שלה מבוטלות.
-- למה טריגר: כל דרך לשנות משימה (כלי, כפתור, SQL ידני) מקבלת אותה התנהגות.
create function public.tasks_sync_followups()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('done', 'dropped') then
    update reminders set status = 'cancelled'
    where task_id = new.id and status = 'pending';
    return new;
  end if;

  if tg_op = 'INSERT' or new.due_at is distinct from old.due_at then
    update reminders set status = 'cancelled'
    where task_id = new.id and status = 'pending' and kind in ('followup', 'followup_evening');
    if new.due_at is not null then
      insert into reminders (task_id, kind, send_at)
      values (new.id, 'followup', new.due_at + interval '30 minutes');
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_sync_followups
after insert or update of due_at, status on public.tasks
for each row execute function public.tasks_sync_followups();

-- משימות פתוחות עם מועד עתידי — מקבלות מעקב עכשיו. מועדים שכבר עברו לא: בלי מבול הודעות ברגע ההפעלה.
insert into public.reminders (task_id, kind, send_at)
select id, 'followup', due_at + interval '30 minutes'
from public.tasks
where due_at is not null and status not in ('done', 'dropped') and due_at + interval '30 minutes' > now();

-- ---------- אימות ה-dispatcher ----------
-- הסוד נוצר כאן ונשאר ב-Vault: pg_cron שולח אותו, ה-dispatcher בודק אותו מול ה-DB. הוא לא עובר בשום מקום אחר.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'dispatcher_secret',
  'אימות בין pg_cron ל-Edge Function dispatcher');

create function public.check_dispatcher_secret(candidate text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets where name = 'dispatcher_secret' and decrypted_secret = candidate
  );
$$;
revoke execute on function public.check_dispatcher_secret from public, anon, authenticated;
grant execute on function public.check_dispatcher_secret to service_role;
