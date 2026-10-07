import { assertEquals, assertThrows } from "@std/assert";
import {
  formatLocalIso,
  hebrewDate,
  hebrewNumeral,
  localDayRange,
  localToUtc,
  offsetMinutes,
  timeContext,
} from "./time.ts";

// 2026: שעון קיץ מתחיל ב-27.3 (02:00→03:00), נגמר ב-25.10 (02:00→01:00)

Deno.test("offset: חורף +120, קיץ +180", () => {
  assertEquals(offsetMinutes(new Date("2026-01-15T12:00:00Z")), 120);
  assertEquals(offsetMinutes(new Date("2026-07-15T12:00:00Z")), 180);
});

Deno.test("localToUtc: שעה רגילה בקיץ ובחורף", () => {
  assertEquals(localToUtc("2026-10-08T10:00").toISOString(), "2026-10-08T07:00:00.000Z");
  assertEquals(localToUtc("2026-12-01T10:00").toISOString(), "2026-12-01T08:00:00.000Z");
  assertEquals(localToUtc("2026-12-01").toISOString(), "2026-11-30T22:00:00.000Z");
});

Deno.test("localToUtc: סביב מעבר לשעון קיץ", () => {
  assertEquals(localToUtc("2026-03-27T01:30").toISOString(), "2026-03-26T23:30:00.000Z");
  assertEquals(localToUtc("2026-03-27T03:30").toISOString(), "2026-03-27T00:30:00.000Z");
  // 02:30 לא קיים — נדחף קדימה ל-03:30
  assertEquals(formatLocalIso(localToUtc("2026-03-27T02:30")), "2026-03-27T03:30");
});

Deno.test("localToUtc: שעה כפולה במעבר לחורף מקבלת את המופע הראשון", () => {
  // 01:30 קורה פעמיים ב-25.10; הראשון עוד בשעון קיץ (UTC+3)
  assertEquals(localToUtc("2026-10-25T01:30").toISOString(), "2026-10-24T22:30:00.000Z");
});

Deno.test("localToUtc: הלוך-חזור לאורך שנה שלמה", () => {
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 60000 * 60) {
    const local = formatLocalIso(new Date(t));
    assertEquals(formatLocalIso(localToUtc(local)), local);
  }
});

Deno.test("localToUtc: פורמט לא תקין נזרק", () => {
  assertThrows(() => localToUtc("מחר בעשר"));
  assertThrows(() => localToUtc("2026-10-08T10:00+03:00"));
});

Deno.test("localDayRange: יום רגיל = 24 שעות", () => {
  const { start, end } = localDayRange(new Date("2026-10-07T20:00:00Z")); // 23:00 בישראל
  assertEquals(start.toISOString(), "2026-10-06T21:00:00.000Z");
  assertEquals(end.toISOString(), "2026-10-07T21:00:00.000Z");
});

Deno.test("localDayRange: יום המעבר לחורף = 25 שעות", () => {
  const { start, end } = localDayRange(new Date("2026-10-25T09:00:00Z"));
  assertEquals((end.getTime() - start.getTime()) / 3600000, 25);
});

Deno.test("hebrewNumeral: גימטריה", () => {
  assertEquals(hebrewNumeral(1), "א׳");
  assertEquals(hebrewNumeral(10), "י׳");
  assertEquals(hebrewNumeral(15), "ט״ו");
  assertEquals(hebrewNumeral(16), "ט״ז");
  assertEquals(hebrewNumeral(26), "כ״ו");
  assertEquals(hebrewNumeral(30), "ל׳");
  assertEquals(hebrewNumeral(787), "תשפ״ז");
  assertEquals(hebrewNumeral(800), "ת״ת");
  assertEquals(hebrewNumeral(415), "תט״ו");
  assertThrows(() => hebrewNumeral(0));
});

Deno.test("hebrewDate: תאריך עברי", () => {
  assertEquals(hebrewDate(new Date("2026-10-07T06:30:00Z")), "כ״ו בתשרי תשפ״ז");
  // אחרי חצות בישראל כבר יום אחר, גם כש-UTC עוד ביום הקודם
  assertEquals(hebrewDate(new Date("2026-10-07T21:30:00Z")), "כ״ז בתשרי תשפ״ז");
});

Deno.test("timeContext: כל השדות", () => {
  const c = timeContext(new Date("2026-10-07T06:30:00Z"));
  assertEquals(c.weekdayHe, "רביעי");
  assertEquals(c.gregorianHe, "7 באוקטובר 2026");
  assertEquals(c.hebrewDate, "כ״ו בתשרי תשפ״ז");
  assertEquals(c.timeHe, "09:30");
  assertEquals(c.localIso, "2026-10-07T09:30");
});
