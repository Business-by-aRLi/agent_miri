// שמירה ושליפה מהזיכרון (knowledge_chunks).
import { db } from "../db.ts";
import { embed, toPgVector } from "./embeddings.ts";
import { redact } from "./redact.ts";

export interface ChunkInput {
  source: "telegram" | "claude_code" | "claude_ai" | "document";
  sourceRef: string;
  speaker: "miri" | "agent" | "claude" | "other";
  content: string;
  projectId?: string | null;
  occurredAt?: Date;
}

/**
 * שומר יחידת טקסט (אחרי redact). אידמפוטנטי לפי (source, source_ref). embedding מחושב בנפרד.
 * replace: לתוכן שמתעדכן (סיכום מתגלגל של סשן) — דורס ומאפס את ה-embedding כדי שיחושב מחדש.
 */
export async function saveChunk(c: ChunkInput, opts: { replace?: boolean } = {}): Promise<void> {
  const content = redact(c.content).trim();
  if (!content) return;
  const row: Record<string, unknown> = {
    source: c.source,
    source_ref: c.sourceRef,
    speaker: c.speaker,
    content,
    project_id: c.projectId ?? null,
    occurred_at: (c.occurredAt ?? new Date()).toISOString(),
  };
  if (opts.replace) row.embedding = null;
  const { error } = await db().from("knowledge_chunks").upsert(row, {
    onConflict: "source,source_ref",
    ignoreDuplicates: !opts.replace,
  });
  if (error) throw error;
}

/** מחלק טקסט ארוך לקטעים בגבולות פסקה — embedding של קטע ממוקד מדויק יותר משל מסמך שלם. */
export function splitForMemory(text: string, max = 1800): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && (cur.length + para.length + 2) > max) {
      out.push(cur);
      cur = "";
    }
    if (para.length > max) {
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * מחשב embeddings לכל מה שעוד חסר.
 * למה בנפרד מהשמירה: אם Voyage נופל, הטקסט כבר שמור — וייקלט בהרצה הבאה.
 */
export async function embedPending(limit = 64): Promise<number> {
  const { data, error } = await db()
    .from("knowledge_chunks")
    .select("id, content")
    .is("embedding", null)
    .order("created_at")
    .limit(limit);
  if (error) throw error;
  if (!data?.length) return 0;
  const vectors = await embed(data.map((r) => r.content), "document");
  await Promise.all(
    data.map((r, i) =>
      db().from("knowledge_chunks").update({ embedding: toPgVector(vectors[i]) }).eq("id", r.id).then(
        ({ error }) => {
          if (error) throw error;
        },
      )
    ),
  );
  return data.length;
}

export interface RecalledChunk {
  id: string;
  source: string;
  speaker: string | null;
  project_id: string | null;
  content: string;
  occurred_at: string;
  score: number;
}

/** חיפוש היברידי (משמעות + טקסט). אם ה-embedding נכשל — חוזר רק לחיפוש טקסטואלי. */
export async function recall(
  query: string,
  opts: { limit?: number; projectId?: string | null; source?: string | null } = {},
): Promise<RecalledChunk[]> {
  let vector: string | null = null;
  try {
    [vector] = (await embed([query], "query")).map(toPgVector);
  } catch (e) {
    console.error("recall: embedding failed, lexical only", e);
  }
  const { data, error } = await db().rpc("recall_chunks", {
    query_embedding: vector,
    query_text: query,
    match_count: opts.limit ?? 8,
    filter_project: opts.projectId ?? null,
    filter_source: opts.source ?? null,
  });
  if (error) throw error;
  return (data ?? []) as RecalledChunk[];
}
