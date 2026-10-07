-- כינויים לפרויקטים: מירי כותבת "high five", "הייפייב", "מגדלור" — לא את השם הרשמי.
alter table public.projects add column aliases text[] not null default '{}';

-- התאמת שם/כינוי לפרויקט. קודם התאמה מדויקת (בלי רישיות), אחר כך הכלה.
-- למה בפונקציה: PostgREST לא יודע לעשות ilike על איברי מערך.
create function public.find_project(q text)
returns table (id uuid, name text)
language sql stable
set search_path = public
as $$
  select p.id, p.name
  from projects p
  where lower(p.name) = lower(q)
     or exists (select 1 from unnest(p.aliases) a where lower(a) = lower(q))
     or lower(p.name) like '%' || lower(q) || '%'
     or exists (select 1 from unnest(p.aliases) a where lower(a) like '%' || lower(q) || '%')
  order by (lower(p.name) = lower(q) or exists (select 1 from unnest(p.aliases) a where lower(a) = lower(q))) desc,
           length(p.name)
  limit 3;
$$;
revoke execute on function public.find_project from public, anon, authenticated;

-- זריעה ראשונית: הפרויקטים לפי פרויקטי ה-Supabase של מירי. ייעשה עשיר יותר בשלב 1.5 (backfill מ-Claude Code).
insert into public.projects (name, aliases, supabase_ref) values
  ('High Five Vacations', '{"high five","highfive","הייפייב","היי פייב"}', 'eafgrcdhjqqohvstbbug'),
  ('aRLi Finance', '{"arli finance","פיננסים","פיננסי"}', 'iubjvnjlbpgjfshxxxrl'),
  ('agent-assist', '{"מוקד מנויים","agent assist"}', 'xffcsehyhrrdleybviny'),
  ('WigPro', '{"wigpro","ויגפרו","פאות"}', 'zsdfecdsqmusrnykkeme'),
  ('Migdalor', '{"מגדל אור","מגדלור","migdal or"}', 'wphtinxfspycdlbcdgqu'),
  ('Kiddush Hub', '{"kiddush","קידוש","Kiddus Times"}', 'gptehpjuqtmnwazkgnor'),
  ('Goldiz', '{"goldi''z","גולדיז"}', 'zjdflsqvtdbqasfrhobe'),
  ('Kids.Mags', '{"kids mags","קידס מגס"}', 'qbpbgrnygpjaccymrhpn'),
  ('Eretz Hatikva', '{"eretz-hatikva","ארץ התקווה"}', 'fdwojzhmyrfthwichabm'),
  ('Musagim', '{"מושגים"}', 'pduwpflzokiohbodknnl'),
  ('Zev Weiss', '{"zev_weiss","זאב וייס"}', 'pwuflpfuvmgqmvqqvqpk'),
  ('aRLi Website', '{"אתר arli","אתר ארלי"}', 'iduzvbuzdgimvgwcqstm'),
  ('Business by aRLi', '{"business by arli","ארלי","aRLi"}', 'rhhmrexyvgwqccjmmjfo'),
  ('agent_miri', '{"הסוכן","הסוכן האישי","agent miri"}', 'nklintfbsfagcwlbfwob');

-- המשימה שכבר נקלטה עם "high five" ב-notes — לשייך
update public.tasks set project_id = (select id from public.projects where name = 'High Five Vacations')
where title ilike '%high five%' and project_id is null;
