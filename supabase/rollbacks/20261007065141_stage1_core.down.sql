-- ביטול מיגרציה 20261007065141_stage1_core. הרסני — מוחק את כל נתוני שלב 1.
drop function if exists public.recall_chunks;
drop table if exists public.settings;
alter table if exists public.messages drop constraint if exists messages_run_fk;
drop table if exists public.runs;
drop table if exists public.core_profile;
drop table if exists public.knowledge_chunks;
drop table if exists public.telegram_updates;
drop table if exists public.messages;
drop table if exists public.tasks;
drop table if exists public.projects;
-- התוספים (vector, pg_trgm) נשארים: ייתכן ששימושיים לאחרים, והסרתם לא נדרשת לחזרה למצב קודם
