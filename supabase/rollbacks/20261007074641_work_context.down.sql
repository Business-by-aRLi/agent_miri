-- ביטול 20261007074641
drop function if exists public.touch_episode;
drop table if exists public.episodes;
drop function if exists public.find_project_by_path;
alter table public.projects drop column if exists paths;
