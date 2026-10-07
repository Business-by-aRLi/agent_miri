// לקוח Anthropic משותף לכל הפונקציות.
import Anthropic from "npm:@anthropic-ai/sdk@0";
import { requireEnv } from "./db.ts";

let client: Anthropic | null = null;
export const anthropic = () => (client ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") }));

/** מחזיר את הטקסט של תשובה (רק בלוקי text, ברצף). */
export function responseText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}
