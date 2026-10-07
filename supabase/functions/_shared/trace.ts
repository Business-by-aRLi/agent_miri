// רישום ריצות ועלות. כל קריאה ל-LLM נרשמת — "אין קופסה שחורה".
import { db } from "./db.ts";

// $ למיליון טוקנים. כתיבה ל-cache = 1.25× קלט (TTL של 5 דקות).
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.cacheRead +
    u.output_tokens * p.output) / 1_000_000;
}

/** מצטבר לאורך לולאת tool use אחת ונכתב פעם אחת בסוף. */
export class RunTrace {
  readonly id = crypto.randomUUID();
  private started = Date.now();
  private totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private toolCalls: Array<{ name: string; input: unknown; ok: boolean }> = [];
  private model: string | null = null;

  constructor(private layer: "concierge" | "executor" | "background", private trigger: string) {}

  addUsage(model: string, u: Usage) {
    this.model = model;
    this.totals.input += u.input_tokens;
    this.totals.output += u.output_tokens;
    this.totals.cacheRead += u.cache_read_input_tokens ?? 0;
    this.totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.totals.cost += costUsd(model, u);
  }

  addToolCall(name: string, input: unknown, ok: boolean) {
    this.toolCalls.push({ name, input, ok });
  }

  get toolNames() {
    return this.toolCalls.map((t) => t.name);
  }

  async save(error?: unknown): Promise<void> {
    const { error: dbError } = await db().from("runs").insert({
      id: this.id,
      layer: this.layer,
      trigger: this.trigger,
      model: this.model,
      input_tokens: this.totals.input,
      output_tokens: this.totals.output,
      cache_read_tokens: this.totals.cacheRead,
      cache_write_tokens: this.totals.cacheWrite,
      cost_usd: this.totals.cost,
      tool_calls: this.toolCalls,
      latency_ms: Date.now() - this.started,
      error: error ? String(error instanceof Error ? error.stack ?? error.message : error) : null,
    });
    if (dbError) console.error("trace save failed", dbError);
  }
}
