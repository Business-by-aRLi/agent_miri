-- ביטול 20261007081043
drop trigger if exists tasks_sync_followups on public.tasks;
drop function if exists public.tasks_sync_followups;
drop function if exists public.claim_due_reminders;
drop function if exists public.check_dispatcher_secret;
delete from vault.secrets where name = 'dispatcher_secret';
drop table if exists public.quiet_windows;
drop table if exists public.reminders;
