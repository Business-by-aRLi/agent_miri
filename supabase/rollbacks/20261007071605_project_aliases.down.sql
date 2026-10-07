-- ביטול 20261007071605
drop function if exists public.find_project;
delete from public.projects; -- הזריעה בלבד; tasks.project_id מתאפס (on delete set null)
alter table public.projects drop column if exists aliases;
