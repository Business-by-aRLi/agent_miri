// שיבוץ משימות ביומן: מחבר בין האלגוריתם הטהור (scheduler.ts) ל-Google Calendar ולטבלת המשימות.
import { busyIntervals, createTaskEvent, deleteTaskEvent, listEvents } from "./calendar.ts";
import { db } from "./db.ts";
import { loadQuietWindows } from "./hebcal.ts";
import { findSlots } from "./scheduler.ts";
import { formatLocalIso, quietWindowAt } from "./time.ts";

const DEFAULT_MINUTES = 60;

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  category: "work" | "personal";
  status: string;
  due_at: string | null;
  estimated_minutes: number | null;
  scheduled_start: string | null;
  gcal_event_id: string | null;
}

async function getTask(id: string): Promise<TaskRow> {
  const { data, error } = await db().from("tasks")
    .select("id, title, notes, category, status, due_at, estimated_minutes, scheduled_start, gcal_event_id").eq("id", id).single();
  if (error) throw error;
  return data as TaskRow;
}

export interface Slot {
  start: Date;
  end: Date;
  lateForDue: boolean;
}

export async function suggestSlots(taskId: string, opts: { count?: number; from?: Date; spreadDays?: boolean } = {}): Promise<Slot[]> {
  const t = await getTask(taskId);
  const now = opts.from ?? new Date();
  const horizon = new Date(now.getTime() + 21 * 86400_000);
  const [events, quiet] = await Promise.all([listEvents(now, horizon), loadQuietWindows(now)]);
  // האירוע הנוכחי של המשימה עצמה לא חוסם את השיבוץ מחדש שלה
  const busy = busyIntervals(events.filter((e) => e.id !== t.gcal_event_id));
  return findSlots(
    {
      durationMin: t.estimated_minutes ?? DEFAULT_MINUTES,
      category: t.category,
      from: now,
      until: t.due_at ? new Date(t.due_at) : undefined,
      count: opts.count ?? 3,
      spreadDays: opts.spreadDays,
    },
    busy,
    quiet,
  );
}

/**
 * משבץ משימה. בלי start — החור הראשון שמתאים. עם start — בודק שהזמן פנוי (אחרת שגיאה עם הצעות).
 * שיבוץ מחדש מוחק את האירוע הקודם. מחזיר את הזמן שנקבע.
 */
export async function scheduleTask(taskId: string, start?: Date): Promise<{ start: Date; end: Date; rescheduled: boolean; lateForDue: boolean }> {
  const t = await getTask(taskId);
  if (["done", "dropped"].includes(t.status)) throw new ScheduleError("המשימה כבר סגורה");
  const minutes = t.estimated_minutes ?? DEFAULT_MINUTES;

  let slot: Slot;
  if (start) {
    if (t.scheduled_start && new Date(t.scheduled_start).getTime() === start.getTime()) {
      return { start, end: new Date(start.getTime() + minutes * 60_000), rescheduled: false, lateForDue: false };
    }
    const end = new Date(start.getTime() + minutes * 60_000);
    const [events, quiet] = await Promise.all([listEvents(start, end), loadQuietWindows(start)]);
    if (quietWindowAt(start, quiet) || quietWindowAt(new Date(end.getTime() - 1), quiet)) {
      throw new ScheduleError("הזמן הזה נופל בשבת/חג");
    }
    const clash = busyIntervals(events.filter((e) => e.id !== t.gcal_event_id)).find((b) => b.start < end && b.end > start);
    if (clash) {
      const clashEvent = events.find((e) => e.start.getTime() === clash.start.getTime());
      throw new ScheduleError(`מתנגש עם "${clashEvent?.summary ?? "אירוע"}" (${formatLocalIso(clash.start).slice(11)}–${formatLocalIso(clash.end).slice(11)})`);
    }
    slot = { start, end, lateForDue: !!t.due_at && end > new Date(t.due_at) };
  } else {
    const [first] = await suggestSlots(taskId, { count: 1 });
    if (!first) throw new ScheduleError("לא מצאתי חור פנוי ב-3 השבועות הקרובים");
    slot = first;
  }

  const rescheduled = !!t.gcal_event_id;
  if (t.gcal_event_id) await deleteTaskEvent(t.gcal_event_id);
  const { eventId } = await createTaskEvent({ title: t.title, notes: t.notes, start: slot.start, end: slot.end, taskId: t.id });
  const { error } = await db().from("tasks").update({
    scheduled_start: slot.start.toISOString(),
    scheduled_end: slot.end.toISOString(),
    gcal_event_id: eventId,
    status: "scheduled",
  }).eq("id", t.id);
  if (error) throw error;
  return { start: slot.start, end: slot.end, rescheduled, lateForDue: slot.lateForDue };
}

export async function unscheduleTask(taskId: string): Promise<void> {
  const t = await getTask(taskId);
  if (t.gcal_event_id) await deleteTaskEvent(t.gcal_event_id);
  await db().from("tasks").update({ scheduled_start: null, scheduled_end: null, gcal_event_id: null, status: "inbox" })
    .eq("id", t.id);
}

export class ScheduleError extends Error {}

/** "יום שני 10:00–11:00" */
export function slotLabel(s: { start: Date; end: Date }): string {
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const a = formatLocalIso(s.start), b = formatLocalIso(s.end);
  const today = formatLocalIso(new Date()).slice(0, 10);
  const tomorrow = formatLocalIso(new Date(Date.now() + 86400_000)).slice(0, 10);
  const day = a.slice(0, 10) === today ? "היום" : a.slice(0, 10) === tomorrow ? "מחר" : `${days[new Date(`${a.slice(0, 10)}T12:00:00Z`).getUTCDay()]} ${Number(a.slice(8, 10))}.${Number(a.slice(5, 7))}`;
  return `${day} ${a.slice(11)}–${b.slice(11)}`;
}
