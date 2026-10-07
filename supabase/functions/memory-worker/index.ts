// רץ כל שעה מ-pg_cron: חילוץ עובדות מהשיחות החדשות. בשלוש בלילה (שעון ישראל) גם איחוד.
import { db } from "../_shared/db.ts";
import { consolidateMemories, extractMemories } from "../_shared/memory/facts.ts";
import { toLocalParts } from "../_shared/time.ts";

Deno.serve(async (req) => {
  const secret = req.headers.get("X-Dispatcher-Secret");
  if (!secret) return new Response("forbidden", { status: 403 });
  const { data: ok } = await db().rpc("check_dispatcher_secret", { candidate: secret });
  if (!ok) return new Response("forbidden", { status: 403 });

  const now = new Date();
  const result: Record<string, unknown> = {};
  try {
    result.extract = await extractMemories(now);
    // ?consolidate=1 מאפשר הרצה ידנית לבדיקה
    if (toLocalParts(now).hour === 3 || new URL(req.url).searchParams.get("consolidate") === "1") {
      result.consolidate = await consolidateMemories(now);
    }
    console.log("memory-worker", result);
    return Response.json(result);
  } catch (e) {
    console.error("memory-worker failed", e);
    return new Response("error", { status: 500 });
  }
});
