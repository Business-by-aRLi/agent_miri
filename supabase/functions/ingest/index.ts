// קליטת שיחות מ-Claude Code במחשב של מירי (נשלח מה-hook).
// אימות: X-Ingest-Secret. המחשב לא מחזיק את מפתח ה-service role — רק את הסוד הזה, שמאפשר רק כתיבה לזיכרון.
// אידמפוטנטי: כל הודעה נשמרת לפי ה-uuid שלה בתמליל, כך ששליחה כפולה לא יוצרת כפילויות.
import { db, requireEnv } from "../_shared/db.ts";
import { embedPending, saveChunk, splitForMemory } from "../_shared/memory/store.ts";
import { summarizeSession } from "../_shared/work/summarize.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const SUMMARIZE_EVERY = 16; // הודעות שמצטברות לפני עדכון סיכום (או בסוף סשן)

interface Entry {
  uuid: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
}
interface Payload {
  source: "claude_code";
  session_id: string;
  cwd: string;
  ended?: boolean;
  entries: Entry[];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("X-Ingest-Secret") !== requireEnv("INGEST_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (body.source !== "claude_code" || !body.session_id || !Array.isArray(body.entries)) {
    return new Response("bad payload", { status: 400 });
  }
  const entries = body.entries.filter((e) => e.uuid && e.text?.trim() && (e.role === "user" || e.role === "assistant"))
    .slice(0, 500);

  const { data: projectId } = await db().rpc("find_project_by_path", { cwd: body.cwd ?? "" });

  for (const e of entries) {
    const parts = splitForMemory(e.text);
    for (let i = 0; i < parts.length; i++) {
      await saveChunk({
        source: "claude_code",
        sourceRef: `${body.session_id}:${e.uuid}:${i}`,
        speaker: e.role === "user" ? "miri" : "claude",
        content: parts[i],
        projectId: projectId ?? null,
        occurredAt: new Date(e.ts),
      });
    }
  }

  const lastAt = entries.at(-1)?.ts ?? new Date().toISOString();
  const { data: ep, error } = await db().rpc("touch_episode", {
    p_session: body.session_id,
    p_cwd: body.cwd,
    p_project: projectId ?? null,
    p_count: entries.length,
    p_at: lastAt,
    p_ended: !!body.ended,
  });
  if (error) {
    console.error("touch_episode failed", error);
    return new Response("error", { status: 500 });
  }

  const shouldSummarize = ep.pending_entries > 0 && (body.ended || ep.pending_entries >= SUMMARIZE_EVERY);
  EdgeRuntime.waitUntil((async () => {
    // embeddings קודם (זול ומהיר), אחר כך סיכום
    for (let i = 0; i < 5 && await embedPending(96) > 0; i++);
    if (shouldSummarize) await summarizeSession(body.session_id);
  })().catch((e) => console.error("ingest background failed", e)));

  return Response.json({ ok: true, saved: entries.length, project: projectId ?? null, summarize: shouldSummarize });
});
