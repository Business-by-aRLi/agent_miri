-- לחיצה על כפתור מטופלת פעם אחת בלבד.
-- נמצא בבדיקה חיה: לחיצה כפולה על "עוד שעה" (שנייה אחת בהפרש) יצרה שתי תזכורות.
create function public.claim_reminder_action(p_id uuid, p_action text)
returns boolean
language sql
set search_path = public
as $$
  with claimed as (
    update reminders
    set payload = payload || jsonb_build_object('action', p_action, 'action_at', now())
    where id = p_id and not (payload ? 'action')
    returning id
  )
  select exists (select 1 from claimed);
$$;
revoke execute on function public.claim_reminder_action from public, anon, authenticated;

-- הלחיצה הכפולה מהבדיקה החיה: נשארת תזכורת אחת
update reminders set status = 'cancelled' where id = '5597ee2d-58f0-4e11-8852-2380694af003' and status = 'pending';
update reminders set payload = payload || '{"action":"snz1h"}'::jsonb where id = '24c4eb49-34a8-439f-973f-62542595eba9';
