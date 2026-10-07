-- שלב 1: קליטה + יסודות זיכרון.
-- RLS מופעל בכל טבלה בלי policies (deny-by-default) — גישה רק דרך Edge Functions עם service role.
-- ערכים מוגבלים ב-check ולא ב-enum: קל יותר להוסיף ערך במיגרציה עתידית.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------- פרויקטים ----------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  client text,
  repo text,
  supabase_ref text,
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'archived')),
  dossier jsonb not null default '{}',
  dossier_updated_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- משימות ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  category text not null check (category in ('personal', 'work')),
  project_id uuid references public.projects (id) on delete set null,
  status text not null default 'inbox'
    check (status in ('inbox', 'scheduled', 'done', 'snoozed', 'dropped')),
  importance smallint not null default 2 check (importance between 1 and 3),
  urgency smallint not null default 2 check (urgency between 1 and 3),
  due_at timestamptz,
  estimated_minutes integer check (estimated_minutes > 0),
  estimate_is_guess boolean not null default true,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  gcal_event_id text,
  snooze_count integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (scheduled_end is null or scheduled_end > scheduled_start)
);
create index tasks_open_idx on public.tasks (status, due_at) where status not in ('done', 'dropped');

-- ---------- שיחה ----------
-- messages = התמליל כפי שנשלח ל-API (בלוקי content כולל tool_use) — לחלון ההקשר הקצר.
create table public.messages (
  id bigint generated always as identity primary key,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  run_id uuid,
  created_at timestamptz not null default now()
);
create index messages_created_idx on public.messages (created_at desc);

-- dedupe: טלגרם שולח שוב עדכון שלא קיבל עליו 200 בזמן
create table public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

-- ---------- זיכרון: יחידות טקסט לחיפוש ----------
-- נפרד מ-messages: כאן רק טקסט נקי (אחרי redact) עם embedding, מכל המקורות.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('telegram', 'claude_code', 'claude_ai', 'document')),
  source_ref text, -- מזהה במקור (message id, session id + offset, שם קובץ)
  speaker text check (speaker in ('miri', 'agent', 'claude', 'other')),
  project_id uuid references public.projects (id) on delete set null,
  content text not null,
  embedding extensions.vector(1024), -- voyage-3.5; null עד שה-embedding מחושב
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source, source_ref)
);
create index knowledge_chunks_embedding_idx on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);
create index knowledge_chunks_trgm_idx on public.knowledge_chunks
  using gin (content extensions.gin_trgm_ops);
create index knowledge_chunks_occurred_idx on public.knowledge_chunks (occurred_at desc);
create index knowledge_chunks_pending_embedding_idx on public.knowledge_chunks (created_at)
  where embedding is null;

-- פרופיל ליבה: נכנס לכל קריאה. שינוי = גרסה חדשה (היסטוריה נשמרת).
create table public.core_profile (
  version integer primary key generated always as identity,
  content text not null,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- תצפית ----------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  layer text not null check (layer in ('concierge', 'executor', 'background')),
  trigger text not null, -- telegram | command | dispatcher | ingest ...
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  tool_calls jsonb not null default '[]',
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index runs_created_idx on public.runs (created_at desc);
alter table public.messages
  add constraint messages_run_fk foreign key (run_id) references public.runs (id) on delete set null;

-- ---------- הגדרות (שורה יחידה) ----------
create table public.settings (
  id boolean primary key default true check (id),
  timezone text not null default 'Asia/Jerusalem',
  work_hours jsonb not null default '{"start": "09:00", "end": "15:00"}',
  talk_hours jsonb not null default '{"start": "08:00", "end": "22:00"}',
  brief_time time,
  daily_budget_usd numeric(8, 2),
  max_unsolicited_per_day integer not null default 6,
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.settings default values;

-- ---------- RLS: הכול סגור ----------
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.core_profile enable row level security;
alter table public.runs enable row level security;
alter table public.settings enable row level security;

-- ---------- recall: חיפוש היברידי ----------
-- למה היברידי: וקטור תופס משמעות ("ספק" ≈ "מי שמביא את הסחורה"), טריגרם תופס שמות ומונחים מדויקים
-- (שמות לקוחות, "WigPro"). איחוד ב-Reciprocal Rank Fusion — לא צריך לכייל ציונים בין שתי השיטות.
create function public.recall_chunks(
  query_embedding extensions.vector(1024),
  query_text text,
  match_count integer default 10,
  filter_project uuid default null,
  filter_source text default null
)
returns table (
  id uuid,
  source text,
  speaker text,
  project_id uuid,
  content text,
  occurred_at timestamptz,
  score double precision
)
language sql stable
set search_path = public, extensions
as $$
  with semantic as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from knowledge_chunks c
    where c.embedding is not null
      and (filter_project is null or c.project_id = filter_project)
      and (filter_source is null or c.source = filter_source)
    order by c.embedding <=> query_embedding
    limit match_count * 4
  ),
  lexical as (
    select c.id, row_number() over (order by word_similarity(query_text, c.content) desc) as rank
    from knowledge_chunks c
    where query_text <% c.content
      and (filter_project is null or c.project_id = filter_project)
      and (filter_source is null or c.source = filter_source)
    order by word_similarity(query_text, c.content) desc
    limit match_count * 4
  ),
  fused as (
    select coalesce(s.id, l.id) as id,
           coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + l.rank), 0) as score
    from semantic s
    full outer join lexical l on l.id = s.id
  )
  select c.id, c.source, c.speaker, c.project_id, c.content, c.occurred_at, f.score
  from fused f
  join knowledge_chunks c on c.id = f.id
  order by f.score desc
  limit match_count;
$$;

-- הפונקציה נגישה רק ל-service role (ה-Edge Functions), לא דרך PostgREST לאנונימיים
revoke execute on function public.recall_chunks from public, anon, authenticated;
