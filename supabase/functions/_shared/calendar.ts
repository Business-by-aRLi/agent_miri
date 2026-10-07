// Google Calendar: OAuth, קריאת אירועים מכל היומנים, וכתיבה רק ליומן "משימות".
// הרשאות מינימליות: calendar.app.created (יומן משלנו), calendar.events.readonly + calendarlist.readonly (לראות מתי תפוס).
// הסוכן לא יכול לשנות או למחוק שום דבר ביומנים הקיימים של מירי — ההרשאה פשוט לא קיימת.
import { db, requireEnv } from "./db.ts";
import type { Interval } from "./scheduler.ts";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "openid",
  "email",
];
export const REDIRECT_URI = "https://nklintfbsfagcwlbfwob.supabase.co/functions/v1/google-oauth/callback";
const TASKS_CALENDAR_NAME = "משימות";
const API = "https://www.googleapis.com/calendar/v3";

export class CalendarNotConnected extends Error {
  constructor() {
    super("היומן לא מחובר");
  }
}

// ---------- OAuth ----------

export function authUrl(state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent"); // מבטיח refresh_token גם בחיבור חוזר
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(code: string): Promise<{ refresh_token?: string; access_token: string; id_token?: string; scope: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
  return await res.json();
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const { data: refresh } = await db().rpc("get_google_refresh_token");
  if (!refresh) throw new CalendarNotConnected();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // invalid_grant = מירי ביטלה גישה / הטוקן פג → צריך לחבר מחדש
    if (body.includes("invalid_grant")) throw new CalendarNotConnected();
    throw new Error(`Google refresh ${res.status}: ${body}`);
  }
  const j = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function gapi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`Calendar ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : await res.json();
}

// ---------- יומן "משימות" ----------

/** מחזיר את היומן "משימות", ויוצר אותו בפעם הראשונה. */
export async function ensureTasksCalendar(): Promise<string> {
  const { data: s } = await db().from("settings").select("gcal_tasks_calendar_id").single();
  if (s?.gcal_tasks_calendar_id) {
    try {
      await gapi(`/calendars/${encodeURIComponent(s.gcal_tasks_calendar_id)}`);
      return s.gcal_tasks_calendar_id;
    } catch { /* נמחק ע"י מירי → ניצור מחדש */ }
  }
  const cal = await gapi<{ id: string }>("/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: TASKS_CALENDAR_NAME, description: "משימות שהסוכן האישי שיבץ", timeZone: "Asia/Jerusalem" }),
  });
  await db().from("settings").update({ gcal_tasks_calendar_id: cal.id }).eq("id", true);
  return cal.id;
}

// ---------- קריאה ----------

export interface CalEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  transparent: boolean; // "פנוי" ביומן — לא חוסם
}

/** כל האירועים בטווח, מכל היומנים שמירי רואה (בלי יומנים שהוסתרו/ללא סנכרון). */
export async function listEvents(from: Date, to: Date): Promise<CalEvent[]> {
  const { items: calendars } = await gapi<{ items: Array<{ id: string; summary: string; selected?: boolean; accessRole: string }> }>(
    "/users/me/calendarList?minAccessRole=freeBusyReader",
  );
  const relevant = calendars.filter((c) => c.selected !== false);
  const results = await Promise.all(relevant.map(async (c) => {
    try {
      const q = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      // deno-lint-ignore no-explicit-any
      const { items } = await gapi<{ items: Array<Record<string, any>> }>(`/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      return items.filter((e) => e.status !== "cancelled").map((e) => ({
        id: e.id,
        calendarId: c.id,
        calendarName: c.summary,
        summary: e.summary ?? "(תפוס)",
        allDay: !!e.start?.date,
        start: new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00+03:00`),
        end: new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00+03:00`),
        transparent: e.transparency === "transparent",
      }));
    } catch (err) {
      console.error(`calendar ${c.summary} failed`, err);
      return [];
    }
  }));
  return results.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** מה חוסם שיבוץ: אירועים עם שעה שלא סומנו "פנוי". אירועי יום שלם (חגים, ימי הולדת) לא חוסמים. */
export function busyIntervals(events: CalEvent[]): Interval[] {
  return events.filter((e) => !e.allDay && !e.transparent).map((e) => ({ start: e.start, end: e.end }));
}

// ---------- כתיבה (רק ליומן משימות) ----------

export async function createTaskEvent(t: { title: string; notes?: string | null; start: Date; end: Date; taskId: string }) {
  const calendarId = await ensureTasksCalendar();
  const created = await gapi<{ id: string }>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: t.title,
      description: [t.notes, "נוצר ע\"י הסוכן האישי"].filter(Boolean).join("\n\n"),
      start: { dateTime: t.start.toISOString(), timeZone: "Asia/Jerusalem" },
      end: { dateTime: t.end.toISOString(), timeZone: "Asia/Jerusalem" },
      extendedProperties: { private: { agent_task_id: t.taskId } },
      reminders: { useDefault: false, overrides: [] }, // הסוכן כבר מזכיר בטלגרם — בלי כפילות
    }),
  });
  // post-condition: קוראים בחזרה ומוודאים שהאירוע באמת שם ובזמן הנכון (מהאפיון: לא סומכים על 200 בלבד)
  const back = await gapi<{ id: string; start: { dateTime: string }; status: string }>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(created.id)}`,
  );
  if (back.status === "cancelled" || new Date(back.start.dateTime).getTime() !== t.start.getTime()) {
    throw new Error(`post-condition failed: האירוע נוצר אבל לא נקרא בחזרה כמו שצריך (${back.status} ${back.start?.dateTime})`);
  }
  return { eventId: created.id, calendarId };
}

export async function deleteTaskEvent(eventId: string) {
  const calendarId = await ensureTasksCalendar();
  await gapi(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" })
    .catch((e) => {
      if (!String(e).includes(" 410:") && !String(e).includes(" 404:")) throw e; // כבר נמחק — בסדר
    });
}
