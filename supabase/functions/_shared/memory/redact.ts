// הסרת סודות מטקסט לפני שמירה בזיכרון ולפני embedding.
// למה: זיכרון נשלף חזרה לפרומפטים עתידיים — סוד שנשמר פעם אחת ידלוף לכל שיחה אחריו.
// עדיף להחמיר (false positive = מחרוזת אקראית שהוסתרה) מאשר לפספס מפתח.

const PATTERNS: Array<[RegExp, string]> = [
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
  // שם משתנה שנראה כמו סוד, ואחריו ערך: API_KEY=..., "password": "..."
  [
    /(\b[A-Za-z_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|_KEY)[A-Za-z_]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
    "$1[REDACTED]",
  ],
  // מחרוזת hex ארוכה בודדת (מפתחות, hashes של סודות)
  [/\b[a-f0-9]{40,}\b/gi, "[HEX_SECRET]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
