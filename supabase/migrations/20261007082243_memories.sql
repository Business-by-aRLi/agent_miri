-- שלב 2: זיכרון עובדות — מה שהסוכן "יודע" על מירי, מעבר לשיחות הגולמיות.
-- knowledge_chunks = מה נאמר (גולמי). memories = מה נלמד מזה (מזוקק, עם מקור ותוקף).

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('person', 'project', 'preference', 'routine', 'decision', 'fact')),
  subject text not null, -- על מי/מה: "ליאור", "מירי", "High Five"
  content text not null,
  project_id uuid references public.projects (id) on delete set null,
  confidence real not null default 0.8 check (confidence between 0 and 1),
  origin text not null default 'extracted' check (origin in ('extracted', 'explicit')), -- explicit = "תזכור ש..."
  source_chunk_ids uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'superseded', 'forgotten')),
  superseded_by uuid references public.memories (id),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  last_confirmed_at timestamptz not null default now(),
  embedding extensions.vector(1024),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memories_active_idx on public.memories (kind, subject) where status = 'active';
create index memories_embedding_idx on public.memories using hnsw (embedding extensions.vector_cosine_ops);
create index memories_trgm_idx on public.memories using gin ((subject || ' ' || content) extensions.gin_trgm_ops);
alter table public.memories enable row level security;

-- מצב עבודות רקע (חילוץ שעתי, איחוד לילי): עד איפה עובדנו
create table public.job_state (
  name text primary key,
  cursor_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb
);
alter table public.job_state enable row level security;
-- החילוץ מתחיל יממה אחורה — כך השיחות של היום הראשון (ליאור, עקיבא, הפרויקטים) נכנסות כבר בריצה הראשונה
insert into public.job_state (name, cursor_at) values ('extract_memories', now() - interval '1 day'), ('consolidate_memories', null);

-- שליפת עובדות רלוונטיות: אותו מנגנון היברידי כמו recall_chunks (וקטור + טקסט, איחוד RRF)
create function public.recall_memories(
  query_embedding extensions.vector(1024),
  query_text text,
  match_count integer default 10
)
returns table (id uuid, kind text, subject text, content text, project_id uuid, confidence real, score double precision)
language sql stable
set search_path = public, extensions
as $$
  with semantic as (
    select m.id, row_number() over (order by m.embedding <=> query_embedding) as rank
    from memories m
    where query_embedding is not null and m.embedding is not null and m.status = 'active'
    order by m.embedding <=> query_embedding
    limit match_count * 3
  ),
  lexical as (
    select m.id, row_number() over (order by word_similarity(query_text, m.subject || ' ' || m.content) desc) as rank
    from memories m
    where m.status = 'active' and query_text <% (m.subject || ' ' || m.content)
    order by word_similarity(query_text, m.subject || ' ' || m.content) desc
    limit match_count * 3
  ),
  fused as (
    select coalesce(s.id, l.id) as id,
           coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + l.rank), 0) as score
    from semantic s full outer join lexical l on l.id = s.id
  )
  select m.id, m.kind, m.subject, m.content, m.project_id, m.confidence, f.score
  from fused f join memories m on m.id = f.id
  order by f.score desc
  limit match_count;
$$;
revoke execute on function public.recall_memories from public, anon, authenticated;
