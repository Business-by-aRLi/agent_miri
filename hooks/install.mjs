#!/usr/bin/env node
// מתקין את ה-hook של Claude Code במחשב של מירי.
// הרצה מתיקיית הריפו:  node hooks/install.mjs           (התקנה / עדכון)
//                      node hooks/install.mjs --disable  (כיבוי בלי למחוק)
//
// מה הוא עושה:
// 1. מעתיק את claude-code-ingest.mjs ל-~/.claude/agent-miri/ (כך שה-hook לא תלוי במיקום הריפו)
// 2. כותב config.json עם כתובת ה-ingest והסוד (מ-.env) ו-since = עכשיו — רק שיחות מעכשיו והלאה
// 3. מוסיף ל-~/.claude/settings.json hooks של Stop ו-SessionEnd, בלי לגעת בשאר ההגדרות (וגיבוי לפני)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE = path.join(os.homedir(), ".claude");
const HOME = path.join(CLAUDE, "agent-miri");
const SETTINGS = path.join(CLAUDE, "settings.json");
const TARGET = path.join(HOME, "claude-code-ingest.mjs");
const CONFIG = path.join(HOME, "config.json");
const URL = "https://nklintfbsfagcwlbfwob.supabase.co/functions/v1/ingest";

fs.mkdirSync(HOME, { recursive: true });

if (process.argv.includes("--disable")) {
  const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  fs.writeFileSync(CONFIG, JSON.stringify({ ...c, disabled: true }, null, 2));
  console.log("כובה. להפעלה מחדש: node hooks/install.mjs");
  process.exit(0);
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(REPO, ".env"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.INGEST_SECRET) throw new Error("חסר INGEST_SECRET ב-.env");

fs.copyFileSync(path.join(REPO, "hooks", "claude-code-ingest.mjs"), TARGET);

// since נשמר מההתקנה הראשונה — עדכון של הסקריפט לא "מוחק" שיחות שכבר נקלטו
const prev = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};
const config = { url: URL, secret: env.INGEST_SECRET, since: prev.since ?? new Date().toISOString() };
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });

const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, "utf8")) : {};
if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-agent-miri`);

const command = `"${process.execPath}" "${TARGET}"`;
const ours = (h) => JSON.stringify(h).includes("agent-miri");
settings.hooks ??= {};
for (const event of ["Stop", "SessionEnd"]) {
  const list = (settings.hooks[event] ?? []).filter((m) => !ours(m)); // מחליף גרסה קודמת שלנו, לא נוגע באחרים
  list.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  settings.hooks[event] = list;
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");

console.log("✓ hook הותקן");
console.log(`  סקריפט:  ${TARGET}`);
console.log(`  נקלט מ:  ${config.since}`);
console.log(`  log:     ${path.join(HOME, "ingest.log")}`);
console.log(`  הגדרות:  ${SETTINGS} (גיבוי: settings.json.bak-agent-miri)`);
