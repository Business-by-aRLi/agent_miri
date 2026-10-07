// זמני שבת וחג מ-Hebcal → טבלת quiet_windows.
// רמת גן; קואורדינטות ולא geonameid כדי שזמני ההדלקה יהיו מדויקים לעיר. מעבר דירה = לשנות כאן.
import { db } from "./db.ts";
import { buildQuietWindows, formatLocalIso, type HebcalEvent, type QuietWindow } from "./time.ts";

const LOCATION = { latitude: 32.0823, longitude: 34.8106, tzid: "Asia/Jerusalem" };
const FETCH_DAYS = 120;
const REFRESH_WHEN_LESS_THAN_DAYS = 30;

/** מחזיר חלונות שקט רלוונטיים; מושך מ-Hebcal רק כשהטבלה עומדת להיגמר (פעם בשלושה חודשים בערך). */
export async function loadQuietWindows(now: Date): Promise<QuietWindow[]> {
  const { data, error } = await db().from("quiet_windows").select("start_at, end_at")
    .gt("end_at", new Date(now.getTime() - 86400_000).toISOString()).order("start_at");
  if (error) throw error;
  const horizon = now.getTime() + REFRESH_WHEN_LESS_THAN_DAYS * 86400_000;
  const lastEnd = data?.length ? new Date(data[data.length - 1].end_at).getTime() : 0;
  if (lastEnd > horizon) return data.map((w) => ({ start: new Date(w.start_at), end: new Date(w.end_at) }));

  try {
    return await refresh(now);
  } catch (e) {
    // Hebcal לא זמין: עדיף להמשיך עם מה שיש (או בלי) מאשר לעצור את כל התזכורות. ננסה שוב בדקה הבאה.
    console.error("hebcal refresh failed", e);
    return (data ?? []).map((w) => ({ start: new Date(w.start_at), end: new Date(w.end_at) }));
  }
}

async function refresh(now: Date): Promise<QuietWindow[]> {
  // מתחילים יומיים אחורה: אם עכשיו שבת, ההדלקה של אתמול צריכה להיות בטווח
  const start = formatLocalIso(new Date(now.getTime() - 2 * 86400_000)).slice(0, 10);
  const end = formatLocalIso(new Date(now.getTime() + FETCH_DAYS * 86400_000)).slice(0, 10);
  const url = new URL("https://www.hebcal.com/hebcal");
  for (
    const [k, v] of Object.entries({
      v: "1", cfg: "json", maj: "on", c: "on", i: "on", geo: "pos",
      latitude: String(LOCATION.latitude), longitude: String(LOCATION.longitude), tzid: LOCATION.tzid,
      start, end,
    })
  ) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Hebcal ${res.status}`);
  const { items } = await res.json() as { items: HebcalEvent[] };
  const windows = buildQuietWindows(items);
  if (!windows.length) throw new Error("Hebcal החזיר 0 חלונות — חשוד, לא דורסים");

  const rows = windows.map((w) => ({ start_at: w.start.toISOString(), end_at: w.end.toISOString(), fetched_at: now.toISOString() }));
  const { error } = await db().from("quiet_windows").upsert(rows, { onConflict: "start_at" });
  if (error) throw error;
  return windows;
}
