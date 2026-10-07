// רץ כל דקה מ-pg_cron. שולח תזכורות ומעקבים שהגיע זמנם, ודוחה את מה שנופל בשבת/חג.
// אימות: הסוד נשמר ב-Vault; pg_cron שולח אותו, ואנחנו בודקים מול ה-DB (הוא לא קיים בשום מקום אחר).
import { db } from "../_shared/db.ts";
import { dispatchDue } from "../_shared/reminders/service.ts";

Deno.serve(async (req) => {
  const secret = req.headers.get("X-Dispatcher-Secret");
  if (!secret) return new Response("forbidden", { status: 403 });
  const { data: ok } = await db().rpc("check_dispatcher_secret", { candidate: secret });
  if (!ok) return new Response("forbidden", { status: 403 });

  try {
    const result = await dispatchDue(new Date());
    if (result.sent || result.deferred || result.cancelled) console.log("dispatch", result);
    return Response.json(result);
  } catch (e) {
    console.error("dispatch failed", e);
    return new Response("error", { status: 500 });
  }
});
