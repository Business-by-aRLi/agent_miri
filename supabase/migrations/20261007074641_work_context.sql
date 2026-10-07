-- שלב 1.5: הקשר עבודה מ-Claude Code (רק מעכשיו והלאה — בלי היסטוריה, לבקשת מירי).

-- תיקיות מקומיות של כל פרויקט — כדי לשייך סשן ב-Claude Code לפי ה-cwd שלו
alter table public.projects add column paths text[] not null default '{}';

update public.projects set paths = '{"High-Five-vacations-main"}' where name = 'High Five Vacations';
update public.projects set paths = '{"agent-assist"}' where name = 'agent-assist';
update public.projects set paths = '{"agent_miri"}' where name = 'agent_miri';
update public.projects set paths = '{"arli-proposal-luxury-tours"}' where name = 'aRLi Proposal Portal';
update public.projects set paths = '{"קידוש","kiddush"}' where name = 'Kiddush Hub';

-- cwd → פרויקט: התיקייה הארוכה ביותר שמופיעה כרכיב בנתיב (כדי ש"agent-assist" לא יתפוס "agent-assist-old")
create function public.find_project_by_path(cwd text)
returns uuid
language sql stable
set search_path = public
as $$
  select p.id
  from projects p, unnest(p.paths) path
  where lower(replace(cwd, '\', '/')) ~ ('(^|/)' || regexp_replace(lower(path), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g') || '(/|$)')
  order by length(path) desc
  limit 1;
$$;
revoke execute on function public.find_project_by_path from public, anon, authenticated;

-- סיכום מתגלגל לכל סשן עבודה. מתעדכן כל כמה הודעות ובסוף הסשן.
create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('work_session', 'day', 'week')),
  session_id text unique, -- סשן של Claude Code (רק ל-work_session)
  project_id uuid references public.projects (id) on delete set null,
  cwd text,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  summary text,
  summarized_through timestamptz, -- עד איזה רגע הסיכום מכסה
  pending_entries integer not null default 0, -- הודעות שנקלטו ועוד לא סוכמו
  ended boolean not null default false,
  created_at timestamptz not null default now()
);
create index episodes_project_idx on public.episodes (project_id, last_activity_at desc);
alter table public.episodes enable row level security;

-- סשן שנקלט: מגדיל את מונה ההודעות הממתינות באופן אטומי (כמה hooks יכולים לרוץ במקביל)
create function public.touch_episode(p_session text, p_cwd text, p_project uuid, p_count integer, p_at timestamptz, p_ended boolean)
returns public.episodes
language sql
set search_path = public
as $$
  insert into episodes (kind, session_id, cwd, project_id, started_at, last_activity_at, pending_entries, ended)
  values ('work_session', p_session, p_cwd, p_project, p_at, p_at, p_count, p_ended)
  on conflict (session_id) do update set
    last_activity_at = greatest(episodes.last_activity_at, excluded.last_activity_at),
    pending_entries = episodes.pending_entries + excluded.pending_entries,
    project_id = coalesce(episodes.project_id, excluded.project_id),
    ended = episodes.ended or excluded.ended
  returning *;
$$;
revoke execute on function public.touch_episode from public, anon, authenticated;
