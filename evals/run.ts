// מריץ את ה-golden set של ה-Concierge מול המודל האמיתי, עם כלים מדומים (בלי כתיבה ל-DB).
// הרצה: deno task eval            (כל המקרים)
//        deno task eval multi      (רק מקרים שה-id שלהם מכיל "multi")
// עלות: ~1.5 סנט למקרה. יוצא בקוד 1 אם משהו נכשל — כדי שאפשר יהיה לחסום פריסה.
import { type ContextInput } from "../supabase/functions/_shared/concierge/prompt.ts";
import { runConcierge, type ToolRunner } from "../supabase/functions/_shared/concierge/agent.ts";
import { localToUtc, timeContext } from "../supabase/functions/_shared/time.ts";

interface Project {
  name: string;
  aliases: string[];
}
interface ExpectedCall {
  tool: string;
  match?: Record<string, unknown>;
  title_includes?: string;
  notes_includes?: string;
}
interface Case {
  id: string;
  message: string;
  now?: string;
  expect: { calls?: ExpectedCall[]; count?: Record<string, number>; forbid?: string[] };
}
interface Suite {
  defaults: { now: string; projects: Project[]; openTasks: ContextInput["openTasks"] };
  cases: Case[];
}

const suite: Suite = JSON.parse(await Deno.readTextFile(new URL("./concierge/cases.json", import.meta.url)));
const filter = Deno.args[0];
const cases = suite.cases.filter((c) => !filter || c.id.includes(filter));

/** אותה לוגיקה כמו find_project ב-DB: מדויק קודם, אחר כך הכלה. */
function resolveProject(q: unknown): string | null | undefined {
  if (q === null || q === undefined || q === "") return null;
  const s = String(q).toLowerCase();
  const all = suite.defaults.projects;
  const exact = all.find((p) => p.name.toLowerCase() === s || p.aliases.some((a) => a.toLowerCase() === s));
  if (exact) return exact.name;
  const partial = all.find((p) => p.name.toLowerCase().includes(s) || p.aliases.some((a) => a.toLowerCase().includes(s)));
  return partial?.name; // undefined = לא נמצא
}

/** כלים מדומים: מחזירים תשובות סבירות, לא נוגעים בשום דבר. */
function mockTools(): ToolRunner {
  const ids = new Set(suite.defaults.openTasks.map((t) => t.id));
  return (name, input) => {
    const ok = (o: unknown) => Promise.resolve({ content: JSON.stringify({ ok: true, ...o as object }), isError: false });
    const err = (m: string) => Promise.resolve({ content: JSON.stringify({ error: m }), isError: true });
    if ("project" in input && input.project && resolveProject(input.project) === undefined) {
      return err(`פרויקט "${input.project}" לא קיים. להשתמש ב-null ולרשום את השם ב-notes.`);
    }
    switch (name) {
      case "create_task":
        return ok({ task: { id: crypto.randomUUID(), ...input, status: "inbox" } });
      case "update_task":
      case "complete_task":
        return ids.has(String(input.task_id)) ? ok({ task: { id: input.task_id, ...input } }) : err("משימה לא נמצאה");
      case "list_tasks":
        return ok({ tasks: suite.defaults.openTasks });
      case "recall":
        return ok({ results: [] });
      case "add_project_note":
        return ok({ saved_to: input.kind });
      case "get_project_dossier":
        return ok({
          project: { name: resolveProject(input.project) },
          dossier: { facts: ["מערכת לניהול זמני קידוש"], open_items: ["תיקונים באקסל"] },
          recent_sessions: [],
        });
      default:
        return err(`כלי לא מוכר: ${name}`);
    }
  };
}

function callMatches(exp: ExpectedCall, actual: { name: string; input: unknown }): boolean {
  if (exp.tool !== actual.name) return false;
  const input = actual.input as Record<string, unknown>;
  if (exp.title_includes && !String(input.title ?? "").includes(exp.title_includes)) return false;
  if (exp.notes_includes && !String(input.notes ?? "").includes(exp.notes_includes)) return false;
  for (const [key, want] of Object.entries(exp.match ?? {})) {
    if (key.endsWith("_prefix")) {
      const field = key.slice(0, -"_prefix".length);
      if (typeof input[field] !== "string" || !(input[field] as string).startsWith(String(want))) return false;
    } else if (key === "project") {
      if (resolveProject(input.project) !== want) return false;
    } else if (key === "estimate_is_guess" && want === false) {
      if (input.estimate_is_guess !== false) return false;
    } else if (input[key] !== want) return false;
  }
  return true;
}

function grade(c: Case, calls: Array<{ name: string; input: unknown }>): string[] {
  const failures: string[] = [];
  for (const [tool, n] of Object.entries(c.expect.count ?? {})) {
    const got = calls.filter((x) => x.name === tool).length;
    if (got !== n) failures.push(`${tool}: צפוי ${n}, בפועל ${got}`);
  }
  for (const tool of c.expect.forbid ?? []) {
    if (calls.some((x) => x.name === tool)) failures.push(`נקרא ${tool} למרות שאסור`);
  }
  // התאמה חד-חד-ערכית: כל קריאה בפועל יכולה לספק ציפייה אחת בלבד
  const used = new Set<number>();
  for (const exp of c.expect.calls ?? []) {
    const idx = calls.findIndex((a, i) => !used.has(i) && callMatches(exp, a));
    if (idx === -1) failures.push(`חסרה קריאה: ${JSON.stringify(exp)}`);
    else used.add(idx);
  }
  return failures;
}

async function runCase(c: Case) {
  const now = localToUtc(c.now ?? suite.defaults.now);
  const context: ContextInput = {
    time: timeContext(now),
    profile: null,
    projects: suite.defaults.projects.map((p) => `${p.name} (${p.aliases.join(", ")})`),
    openTasks: suite.defaults.openTasks,
    memories: [],
    recent: [],
  };
  try {
    const r = await runConcierge(c.message, {
      now,
      trigger: "eval",
      contextOverride: context,
      toolRunner: mockTools(),
      persist: false,
    });
    return { c, failures: grade(c, r.toolCalls), calls: r.toolCalls, reply: r.reply, cost: r.costUsd };
  } catch (e) {
    return { c, failures: [`exception: ${e instanceof Error ? e.message : e}`], calls: [], reply: "", cost: 0 };
  }
}

// 4 במקביל — מהיר, בלי להיתקע ב-rate limit
const results: Awaited<ReturnType<typeof runCase>>[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map(runCase)));

let cost = 0;
for (const r of results) {
  cost += r.cost;
  const ok = r.failures.length === 0;
  console.log(`${ok ? "✅" : "❌"} ${r.c.id}`);
  if (!ok || Deno.env.get("VERBOSE")) {
    for (const f of r.failures) console.log(`   • ${f}`);
    console.log(`   calls: ${JSON.stringify(r.calls)}`);
    console.log(`   reply: ${r.reply.replaceAll("\n", " / ")}`);
  }
}
const passed = results.filter((r) => r.failures.length === 0).length;
console.log(`\n${passed}/${results.length} עברו · עלות $${cost.toFixed(4)}`);
if (passed < results.length) Deno.exit(1);
