// שליחת תזכורות וטיפול בלחיצות על כפתורים. כל ההחלטות בקוד — בלי LLM.
import { answerCallback, editMessage, miriChatId, sendWithKeyboard, type TgUpdate } from "../channels/telegram.ts";
import { db } from "../db.ts";
import { loadQuietWindows } from "../hebcal.ts";
import { nextSendTime } from "../time.ts";
import {
  type Action,
  actionLabel,
  type DueReminder,
  eveningFollowupAt,
  parseCallback,
  type ReminderKind,
  renderBatch,
  renderOne,
  snoozeTarget,
} from "./render.ts";

const MAX_ATTEMPTS = 5;
// הודעות שהסוכן יוזם — רק בשעות שיחה. תזכורת שמירי ביקשה יוצאת בזמן שביקשה.
const UNSOLICITED: ReminderKind[] = ["followup", "followup_evening", "nudge", "question"];

interface ReminderRow {
  id: string;
  task_id: string | null;
  kind: ReminderKind;
  text: string | null;
  attempts: number;
  send_at: string;
}

/** ריצה אחת של ה-dispatcher: תופס מה שהגיע זמנו, דוחה מה שנופל בשבת/מחוץ לשעות, שולח את השאר. */
export async function dispatchDue(now: Date): Promise<{ sent: number; deferred: number; cancelled: number }> {
  const { data: claimed, error } = await db().rpc("claim_due_reminders", { p_now: now.toISOString(), p_limit: 50 });
  if (error) throw error;
  const rows = (claimed ?? []) as ReminderRow[];
  if (!rows.length) return { sent: 0, deferred: 0, cancelled: 0 };

  const [windows, { data: settings }] = await Promise.all([
    loadQuietWindows(now),
    db().from("settings").select("talk_hours").single(),
  ]);
  const talk = settings?.talk_hours as { start: string; end: string } | undefined;

  const taskIds = [...new Set(rows.map((r) => r.task_id).filter(Boolean))] as string[];
  const { data: tasks } = taskIds.length
    ? await db().from("tasks").select("id, title, category, status, due_at, snooze_count, projects(name)").in("id", taskIds)
    : { data: [] };
  // deno-lint-ignore no-explicit-any
  const taskById = new Map((tasks ?? []).map((t: any) => [t.id, t]));

  const toSend: DueReminder[] = [];
  let deferred = 0, cancelled = 0;
  for (const r of rows) {
    const t = r.task_id ? taskById.get(r.task_id) : null;
    // משימה שנסגרה או נמחקה — אין על מה להזכיר
    if (r.task_id && (!t || ["done", "dropped"].includes(t.status))) {
      await setStatus(r.id, "cancelled");
      cancelled++;
      continue;
    }
    const allowed = nextSendTime(now, windows, UNSOLICITED.includes(r.kind) ? talk : undefined);
    if (allowed.getTime() > now.getTime()) {
      await db().from("reminders").update({ status: "pending", send_at: allowed.toISOString() }).eq("id", r.id);
      deferred++;
      continue;
    }
    toSend.push({
      id: r.id,
      kind: r.kind,
      text: r.text,
      task: t
        ? { id: t.id, title: t.title, category: t.category, due_at: t.due_at, snooze_count: t.snooze_count, project: t.projects?.name ?? null }
        : null,
    });
  }

  let sent = 0;
  const chat = miriChatId();
  const groups = toSend.length >= 3 ? [toSend] : toSend.map((r) => [r]);
  for (const group of groups) {
    const { text, keyboard } = group.length === 1 ? renderOne(group[0], now) : renderBatch(group, now);
    try {
      const messageId = await sendWithKeyboard(chat, text, keyboard);
      await db().from("reminders").update({ status: "sent", sent_at: now.toISOString(), telegram_message_id: messageId })
        .in("id", group.map((r) => r.id));
      await logAssistant(text);
      sent += group.length;
      // מעקב ראשון שיצא → שאלה אחת נוספת בערב, אם עד אז לא נסגר
      for (const r of group) {
        const evening = r.kind === "followup" ? eveningFollowupAt(now) : null;
        if (evening && r.task) {
          await db().from("reminders").insert({ task_id: r.task.id, kind: "followup_evening", send_at: evening.toISOString() });
        }
      }
    } catch (e) {
      console.error("send failed", e);
      for (const r of group) {
        const row = rows.find((x) => x.id === r.id)!;
        await setStatus(r.id, row.attempts >= MAX_ATTEMPTS ? "cancelled" : "pending");
      }
    }
  }
  return { sent, deferred, cancelled };
}

async function setStatus(id: string, status: string) {
  const { error } = await db().from("reminders").update({ status }).eq("id", id);
  if (error) console.error("setStatus failed", error);
}

/** הודעות יזומות נכנסות להיסטוריה — כדי שה-Concierge יבין "כן, עשיתי" כתשובה לתזכורת. */
async function logAssistant(text: string) {
  await db().from("messages").insert({ role: "assistant", content: { text, kind: "reminder" } });
}

/** לחיצה על כפתור. מחזיר true אם טופל (שלנו). */
export async function handleCallback(cb: NonNullable<TgUpdate["callback_query"]>): Promise<boolean> {
  const parsed = parseCallback(cb.data);
  if (!parsed || !cb.message) return false;
  const { action, reminderId } = parsed;
  const now = new Date();

  const { data: r } = await db().from("reminders").select("id, task_id, kind, text, tasks(id, title, category, status, snooze_count)")
    .eq("id", reminderId).maybeSingle();
  if (!r) {
    await answerCallback(cb.id, "התזכורת הזו כבר לא קיימת");
    return true;
  }
  // deno-lint-ignore no-explicit-any
  const task = (r as any).tasks as { id: string; title: string; category: "personal" | "work"; status: string; snooze_count: number } | null;
  let target: Date | undefined;

  if (task && ["done", "dropped"].includes(task.status) && action !== "ack") {
    await answerCallback(cb.id, "כבר סגור 👍");
  } else if (action === "done" && task) {
    await db().from("tasks").update({ status: "done", completed_at: now.toISOString() }).eq("id", task.id);
    await answerCallback(cb.id, "יש! ✅");
  } else if (action === "drop" && task) {
    await db().from("tasks").update({ status: "dropped" }).eq("id", task.id);
    await answerCallback(cb.id, "ירד מהרשימה");
  } else if (action === "ack") {
    await answerCallback(cb.id, "👍");
  } else if (action === "snz1h" || action === "snzTom" || action === "snzWeek") {
    target = snoozeTarget(action, now, task?.category ?? "personal");
    if (task && r.kind !== "reminder") {
      // מעקב על מועד שעבר → המועד זז (הטריגר יוצר מעקב חדש לזמן החדש)
      await db().from("tasks").update({ due_at: target.toISOString(), status: "snoozed", snooze_count: task.snooze_count + 1 })
        .eq("id", task.id);
    } else {
      // תזכורת → תזכורת חדשה לזמן החדש; המועד של המשימה לא משתנה
      await db().from("reminders").insert({ task_id: r.task_id, kind: "reminder", text: r.text, send_at: target.toISOString() });
      if (task) await db().from("tasks").update({ snooze_count: task.snooze_count + 1 }).eq("id", task.id);
    }
    await answerCallback(cb.id, actionLabel(action, target));
  } else {
    await answerCallback(cb.id);
  }

  // מעקב ערב מיותר אחרי שמירי כבר הגיבה
  if (task) {
    await db().from("reminders").update({ status: "cancelled" })
      .eq("task_id", task.id).eq("kind", "followup_evening").eq("status", "pending");
  }

  await updateMessageAfterAction(cb, reminderId, action, target);
  const title = task?.title ?? r.text ?? "תזכורת";
  await db().from("messages").insert({ role: "user", content: { text: `[כפתור] ${actionLabel(action, target)}: ${title}`, kind: "button" } });
  return true;
}

/** הודעה בודדת: הכפתורים מתחלפים בשורת סטטוס. הודעה מקובצת: רק השורה של הפריט הזה נעלמת. */
async function updateMessageAfterAction(
  cb: NonNullable<TgUpdate["callback_query"]>,
  reminderId: string,
  action: Action,
  target?: Date,
) {
  const msg = cb.message!;
  const rows = msg.reply_markup?.inline_keyboard ?? [];
  const label = actionLabel(action, target);
  const isBatch = rows.length > 2 || rows.some((row) => row.some((b) => /\d/.test(b.text)));
  if (!isBatch) {
    await editMessage(msg.chat.id, msg.message_id, `${msg.text ?? ""}\n\n${label}`);
    return;
  }
  const remaining = rows.filter((row) => !row.some((b) => b.callback_data.endsWith(reminderId)));
  const n = rows.findIndex((row) => row.some((b) => b.callback_data.endsWith(reminderId))) + 1;
  await editMessage(msg.chat.id, msg.message_id, `${msg.text ?? ""}\n${n}: ${label}`, remaining);
}
