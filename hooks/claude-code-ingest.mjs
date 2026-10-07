#!/usr/bin/env node
// Claude Code hook (Stop + SessionEnd): שולח למוח של הסוכן את ההודעות החדשות מהשיחה.
//
// מה נשלח: רק טקסט שמירי כתבה וטקסט ש-Claude ענה. לא תוכן קבצים, לא פלט פקודות, לא thinking, לא סשנים של subagents.
// סודות מוסרים כאן, לפני שהטקסט יוצא מהמחשב (ושוב בשרת).
// רק הודעות שנכתבו אחרי ההתקנה (config.since) — לבקשת מירי, בלי היסטוריה.
//
// ה-hook חייב להיות מהיר ולא לשבור את Claude Code: הוא מעביר את העבודה לתהליך רקע ויוצא מיד, וכל שגיאה נבלעת ל-log.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = path.join(os.homedir(), ".claude", "agent-miri");
const CONFIG = path.join(HOME, "config.json");
const CURSORS = path.join(HOME, "cursors.json");
const LOG = path.join(HOME, "ingest.log");
const MAX_ENTRIES = 300;

const log = (msg) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* אין מה לעשות */ }
};

// ---------- שלב 2: worker ----------

// אותם דפוסים כמו supabase/functions/_shared/memory/redact.ts — לשמור מסונכרן
const PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[API_KEY]"],
  [/\bpa-[A-Za-z0-9_-]{30,}/g, "[VOYAGE_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[GOOGLE_KEY]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[STRIPE_KEY]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[TELEGRAM_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY]"],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s]+@/g, "$1://[USER]:[PASSWORD]@"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, "$1[TOKEN]"],
  [/(\b[A-Za-z_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|_KEY)[A-Za-z_]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[REDACTED]"],
  [/\b[a-f0-9]{40,}\b/gi, "[HEX_SECRET]"],
];
const redact = (t) => PATTERNS.reduce((s, [re, r]) => s.replace(re, r), t);

/** מוציא מהשורה בתמליל רק טקסט אנושי של מירי או תשובה של Claude. */
function extract(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if ((j.type !== "user" && j.type !== "assistant") || j.isSidechain || j.isMeta || !j.uuid) return null;
  const content = j.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  let text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!text) return null;
  if (j.type === "user") {
    // רק מה שמירי הקלידה: לא תוצאות כלים, לא הודעות מערכת/פקודות שמוזרקות כ-user
    if (j.origin && j.origin.kind !== "human") return null;
    if (text.startsWith("<")) return null;
  }
  return { uuid: j.uuid, role: j.type, text: redact(text), ts: j.timestamp, cwd: j.cwd };
}

async function worker(payloadFile) {
  const hook = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
  fs.rmSync(payloadFile, { force: true });
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  if (config.disabled) return;

  const transcript = hook.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return;

  // cursor = כמה שורות כבר טופלו בתמליל הזה (התמליל רק מתארך)
  const cursors = fs.existsSync(CURSORS) ? JSON.parse(fs.readFileSync(CURSORS, "utf8")) : {};
  const lines = fs.readFileSync(transcript, "utf8").split("\n");
  // השורה האחרונה היא "" (סוף קובץ) או שורה שעוד נכתבת — בשני המקרים לא מעבדים אותה עכשיו
  const complete = lines.length - 1;
  const from = cursors[transcript] ?? 0;
  if (from >= complete && !hook.hook_event_name?.startsWith("SessionEnd")) return;

  const since = new Date(config.since).getTime();
  const entries = [];
  let cwd = hook.cwd;
  for (let i = from; i < complete; i++) {
    const e = extract(lines[i]);
    if (!e || new Date(e.ts).getTime() < since) continue;
    cwd = e.cwd ?? cwd;
    entries.push({ uuid: e.uuid, role: e.role, text: e.text, ts: e.ts });
  }

  const ended = hook.hook_event_name === "SessionEnd";
  if (entries.length || ended) {
    // בקבוצות — סשן ארוך שמתעדכן לראשונה לא ישלח בקשה ענקית
    for (let i = 0; i < Math.max(entries.length, 1); i += MAX_ENTRIES) {
      const batch = entries.slice(i, i + MAX_ENTRIES);
      const last = i + MAX_ENTRIES >= entries.length;
      const res = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Ingest-Secret": config.secret },
        body: JSON.stringify({ source: "claude_code", session_id: hook.session_id, cwd, ended: ended && last, entries: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log(`ingest ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return; // לא מקדמים cursor — ננסה שוב בפעם הבאה
      }
    }
  }

  // קריאה-מחדש לפני כתיבה: כמה סשנים יכולים לרוץ במקביל
  const fresh = fs.existsSync(CURSORS) ? JSON.parse(fs.readFileSync(CURSORS, "utf8")) : {};
  fresh[transcript] = Math.max(fresh[transcript] ?? 0, complete);
  fs.writeFileSync(CURSORS, JSON.stringify(fresh, null, 2));
  if (entries.length) log(`sent ${entries.length} from ${hook.session_id}${ended ? " (ended)" : ""}`);
}

// ---------- נקודת כניסה (בסוף הקובץ: כל ההגדרות למעלה כבר מאותחלות) ----------
// hook: קורא stdin, מעביר ל-worker ברקע, יוצא מיד
if (process.argv[2] !== "--worker") {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const file = path.join(os.tmpdir(), `agent-miri-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(file, input);
      spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", file], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch (e) {
      log(`spawn failed: ${e}`);
    }
    process.exit(0);
  });
} else {
  worker(process.argv[3]).catch((e) => log(`worker failed: ${e?.stack ?? e}`));
}
