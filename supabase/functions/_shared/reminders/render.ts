// תזכורות: ניסוח, כפתורים וחישובי דחייה — פונקציות טהורות (נבדקות), בלי DB ובלי רשת.
import type { Keyboard } from "../channels/telegram.ts";
import { formatLocalIso, localToUtc, toLocalParts } from "../time.ts";

export type ReminderKind = "reminder" | "followup" | "followup_evening" | "nudge" | "question";
export type Action = "done" | "snz1h" | "snzTom" | "snzWeek" | "drop" | "ack" | "resched";

export interface DueReminder {
  id: string;
  kind: ReminderKind;
  text: string | null;
  task: {
    id: string;
    title: string;
    category: "personal" | "work";
    due_at: string | null;
    snooze_count: number;
    project: string | null;
  } | null;
}

/** משימה שנדחתה 3 פעמים — במקום עוד "נו?" שואלים ישירות מה עושים איתה. */
export const STUCK_AFTER_SNOOZES = 3;

const btn = (text: string, action: Action, id: string) => ({ text, callback_data: `${action}:${id}` });

/** callback_data → פעולה + מזהה תזכורת. null = לא שלנו / פגום. */
export function parseCallback(data: string | undefined): { action: Action; reminderId: string } | null {
  const m = data?.match(/^(done|snz1h|snzTom|snzWeek|drop|ack|resched):([0-9a-f-]{36})$/);
  return m ? { action: m[1] as Action, reminderId: m[2] } : null;
}

/** כפתור בחירת חור: "slot:<task>:<דקות מאז 1970>" — 51 בתים, בתוך מגבלת 64. */
export function slotCallback(taskId: string, start: Date): string {
  return `slot:${taskId}:${Math.round(start.getTime() / 60_000)}`;
}

export function parseSlotCallback(data: string | undefined): { taskId: string; start: Date } | null {
  const m = data?.match(/^slot:([0-9a-f-]{36}):(\d{8})$/);
  return m ? { taskId: m[1], start: new Date(Number(m[2]) * 60_000) } : null;
}

const hhmm = (iso: string) => formatLocalIso(new Date(iso)).slice(11);
const dueLabel = (iso: string, now: Date) => {
  const due = formatLocalIso(new Date(iso));
  return due.slice(0, 10) === formatLocalIso(now).slice(0, 10)
    ? `ב-${due.slice(11)}`
    : `ב-${Number(due.slice(8, 10))}.${Number(due.slice(5, 7))} ${due.slice(11)}`;
};

/** הודעה + כפתורים לתזכורת בודדת. */
export function renderOne(r: DueReminder, now: Date, opts: { calendar?: boolean } = {}): { text: string; keyboard: Keyboard } {
  const t = r.task;
  const tag = t?.project ? ` (${t.project})` : "";

  if (r.kind === "reminder") {
    if (!t) {
      return { text: `⏰ ${r.text ?? "תזכורת"}`, keyboard: [[btn("👍 תודה", "ack", r.id), btn("⏰ עוד שעה", "snz1h", r.id)]] };
    }
    return {
      text: `⏰ תזכורת: ${t.title}${tag}${r.text ? `\n${r.text}` : ""}`,
      keyboard: [[btn("✅ בוצע", "done", r.id), btn("⏰ עוד שעה", "snz1h", r.id), btn("📅 מחר", "snzTom", r.id)]],
    };
  }

  if (!t) return { text: r.text ?? "", keyboard: [] }; // nudge / question חופשיים

  if (t.snooze_count >= STUCK_AFTER_SNOOZES) {
    return {
      text: `🤔 "${t.title}"${tag} נדחתה כבר ${t.snooze_count} פעמים.\n` +
        "אולי היא גדולה מדי? אפשר לפרק לצעד ראשון קטן, להעביר למישהו, או פשוט לוותר. מה עושים?",
      keyboard: [[btn("🗑 לוותר", "drop", r.id), btn("📅 מחר", "snzTom", r.id), btn("🗓 שבוע הבא", "snzWeek", r.id)]],
    };
  }

  const text = r.kind === "followup_evening"
    ? `🌙 עוד פתוח מהיום: ${t.title}${tag}. סוגרים או מזיזים?`
    : `🔔 ${t.title}${tag}${t.due_at ? ` — היה אמור להיות ${dueLabel(t.due_at, now)}` : ""}. איך זה הלך?`;
  const keyboard: Keyboard = [
    [btn("✅ בוצע", "done", r.id), btn("⏰ עוד שעה", "snz1h", r.id)],
    [btn("📅 מחר", "snzTom", r.id), btn("🗓 שבוע הבא", "snzWeek", r.id)],
  ];
  // יומן מחובר → אפשר לבחור חור פנוי במקום "מחר" עיוור
  if (opts.calendar) keyboard.push([btn("🗓 לשבץ ביומן", "resched", r.id)]);
  return { text, keyboard };
}

/**
 * כמה תזכורות שיצאו יחד (למשל במוצאי שבת) → הודעה אחת ממוספרת, שורת כפתורים לכל אחת.
 * למה עד 2 בנפרד: שתי הודעות זה עדיין נוח; מ-3 ומעלה זה מבול.
 */
export function renderBatch(items: DueReminder[], now: Date): { text: string; keyboard: Keyboard } {
  const lines = ["📬 כמה דברים שחיכו:"];
  const keyboard: Keyboard = [];
  items.forEach((r, i) => {
    const n = i + 1;
    const title = r.task?.title ?? r.text ?? "תזכורת";
    const due = r.task?.due_at ? ` (${dueLabel(r.task.due_at, now)})` : "";
    lines.push(`${n}. ${title}${due}`);
    keyboard.push(
      r.task
        ? [btn(`✅ ${n}`, "done", r.id), btn(`⏰ ${n} שעה`, "snz1h", r.id), btn(`📅 ${n} מחר`, "snzTom", r.id)]
        : [btn(`👍 ${n}`, "ack", r.id), btn(`⏰ ${n} שעה`, "snz1h", r.id)],
    );
  });
  return { text: lines.join("\n"), keyboard };
}

/** לאן דוחים. מחר/שבוע הבא: 09:00 לעבודה, 18:00 לאישי (כמו בפרומפט). */
export function snoozeTarget(action: "snz1h" | "snzTom" | "snzWeek", now: Date, category: "personal" | "work"): Date {
  if (action === "snz1h") return new Date(now.getTime() + 3600_000);
  const hour = category === "work" ? "09:00" : "18:00";
  const l = toLocalParts(now);
  // שבוע הבא = יום ראשון הבא (גם אם היום ראשון — שבוע מהיום)
  const days = action === "snzTom" ? 1 : (7 - l.weekday) || 7;
  const noon = localToUtc(`${formatLocalIso(now).slice(0, 10)}T12:00`);
  const target = formatLocalIso(new Date(noon.getTime() + days * 24 * 3600_000)).slice(0, 10);
  return localToUtc(`${target}T${hour}`);
}

/** מעקב ערב: אחד בלבד, ב-20:00 של אותו יום — ורק אם יש עוד זמן עד אז. */
export function eveningFollowupAt(now: Date): Date | null {
  const evening = localToUtc(`${formatLocalIso(now).slice(0, 10)}T20:00`);
  return evening.getTime() - now.getTime() >= 30 * 60_000 ? evening : null;
}

/** השורה שמחליפה את הכפתורים אחרי לחיצה. */
export function actionLabel(action: Action, target?: Date): string {
  switch (action) {
    case "done":
      return "✅ בוצע";
    case "drop":
      return "🗑 ירד מהרשימה";
    case "ack":
      return "👍";
    case "resched":
      return "🗓 בוחרים זמן";
    default:
      return `⏰ נדחה ל-${target ? hhmmDay(target) : ""}`;
  }
}

function hhmmDay(d: Date): string {
  const l = formatLocalIso(d);
  return `${Number(l.slice(8, 10))}.${Number(l.slice(5, 7))} ${l.slice(11)}`;
}

export { hhmm };
