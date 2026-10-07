import { assertEquals } from "@std/assert";
import { byPriority, priorityScore } from "./priority.ts";
import { findSlots, maxSlotMinutes, mergeBusy } from "./scheduler.ts";
import { buildQuietWindows, formatLocalIso, localToUtc } from "./time.ts";

const L = (s: string) => localToUtc(s);
const F = (d: Date) => formatLocalIso(d);
const iv = (a: string, b: string) => ({ start: L(a), end: L(b) });
// שבת 9-10.10.2026 ברמת גן
const SHABBAT = buildQuietWindows([
  { category: "candles", date: "2026-10-09T17:55:00+03:00" },
  { category: "havdalah", date: "2026-10-10T18:51:00+03:00" },
]);

Deno.test("mergeBusy: חופפים מתאחדים, כולל מרווח", () => {
  const m = mergeBusy([iv("2026-10-08T10:00", "2026-10-08T11:00"), iv("2026-10-08T11:15", "2026-10-08T12:00")], 10);
  assertEquals(m.length, 1); // 11:00+10 = 11:10 ≥ 11:15-10 = 11:05
  assertEquals(F(m[0].start), "2026-10-08T09:50");
  assertEquals(F(m[0].end), "2026-10-08T12:10");
});

Deno.test("findSlots: יום ריק — 09:00, אחד ליום, ימי עבודה בלבד", () => {
  // רביעי 14:00 → הצעה ראשונה היום ב-14:00, ואז חמישי, ואז ראשון (שישי-שבת לא ימי עבודה)
  const s = findSlots({ durationMin: 60, category: "work", from: L("2026-10-07T14:00") }, [], SHABBAT);
  assertEquals(s.map((x) => F(x.start)), ["2026-10-07T14:00", "2026-10-08T09:00", "2026-10-11T09:00"]);
});

Deno.test("findSlots: לא חורג מ-15:00", () => {
  // רביעי 14:30, שעה וחצי — לא נכנס היום
  const s = findSlots({ durationMin: 90, category: "work", from: L("2026-10-07T14:30"), count: 1 }, [], []);
  assertEquals(F(s[0].start), "2026-10-08T09:00");
});

Deno.test("findSlots: עוקף פגישות עם מרווח, מיושר לרבע שעה", () => {
  const busy = [iv("2026-10-08T09:00", "2026-10-08T10:20"), iv("2026-10-08T11:30", "2026-10-08T12:00")];
  const s = findSlots({ durationMin: 60, category: "work", from: L("2026-10-08T08:00"), count: 1 }, busy, []);
  // 10:20+10 = 10:30 → 11:30 מתנגש עם 11:20 (11:30-10) → 12:10 → 12:15
  assertEquals(F(s[0].start), "2026-10-08T12:15");
});

Deno.test("findSlots: אישי — אחר הצהריים, כולל שישי, אף פעם לא בשבת", () => {
  const s = findSlots({ durationMin: 60, category: "personal", from: L("2026-10-09T15:00"), count: 2 }, [], SHABBAT);
  // שישי 16:00 — בתוך חלון השבת? השבת מתחילה 17:25 (חצי שעה לפני הדלקה) + 10 דק' מרווח → 17:15.
  // 16:00-17:00 פנוי. אחר כך שבת עד 19:01 → במוצ"ש החלון האישי עד 21:00 — אבל שבת לא ביום 6 בחלון? מוצ"ש = יום 6.
  assertEquals(F(s[0].start), "2026-10-09T16:00");
  assertEquals(F(s[1].start), "2026-10-11T16:00");
});

Deno.test("findSlots: lateForDue מסומן כשאין מקום לפני המועד", () => {
  const busy = [iv("2026-10-08T09:00", "2026-10-08T15:00")];
  const s = findSlots({ durationMin: 60, category: "work", from: L("2026-10-08T08:00"), until: L("2026-10-08T15:00"), count: 1 }, busy, []);
  assertEquals(F(s[0].start), "2026-10-11T09:00");
  assertEquals(s[0].lateForDue, true);
});

Deno.test("findSlots: spreadDays=false — כמה באותו יום", () => {
  const s = findSlots({ durationMin: 60, category: "work", from: L("2026-10-08T09:00"), count: 3, spreadDays: false }, [], []);
  assertEquals(s.map((x) => F(x.start)), ["2026-10-08T09:00", "2026-10-08T10:00", "2026-10-08T11:00"]);
});

Deno.test("maxSlotMinutes", () => {
  assertEquals(maxSlotMinutes("work"), 360);
});

Deno.test("priority: חשוב+באיחור למעלה, בלי מועד ונמוך למטה", () => {
  const now = L("2026-10-07T10:00");
  const overdue = { importance: 2, urgency: 2, due_at: L("2026-10-06T15:00").toISOString(), snooze_count: 0 };
  const nextWeek = { importance: 3, urgency: 2, due_at: L("2026-10-14T15:00").toISOString(), snooze_count: 0 };
  const someday = { importance: 1, urgency: 1, due_at: null, snooze_count: 0 };
  const [a, b, c] = byPriority([someday, nextWeek, overdue], now);
  assertEquals([a, b, c], [overdue, nextWeek, someday]);
  // דחיות מעלות ציון
  assertEquals(priorityScore({ ...someday, snooze_count: 3 }, now) > priorityScore(someday, now), true);
});
