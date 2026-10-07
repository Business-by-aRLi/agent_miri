// זמן ותאריכים בשעון ישראל — פונקציות טהורות בלבד.
// למה: LLM לא אמין בחישובי זמן; כל המרה בין שעון ישראל ל-UTC עוברת כאן, כולל מעברי שעון קיץ/חורף.

export const TZ = "Asia/Jerusalem";

const WEEKDAYS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** רכיבי שעון-קיר בישראל עבור רגע נתון. */
export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=ראשון … 6=שבת
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
});

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function toLocalParts(date: Date): LocalParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFormatter.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY_EN.indexOf(p.weekday),
  };
}

/** ההפרש בדקות בין שעון ישראל ל-UTC ברגע נתון (+120 בחורף, +180 בקיץ). */
export function offsetMinutes(date: Date): number {
  const l = toLocalParts(date);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/**
 * שעון-קיר בישראל → רגע ב-UTC.
 * מקבל "2026-10-08T10:00" (בלי אזור זמן) — הפורמט שה-LLM מחזיר.
 * למה שני סבבים: ה-offset תלוי ברגע עצמו, וסביב מעבר שעון הסבב הראשון יכול לטעות בשעה.
 * שעה שלא קיימת (קפיצה קדימה באביב) נדחפת קדימה; שעה כפולה (בסתיו) מקבלת את המופע הראשון.
 */
export function localToUtc(localIso: string): Date {
  const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`פורמט זמן מקומי לא תקין: ${localIso}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  let guess = wall - offsetMinutes(new Date(wall)) * 60000;
  guess = wall - offsetMinutes(new Date(guess)) * 60000;
  // בסתיו: אם גם שעה קודם מתמפה לאותו שעון-קיר, המופע הראשון הוא הנכון
  const earlier = guess - 3600000;
  if (formatLocalIso(new Date(earlier)) === formatLocalIso(new Date(guess))) return new Date(earlier);
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** רגע → "YYYY-MM-DDTHH:mm" בשעון ישראל. */
export function formatLocalIso(date: Date): string {
  const l = toLocalParts(date);
  return `${l.year}-${pad(l.month)}-${pad(l.day)}T${pad(l.hour)}:${pad(l.minute)}`;
}

/** תחילת היום (00:00 שעון ישראל) וסופו, כרגעי UTC. משמש את /today. */
export function localDayRange(date: Date): { start: Date; end: Date } {
  const l = toLocalParts(date);
  const start = localToUtc(`${l.year}-${pad(l.month)}-${pad(l.day)}T00:00`);
  const next = new Date(Date.UTC(l.year, l.month - 1, l.day + 1));
  const end = localToUtc(
    `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T00:00`,
  );
  return { start, end };
}

// ---------- תאריך עברי ----------

const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
const HUNDREDS = ["", "ק", "ר", "ש", "ת"];

/**
 * מספר → גימטריה עם גרש/גרשיים (1-999). למשל 26 → כ״ו, 787 → תשפ״ז.
 * ט״ו וט״ז במקום י״ה וי״ו — כדי לא לכתוב את השם.
 */
export function hebrewNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`מחוץ לטווח: ${n}`);
  let s = "";
  let h = Math.floor(n / 100);
  while (h > 4) {
    s += "ת";
    h -= 4;
  }
  s += HUNDREDS[h];
  const rest = n % 100;
  if (rest === 15) s += "טו";
  else if (rest === 16) s += "טז";
  else s += TENS[Math.floor(rest / 10)] + ONES[rest % 10];
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

const hebrewDateFormatter = new Intl.DateTimeFormat("he-IL-u-ca-hebrew", {
  timeZone: TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** תאריך עברי, למשל "כ״ו בתשרי תשפ״ז". */
export function hebrewDate(date: Date): string {
  const p: Record<string, string> = {};
  for (const { type, value } of hebrewDateFormatter.formatToParts(date)) p[type] = value;
  const year = Number(p.year) % 1000;
  return `${hebrewNumeral(Number(p.day))} ב${p.month} ${hebrewNumeral(year)}`;
}

// ---------- הקשר זמן לפרומפט ----------

export interface TimeContext {
  weekdayHe: string; // "רביעי"
  gregorianHe: string; // "7 באוקטובר 2026"
  hebrewDate: string; // "כ״ו בתשרי תשפ״ז"
  timeHe: string; // "09:30"
  localIso: string; // "2026-10-07T09:30"
}

const gregorianFormatter = new Intl.DateTimeFormat("he-IL", {
  timeZone: TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** כל מה שה-LLM צריך לדעת על "עכשיו" — מוזרק לכל קריאה. */
export function timeContext(now: Date): TimeContext {
  const l = toLocalParts(now);
  return {
    weekdayHe: WEEKDAYS_HE[l.weekday],
    gregorianHe: gregorianFormatter.format(now),
    hebrewDate: hebrewDate(now),
    timeHe: `${pad(l.hour)}:${pad(l.minute)}`,
    localIso: formatLocalIso(now),
  };
}
