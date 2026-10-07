-- בדיקות למיגרציה stage1_core. רץ בתוך טרנזקציה ומתגלגל אחורה — לא משאיר נתונים.
-- הרצה: להדביק ב-SQL editor או דרך execute_sql. הצלחה = "all ok"; כישלון = exception עם הסבר.
begin;

insert into public.knowledge_chunks (source, source_ref, speaker, content, embedding) values
  ('telegram', 't1', 'miri', 'צריך לשלוח לספק של WigPro את ההזמנה החדשה', array_fill(0.1::real, array[1024])::extensions.vector),
  ('telegram', 't2', 'miri', 'לקבוע תור לרופא שיניים', (array_fill(0.1::real, array[512]) || array_fill(-0.1::real, array[512]))::extensions.vector),
  ('telegram', 't3', 'miri', 'WigPro דשבורד חדש', null); -- עוד בלי embedding: אמור להימצא רק בחיפוש הטקסטואלי

do $t$
declare r record; n int;
begin
  -- recall: הכי רלוונטי ראשון (נמצא גם וקטורית וגם טקסטואלית)
  select * into r from public.recall_chunks(array_fill(0.1::real, array[1024])::extensions.vector, 'WigPro', 5);
  if r.content not like '%ספק%' then raise exception 'recall top wrong: %', r.content; end if;

  -- recall: איחוד — 2 וקטוריים + 1 טקסטואלי-בלבד
  select count(*) into n from public.recall_chunks(array_fill(0.1::real, array[1024])::extensions.vector, 'WigPro', 5);
  if n <> 3 then raise exception 'recall count expected 3, got %', n; end if;

  -- recall בלי embedding (Voyage לא זמין) → טקסטואלי בלבד
  select count(*) into n from public.recall_chunks(null, 'WigPro', 5);
  if n <> 2 then raise exception 'lexical-only expected 2, got %', n; end if;

  -- אילוצים
  begin
    insert into public.tasks (title, category, importance) values ('x', 'work', 5);
    raise exception 'check constraint not enforced';
  exception when check_violation then null; end;

  begin
    insert into public.settings default values;
    raise exception 'settings singleton not enforced';
  exception when unique_violation then null; end;

  -- RLS על כל טבלה
  select count(*) into n from pg_tables where schemaname = 'public' and not rowsecurity;
  if n <> 0 then raise exception '% tables without RLS', n; end if;

  -- recall לא נגיש לאנונימיים
  if has_function_privilege('anon', 'public.recall_chunks(extensions.vector, text, integer, uuid, text)', 'execute') then
    raise exception 'anon can execute recall_chunks';
  end if;
end $t$;

rollback;
select 'all ok' as result;
