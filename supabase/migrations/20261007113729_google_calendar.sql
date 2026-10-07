-- שלב 3: חיבור ל-Google Calendar.

alter table public.settings
  add column gcal_tasks_calendar_id text, -- היומן "משימות" שהסוכן יצר (calendar.app.created)
  add column gcal_connected_at timestamptz,
  add column gcal_email text;

-- state חד-פעמי ל-OAuth: נוצר רק מפקודה של מירי בטלגרם, תקף 15 דקות. מגן מ-CSRF ומחיבור של חשבון זר.
create table public.oauth_states (
  state text primary key,
  provider text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table public.oauth_states enable row level security;

-- ה-refresh token נשמר רק ב-Vault. גישה דרך שתי פונקציות שרק service_role יכול להריץ.
create function public.set_google_refresh_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare existing uuid;
begin
  select id into existing from vault.secrets where name = 'google_refresh_token';
  if existing is null then
    perform vault.create_secret(p_token, 'google_refresh_token', 'Google Calendar OAuth refresh token');
  else
    perform vault.update_secret(existing, p_token);
  end if;
end;
$$;
revoke execute on function public.set_google_refresh_token from public, anon, authenticated;
grant execute on function public.set_google_refresh_token to service_role;

create function public.get_google_refresh_token()
returns text
language sql
security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'google_refresh_token';
$$;
revoke execute on function public.get_google_refresh_token from public, anon, authenticated;
grant execute on function public.get_google_refresh_token to service_role;

-- מעקב אחרי שיבוץ: אם המשימה משובצת — מעקב רבע שעה אחרי סוף החלון ביומן (עם הצעת חורים חדשים בכפתור).
-- אחרת — חצי שעה אחרי המועד, כמו קודם.
create or replace function public.tasks_sync_followups()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_at timestamptz;
begin
  if new.status in ('done', 'dropped') then
    update reminders set status = 'cancelled'
    where task_id = new.id and status = 'pending';
    return new;
  end if;

  if tg_op = 'INSERT' or new.due_at is distinct from old.due_at or new.scheduled_end is distinct from old.scheduled_end then
    update reminders set status = 'cancelled'
    where task_id = new.id and status = 'pending' and kind in ('followup', 'followup_evening');
    v_at := coalesce(new.scheduled_end + interval '15 minutes', new.due_at + interval '30 minutes');
    if v_at is not null then
      insert into reminders (task_id, kind, send_at) values (new.id, 'followup', v_at);
    end if;
  end if;
  return new;
end;
$$;

drop trigger tasks_sync_followups on public.tasks;
create trigger tasks_sync_followups
after insert or update of due_at, scheduled_end, status on public.tasks
for each row execute function public.tasks_sync_followups();
