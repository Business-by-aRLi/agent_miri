// מציאת חורים פנויים ביומן — טהור. מקבל אירועים תפוסים ומחזיר הצעות לשיבוץ.
//
// כללים (מהאפיון): עבודה רק בתוך שעות העבודה (9–15) בימי עבודה; אישי בחלון אחר-הצהריים/ערב;
// אף פעם לא בשבת/חג; מרווח קטן לפני ואחרי פגישות; לא לפני "עכשיו".
import { formatLocalIso, localToUtc, type QuietWindow, toLocalParts } from "./time.ts";

export interface Interval {
  start: Date;
  end: Date;
}

export interface SchedulingRules {
  /** ימים בשבוע (0=ראשון) וחלון שעות, לפי קטגוריה */
  windows: Record<"work" | "personal", { days: number[]; start: string; end: string }>;
  bufferMin: number; // מרווח סביב אירועים קיימים
  stepMin: number; // יישור התחלה (רבע שעה)
}

export const DEFAULT_RULES: SchedulingRules = {
  windows: {
    work: { days: [0, 1, 2, 3, 4], start: "09:00", end: "15:00" },
    personal: { days: [0, 1, 2, 3, 4, 5], start: "16:00", end: "21:00" },
  },
  bufferMin: 10,
  stepMin: 15,
};

export interface SlotRequest {
  durationMin: number;
  category: "work" | "personal";
  from: Date; // לא לפני
  until?: Date; // מועד יעד: הסלוט חייב להסתיים עד אז (אם אפשר)
  count?: number; // כמה הצעות (ברירת מחדל 3)
  /** הצעות בימים שונים — כדי לתת בחירה אמיתית, לא 9:00/9:15/9:30 */
  spreadDays?: boolean;
}

/** איחוד אינטרוולים חופפים (אחרי הוספת מרווח). */
export function mergeBusy(busy: Interval[], bufferMin: number): Interval[] {
  const padded = busy
    .map((b) => ({ start: new Date(b.start.getTime() - bufferMin * 60_000), end: new Date(b.end.getTime() + bufferMin * 60_000) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const b of padded) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) last.end = new Date(Math.max(last.end.getTime(), b.end.getTime()));
    else out.push({ ...b });
  }
  return out;
}

function ceilToStep(d: Date, stepMin: number): Date {
  const step = stepMin * 60_000;
  return new Date(Math.ceil(d.getTime() / step) * step);
}

/**
 * מחזיר עד count סלוטים פנויים לפי הסדר הכרונולוגי.
 * סורק עד 21 יום קדימה. אם until קבוע ואין מספיק לפניו — ממשיך אחריו ומסמן lateForDue.
 */
export function findSlots(
  req: SlotRequest,
  busy: Interval[],
  quiet: QuietWindow[],
  rules: SchedulingRules = DEFAULT_RULES,
): Array<Interval & { lateForDue: boolean }> {
  const count = req.count ?? 3;
  const win = rules.windows[req.category];
  const blocked = mergeBusy([...busy, ...quiet.map((q) => ({ start: q.start, end: q.end }))], rules.bufferMin);
  // quiet windows כבר כוללים מרווח משלהם — הוספת buffer עליהם לא מזיקה
  const durMs = req.durationMin * 60_000;
  const out: Array<Interval & { lateForDue: boolean }> = [];
  const usedDays = new Set<string>();

  const firstDay = formatLocalIso(req.from).slice(0, 10);
  const noon = localToUtc(`${firstDay}T12:00`).getTime();
  for (let d = 0; d < 21 && out.length < count; d++) {
    const day = formatLocalIso(new Date(noon + d * 86400_000)).slice(0, 10);
    const weekday = toLocalParts(localToUtc(`${day}T12:00`)).weekday;
    if (!win.days.includes(weekday)) continue;
    if (req.spreadDays !== false && usedDays.has(day)) continue;

    const dayStart = localToUtc(`${day}T${win.start}`);
    const dayEnd = localToUtc(`${day}T${win.end}`);
    let cursor = ceilToStep(new Date(Math.max(dayStart.getTime(), req.from.getTime())), rules.stepMin);

    while (cursor.getTime() + durMs <= dayEnd.getTime() && out.length < count) {
      const end = new Date(cursor.getTime() + durMs);
      const clash = blocked.find((b) => b.start < end && b.end > cursor);
      if (clash) {
        cursor = ceilToStep(clash.end, rules.stepMin);
        continue;
      }
      out.push({ start: cursor, end, lateForDue: !!req.until && end > req.until });
      usedDays.add(day);
      if (req.spreadDays !== false) break; // אחד ליום
      cursor = end;
    }
  }
  return out;
}

/** משימה ארוכה מחלון העבודה (למשל 8 שעות כשהחלון 6) — אי אפשר לשבץ ברצף. */
export function maxSlotMinutes(category: "work" | "personal", rules: SchedulingRules = DEFAULT_RULES): number {
  const w = rules.windows[category];
  const [sh, sm] = w.start.split(":").map(Number);
  const [eh, em] = w.end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}
