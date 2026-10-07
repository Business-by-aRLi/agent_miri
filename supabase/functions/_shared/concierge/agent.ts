// לולאת tool use של ה-Concierge.
//
// החלטה: כל הודעה של מירי = שיחת API חדשה, עם השיחה האחרונה כטקסט בתוך ה-context.
// על פני: לשמור היסטוריית API מצטברת (כולל thinking blocks) ולשלוח אותה שוב.
// למה: במודלים החדשים thinking block קשור לקידומת השיחה המדויקת — כל חלון נגלל, קיצור או הזרקת הקשר
// להודעה ישנה שוברים אותו (שגיאת 400). שיחה חדשה לכל הודעה היא append-only מעצם הגדרתה.
// Tradeoff: המודל לא רואה את ה-reasoning של תורות קודמות (רק את הטקסט), וה-cache חל רק על
// ה-system prompt והכלים. עבור ניהול משימות זה זניח; עלות ההקשר (~3-5K טוקנים) קטנה.
import Anthropic from "npm:@anthropic-ai/sdk@0";
import { db, requireEnv } from "../db.ts";
import { recall, type RecalledChunk } from "../memory/store.ts";
import { formatLocalIso, timeContext } from "../time.ts";
import { RunTrace } from "../trace.ts";
import { buildContext, type ContextInput, SYSTEM_PROMPT } from "./prompt.ts";
import { runTool, TOOLS } from "./tools.ts";

export const CONCIERGE_MODEL = "claude-sonnet-5-5";
const MAX_ITERATIONS = 8;
const RECENT_MESSAGES = 20;

let anthropic: Anthropic | null = null;
const client = () => (anthropic ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") }));

/** אוסף את כל מה שנכנס ל-<context>. */
export async function loadContext(userText: string, now: Date, excludeMessageId?: number): Promise<ContextInput> {
  const [profile, projects, tasks, recent, memories] = await Promise.all([
    db().from("core_profile").select("content").eq("approved", true).order("version", { ascending: false })
      .limit(1).maybeSingle(),
    db().from("projects").select("name, aliases").in("status", ["active", "paused"]).order("name"),
    db().from("tasks")
      .select("id, title, category, status, importance, urgency, due_at, projects(name)")
      .not("status", "in", "(done,dropped)")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(60),
    db().from("messages").select("id, role, content, created_at").order("id", { ascending: false })
      .limit(RECENT_MESSAGES + 1),
    recall(userText, { limit: 6 }).catch((e) => {
      console.error("context recall failed", e);
      return [] as RecalledChunk[];
    }),
  ]);
  for (const r of [profile, projects, tasks, recent]) if (r.error) throw r.error;

  const recentRows = (recent.data ?? []).filter((m) => m.id !== excludeMessageId).slice(0, RECENT_MESSAGES)
    .reverse();
  // זיכרון שכבר מופיע בשיחה האחרונה לא מוסיף מידע
  const recentTexts = new Set(recentRows.map((m) => (m.content as { text?: string }).text ?? ""));

  return {
    time: timeContext(now),
    profile: profile.data?.content ?? null,
    projects: (projects.data ?? []).map((p) =>
      p.aliases?.length ? `${p.name} (${(p.aliases as string[]).join(", ")})` : p.name
    ),
    // deno-lint-ignore no-explicit-any
    openTasks: (tasks.data ?? []).map((t: any) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      project: t.projects?.name ?? null,
      status: t.status,
      due_local: t.due_at ? formatLocalIso(new Date(t.due_at)) : null,
      importance: t.importance,
      urgency: t.urgency,
    })),
    memories: memories.filter((m) => !recentTexts.has(m.content)),
    recent: recentRows.map((m) => ({
      at: formatLocalIso(new Date(m.created_at)).replace("T", " "),
      who: m.role === "user" ? "מירי" as const : "סוכן" as const,
      text: (m.content as { text?: string }).text ?? "",
    })),
  };
}

export interface ConciergeResult {
  reply: string;
  toolNames: string[];
  runId: string;
}

export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;

export interface RunOptions {
  now?: Date;
  trigger?: string;
  excludeMessageId?: number;
  /** evals: הקשר קבוע במקום טעינה מה-DB */
  contextOverride?: ContextInput;
  /** evals: כלים מדומים — בלי כתיבה למשימות אמיתיות */
  toolRunner?: ToolRunner;
  /** evals: לא לרשום ב-runs */
  persist?: boolean;
}

export async function runConcierge(userText: string, opts: RunOptions = {}): Promise<ConciergeResult & { toolCalls: Array<{ name: string; input: unknown }>; costUsd: number }> {
  const now = opts.now ?? new Date();
  const trace = new RunTrace("concierge", opts.trigger ?? "telegram");
  try {
    const context = opts.contextOverride ?? await loadContext(userText, now, opts.excludeMessageId);
    const messages: Anthropic.MessageParam[] = [{
      role: "user",
      content: [
        { type: "text", text: buildContext(context) },
        { type: "text", text: `<message>\n${userText}\n</message>` },
      ],
    }];

    let reply = "";
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // fallbacks: "default" — אם מסווג בטיחות דוחה בטעות, ה-API מריץ שוב על מודל חלופי באותה קריאה
      const response = await client().beta.messages.create({
        model: CONCIERGE_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        // deno-lint-ignore no-explicit-any
        fallbacks: "default" as any,
        output_config: { effort: "medium" },
        // system ו-tools קבועים לגמרי → נשמרים ב-cache בין הודעות
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
      // deno-lint-ignore no-explicit-any
      } as any) as Anthropic.Beta.BetaMessage;

      trace.addUsage(response.model ?? CONCIERGE_MODEL, response.usage);
      // append-only: התגובה נכנסת כמו שהיא, כולל thinking blocks
      messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

      const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text)
        .join("\n").trim();

      if (response.stop_reason === "refusal") {
        reply = "לא הצלחתי לטפל בבקשה הזו. אפשר לנסח אחרת?";
        break;
      }
      if (response.stop_reason !== "tool_use") {
        reply = text || "(אין תשובה)";
        if (response.stop_reason === "max_tokens") reply += "\n\n(התשובה נקטעה)";
        break;
      }

      // כל קריאות הכלים מתבצעות במקביל, וכל התוצאות חוזרות בהודעה אחת
      const toolUses = response.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      const results = await Promise.all(toolUses.map(async (tu) => {
        const r = await (opts.toolRunner ?? runTool)(tu.name, tu.input as Record<string, unknown>);
        trace.addToolCall(tu.name, tu.input, !r.isError);
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: r.content,
          is_error: r.isError,
        };
      }));
      messages.push({ role: "user", content: results });

      if (i === MAX_ITERATIONS - 1) reply = text || "הגעתי למגבלת הצעדים. כדאי לבדוק עם /today מה נשמר.";
    }

    if (opts.persist !== false) await trace.save();
    return { reply, toolNames: trace.toolNames, runId: trace.id, toolCalls: trace.calls, costUsd: trace.cost };
  } catch (e) {
    if (opts.persist !== false) await trace.save(e);
    throw e;
  }
}
