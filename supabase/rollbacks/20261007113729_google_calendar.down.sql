-- ביטול 20261007113729 (הטריגר חוזר לגרסה מ-20261007081043 — להריץ את ההגדרה משם)
drop function if exists public.get_google_refresh_token;
drop function if exists public.set_google_refresh_token;
delete from vault.secrets where name = 'google_refresh_token';
drop table if exists public.oauth_states;
alter table public.settings drop column if exists gcal_tasks_calendar_id, drop column if exists gcal_connected_at, drop column if exists gcal_email;
