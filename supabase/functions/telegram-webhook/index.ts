// נקודת הכניסה מטלגרם.
// סדר הפעולות: אימות → dedupe → 200 מיד → עיבוד ברקע.
// למה 200 מיד: טלגרם שולח שוב כל עדכון שלא אושר תוך זמן קצר, ותשובת LLM לוקחת שניות.
import { runConcierge } from "../_shared/concierge/agent.ts";
import { calendarConnectText, HELP_TEXT, memoryText, todayText } from "../_shared/commands.ts";
import { db, requireEnv } from "../_shared/db.ts";
import { miriChatId, sendText, sendTyping, type TgMessage, type TgUpdate } from "../_shared/channels/telegram.ts";
import { embedPending, saveChunk } from "../_shared/memory/store.ts";
import { handleCallback } from "../_shared/reminders/service.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  // אימות 1: רק טלגרם יודע את הסוד שהגדרנו ב-setWebhook
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== requireEnv("TELEGRAM_WEBHOOK_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await req.json() as TgUpdate;
  const msg = update.message;
  const cb = update.callback_query;

  // אימות 2: רק מירי. כל השאר מתעלמים בשקט (200 — כדי שטלגרם לא ישלח שוב)
  const fromMiri = msg
    ? msg.chat.id === miriChatId() && msg.chat.type === "private"
    : cb?.from.id === miriChatId();
  if (!fromMiri) return new Response("ok");

  // dedupe: אם ה-update_id כבר נקלט — זו שליחה חוזרת
  const { error } = await db().from("telegram_updates").insert({ update_id: update.update_id });
  if (error) {
    if (error.code === "23505") return new Response("ok");
    console.error("dedupe insert failed", error);
    return new Response("error", { status: 500 }); // טלגרם ינסה שוב
  }

  // כפתורים: קוד בלבד, בלי LLM
  if (cb) EdgeRuntime.waitUntil(handleCallback(cb).catch((e) => console.error("callback failed", e)));
  else if (msg) EdgeRuntime.waitUntil(handle(msg).catch((e) => console.error("handle failed", e)));
  return new Response("ok");
});

async function handle(msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();

  try {
    if (text.startsWith("/")) return await handleCommand(chatId, text);

    if (!text) {
      const kind = msg.voice ? "הודעות קוליות" : msg.photo ? "תמונות" : msg.document ? "קבצים" : "סוג הודעה זה";
      await sendText(chatId, `${kind} עוד לא נתמכים — יגיעו בשלב הבא. בינתיים אפשר לכתוב בטקסט.`);
      return;
    }

    await sendTyping(chatId);
    const userMessageId = await saveMessage("user", { text, telegram_message_id: msg.message_id });
    const sentAt = new Date(msg.date * 1000);
    await saveChunk({ source: "telegram", sourceRef: `msg:${userMessageId}`, speaker: "miri", content: text, occurredAt: sentAt });

    const result = await runConcierge(text, { now: new Date(), excludeMessageId: userMessageId });
    await sendText(chatId, result.reply);

    const replyId = await saveMessage("assistant", { text: result.reply, tools: result.toolNames }, result.runId);
    await saveChunk({ source: "telegram", sourceRef: `msg:${replyId}`, speaker: "agent", content: result.reply });
    await tagConversation(result.toolCalls, [`msg:${userMessageId}`, `msg:${replyId}`]);
  } catch (e) {
    console.error(e);
    await sendText(chatId, "משהו נכשל אצלי ולא טיפלתי בהודעה. אפשר לשלוח שוב בעוד רגע.").catch(() => {});
  } finally {
    // embeddings אחרי התשובה — לא מעכבים את מירי. מה שנכשל כאן ייקלט בהודעה הבאה.
    await embedPending().catch((e) => console.error("embedPending failed", e));
  }
}

async function handleCommand(chatId: number, text: string): Promise<void> {
  const command = text.split(/[\s@]/)[0].toLowerCase();
  switch (command) {
    case "/today":
      await sendText(chatId, await todayText());
      return;
    case "/memory":
      await sendText(chatId, await memoryText());
      return;
    case "/calendar":
      await sendText(chatId, await calendarConnectText());
      return;
    case "/start":
    case "/help":
      await sendText(chatId, HELP_TEXT);
      return;
    default:
      await sendText(chatId, `פקודה לא מוכרת: ${command}\n\n${HELP_TEXT}`);
  }
}

/**
 * תיוג אוטומטי: אם כל הכלים בתור הזה עסקו בפרויקט אחד — ההודעה והתשובה שייכות אליו.
 * למה רק כשיש פרויקט יחיד: הודעה שנגעה בשני פרויקטים לא שייכת לאף אחד מהם במלואה; עדיף בלי תג מאשר תג שגוי.
 */
async function tagConversation(calls: Array<{ input: unknown }>, sourceRefs: string[]): Promise<void> {
  const names = new Set(
    calls.map((c) => (c.input as { project?: unknown })?.project).filter((p): p is string => typeof p === "string" && !!p),
  );
  const ids = new Set<string>();
  for (const name of names) {
    const { data } = await db().rpc("find_project", { q: name });
    if (data?.[0]?.id) ids.add(data[0].id);
  }
  if (ids.size !== 1) return;
  const [projectId] = ids;
  const { error } = await db().from("knowledge_chunks").update({ project_id: projectId })
    .eq("source", "telegram").in("source_ref", sourceRefs).is("project_id", null);
  if (error) console.error("tagConversation failed", error);
}

async function saveMessage(role: "user" | "assistant", content: Record<string, unknown>, runId?: string) {
  const { data, error } = await db().from("messages").insert({ role, content, run_id: runId ?? null }).select("id")
    .single();
  if (error) throw error;
  return data.id as number;
}
