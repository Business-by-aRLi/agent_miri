-- recall_chunks: query_embedding יכול להיות null → חיפוש טקסטואלי בלבד.
-- למה: אם Voyage לא זמין, הסוכן עדיין צריך לזכור שמות ומונחים מדויקים, במקום לשבור את כל השיחה.
create or replace function public.recall_chunks(
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
    where query_embedding is not null
      and c.embedding is not null
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

revoke execute on function public.recall_chunks from public, anon, authenticated;
