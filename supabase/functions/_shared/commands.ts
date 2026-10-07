// פקודות טלגרם — קוד בלבד, בלי LLM. מהיר, חינמי וצפוי.
import { CalendarNotConnected, listEvents } from "./calendar.ts";
import { db } from "./db.ts";
import { byPriority } from "./priority.ts";
import { formatLocalIso, localDayRange, timeContext } from "./time.ts";

interface Row {
  id: string;
  title: string;
  category: string;
  status: string;
  importance: number;
  urgency: number;
  due_at: string | null;
  snooze_count: number;
  projects: { name: string } | null;
}

/** /calendar — קישור חד-פעמי (15 דק') לחיבור Google Calendar. */
export async function calendarConnectText(): Promise<string> {
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const { error } = await db().from("oauth_states").insert({
    state,
    provider: "google",
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  if (error) throw error;
  const { data: s } = await db().from("settings").select("gcal_connected_at, gcal_email").single();
  const url = `https://nklintfbsfagcwlbfwob.supabase.co/functions/v1/google-oauth/start?state=${state}`;
  return [
    s?.gcal_connected_at ? `📅 היומן כבר מחובר (${s.gcal_email ?? ""}). הקישור הזה יחבר מחדש:` : "📅 חיבור ליומן Google:",
    url,
    "",
    "מה אבקש מ-Google:",
    "• ליצור יומן חדש בשם \"משימות\" ולנהל רק אותו",
    "• לראות את האירועים ביומנים האחרים (כדי לדעת מתי את תפוסה)",
    "לא אוכל לשנות או למחוק שום דבר ביומנים הקיימים שלך.",
    "",
    "הקישור תקף ל-15 דקות ולשימוש אחד.",
  ].join("\n");
}

const hhmm = (iso: string) => formatLocalIso(new Date(iso)).slice(11);
const dayMonth = (iso: string) => {
  const [, m, d] = formatLocalIso(new Date(iso)).slice(0, 10).split("-");
  return `${Number(d)}.${Number(m)}`;
};

function line(t: Row, showDate: boolean): string {
  const tag = t.projects?.name ?? (t.category === "work" ? "עבודה" : "אישי");
  const when = t.due_at ? (showDate ? `${dayMonth(t.due_at)} ${hhmm(t.due_at)}` : hhmm(t.due_at)) : "";
  return `• ${when ? when + " " : ""}${t.title} (${tag})`;
}

export async function todayText(now = new Date()): Promise<string> {
  const { start, end } = localDayRange(now);
  const { data, error } = await db()
    .from("tasks")
    .select("id, title, category, status, importance, urgency, due_at, snooze_count, projects(name)")
    .not("status", "in", "(done,dropped)")
    .order("due_at", { ascending: true, nullsFirst: false });
  if (error) throw error;
  const tasks = (data ?? []) as unknown as Row[];

  const overdue = tasks.filter((t) => t.due_at && new Date(t.due_at) < start);
  const today = tasks.filter((t) => t.due_at && new Date(t.due_at) >= start && new Date(t.due_at) < end);
  // בלי מועד: לפי ציון העדיפות (חשיבות, דחיפות, דחיות)
  const undated = byPriority(tasks.filter((t) => !t.due_at).map((t) => ({ ...t, snooze_count: t.snooze_count ?? 0 })), now);
  const doneToday = await db().from("tasks").select("id", { count: "exact", head: true })
    .eq("status", "done").gte("completed_at", start.toISOString());

  // היומן: פגישות של היום (אם מחובר). שגיאה ביומן לא מפילה את /today.
  let agenda: string[] = [];
  try {
    const events = await listEvents(start, end);
    agenda = events.filter((e) => !e.allDay).map((e) =>
      `• ${hhmm(e.start.toISOString())}–${hhmm(e.end.toISOString())} ${e.summary}${e.calendarName === "משימות" ? " 🗂" : ""}`
    );
  } catch (e) {
    if (!(e instanceof CalendarNotConnected)) console.error("today agenda failed", e);
  }

  const t = timeContext(now);
  const out: string[] = [`📅 יום ${t.weekdayHe}, ${t.gregorianHe} · ${t.hebrewDate}`];
  if (agenda.length) out.push("", `🗓 ביומן (${agenda.length})`, ...agenda);
  if (overdue.length) out.push("", `⚠️ באיחור (${overdue.length})`, ...overdue.map((x) => line(x, true)));
  out.push("", `היום (${today.length})`, ...(today.length ? today.map((x) => line(x, false)) : ["• אין משימות עם מועד להיום"]));
  if (undated.length) {
    out.push("", `בלי מועד — החשובות (${Math.min(5, undated.length)} מתוך ${undated.length})`);
    out.push(...undated.slice(0, 5).map((x) => line(x, false)));
  }
  if (doneToday.count) out.push("", `✅ בוצעו היום: ${doneToday.count}`);
  return out.join("\n");
}

const KIND_LABEL: Record<string, string> = {
  person: "👤 אנשים",
  project: "📁 פרויקטים",
  preference: "💡 העדפות",
  routine: "🔁 הרגלים",
  decision: "✅ החלטות",
  fact: "📌 עוד דברים",
};

/** /memory — כל מה שהסוכן יודע, מקובץ לפי סוג. שקיפות מלאה. */
export async function memoryText(): Promise<string> {
  const { data, error } = await db().from("memories").select("kind, subject, content, origin")
    .eq("status", "active").order("subject");
  if (error) throw error;
  if (!data?.length) return "🧠 עוד לא למדתי עובדות קבועות. זה יתמלא מהשיחות שלנו (פעם בשעה), או כשתגידי לי \"תזכור ש...\".";
  const out = [`🧠 מה שאני יודע (${data.length})`];
  for (const [kind, label] of Object.entries(KIND_LABEL)) {
    const items = data.filter((m) => m.kind === kind);
    if (!items.length) continue;
    out.push("", label);
    for (const m of items) out.push(`• ${m.subject}: ${m.content}${m.origin === "explicit" ? " 📍" : ""}`);
  }
  out.push("", "📍 = ביקשת שאזכור. משהו לא נכון? פשוט תגידי \"תשכח ש...\" או תתקני אותי.");
  return out.join("\n");
}

export const HELP_TEXT = `אני הסוכן שלך. פשוט לכתוב לי — משימה, רעיון, שאלה — בכל שעה.

פקודות:
/today — מה על הפרק היום (כולל היומן)
/calendar — חיבור ליומן Google
/memory — מה אני יודע עלייך
/help — ההודעה הזו

אפשר גם: "תזכיר לי מחר ב-10...", "תזכור ש...", "מה סיכמתי עם ליאור?", "עד מתי הספרייה פתוחה?".
אחרי חיבור היומן: "תשבץ לי את X", "מה יש לי מחר?".
בקרוב: ביצוע עבודה בפועל.`;
