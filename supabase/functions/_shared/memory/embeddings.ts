// Embeddings דרך Voyage (voyage-3.5, 1024 ממדים — תואם לעמודה ב-knowledge_chunks).
// input_type שונה למסמך ולשאילתה: Voyage מכייל כל צד אחרת, וזה משפר את איכות השליפה.
import { requireEnv } from "../db.ts";

const MODEL = "voyage-3.5";
export const EMBEDDING_DIM = 1024;

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${requireEnv("VOYAGE_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: texts, input_type: inputType, output_dimension: EMBEDDING_DIM }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const json = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** pgvector מקבל וקטור כמחרוזת "[0.1,0.2,...]". */
export const toPgVector = (v: number[]) => `[${v.join(",")}]`;
