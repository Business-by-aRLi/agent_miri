import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatLocalIso, localToUtc } from "../time.ts";
import { type DueReminder, eveningFollowupAt, parseCallback, renderBatch, renderOne, snoozeTarget } from "./render.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = localToUtc("2026-10-07T15:30"); // רביעי

const task = (over: Partial<NonNullable<DueReminder["task"]>> = {}) => ({
  id: "t1",
  title: "לעשות תיקונים לעקיבא",
  category: "work" as const,
  due_at: localToUtc("2026-10-07T15:00").toISOString(),
  snooze_count: 0,
  project: "Kiddush Hub",
  ...over,
});

Deno.test("parseCallback: תקין / זר / פגום", () => {
  assertEquals(parseCallback(`done:${ID}`), { action: "done", reminderId: ID });
  assertEquals(parseCallback(`hack:${ID}`), null);
  assertEquals(parseCallback("done:123"), null);
  assertEquals(parseCallback(undefined), null);
});

Deno.test("callback_data תמיד עד 64 בתים", () => {
  const { keyboard } = renderOne({ id: ID, kind: "followup", text: null, task: task() }, now);
  for (const row of keyboard) for (const b of row) assertEquals(new TextEncoder().encode(b.callback_data).length <= 64, true);
});

Deno.test("followup רגיל: שעת המועד + 4 כפתורים", () => {
  const r = renderOne({ id: ID, kind: "followup", text: null, task: task() }, now);
  assertStringIncludes(r.text, "היה אמור להיות ב-15:00");
  assertStringIncludes(r.text, "Kiddush Hub");
  assertEquals(r.keyboard.flat().length, 4);
});

Deno.test("משימה שנדחתה 3 פעמים: שאלה ישירה + כפתור לוותר", () => {
  const r = renderOne({ id: ID, kind: "followup", text: null, task: task({ snooze_count: 3 }) }, now);
  assertStringIncludes(r.text, "נדחתה כבר 3 פעמים");
  assertEquals(r.keyboard.flat().some((b) => b.callback_data.startsWith("drop:")), true);
});

Deno.test("תזכורת חופשית: טקסט + תודה/עוד שעה", () => {
  const r = renderOne({ id: ID, kind: "reminder", text: "להוציא את הבגדים מהמכונה", task: null }, now);
  assertEquals(r.text, "⏰ להוציא את הבגדים מהמכונה");
  assertEquals(r.keyboard.flat().map((b) => b.callback_data.split(":")[0]), ["ack", "snz1h"]);
});

Deno.test("batch: ממוספר, שורה לכל פריט", () => {
  const items: DueReminder[] = [
    { id: ID, kind: "followup", text: null, task: task() },
    { id: ID, kind: "reminder", text: "לקנות חלב", task: null },
    { id: ID, kind: "reminder", text: null, task: task({ title: "להתקשר לליאור" }) },
  ];
  const r = renderBatch(items, now);
  assertStringIncludes(r.text, "1. לעשות תיקונים לעקיבא");
  assertStringIncludes(r.text, "2. לקנות חלב");
  assertEquals(r.keyboard.length, 3);
});

Deno.test("snoozeTarget: שעה / מחר (עבודה 09:00, אישי 18:00) / יום ראשון הבא", () => {
  assertEquals(formatLocalIso(snoozeTarget("snz1h", now, "work")), "2026-10-07T16:30");
  assertEquals(formatLocalIso(snoozeTarget("snzTom", now, "work")), "2026-10-08T09:00");
  assertEquals(formatLocalIso(snoozeTarget("snzTom", now, "personal")), "2026-10-08T18:00");
  assertEquals(formatLocalIso(snoozeTarget("snzWeek", now, "work")), "2026-10-11T09:00");
  // מיום ראשון: שבוע הבא = ראשון שאחריו
  assertEquals(formatLocalIso(snoozeTarget("snzWeek", localToUtc("2026-10-11T10:00"), "work")), "2026-10-18T09:00");
  // מחר שנופל אחרי מעבר לשעון חורף — עדיין 09:00 מקומי
  assertEquals(formatLocalIso(snoozeTarget("snzTom", localToUtc("2026-10-24T22:00"), "work")), "2026-10-25T09:00");
});

Deno.test("eveningFollowupAt: רק אם נשארה לפחות חצי שעה עד 20:00", () => {
  assertEquals(formatLocalIso(eveningFollowupAt(now)!), "2026-10-07T20:00");
  assertEquals(eveningFollowupAt(localToUtc("2026-10-07T19:45")), null);
  assertEquals(eveningFollowupAt(localToUtc("2026-10-07T21:00")), null);
});
