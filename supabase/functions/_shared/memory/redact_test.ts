import { assertEquals, assertStringIncludes } from "@std/assert";
import { redact } from "./redact.ts";

Deno.test("redact: מפתחות מוכרים", () => {
  const cases: Array<[string, string]> = [
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "[ANTHROPIC_KEY]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[GITHUB_TOKEN]"],
    ["AKIAIOSFODNN7EXAMPLE", "[AWS_KEY]"],
    ["7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1", "[TELEGRAM_TOKEN]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[JWT]"],
    ["sk_live_abcdefghijklmnop1234", "[STRIPE_KEY]"],
  ];
  for (const [input, marker] of cases) assertStringIncludes(redact(input), marker);
});

Deno.test("redact: משתנה סביבה ו-JSON", () => {
  assertEquals(redact("SUPABASE_SERVICE_ROLE_KEY=abc123def456"), "SUPABASE_SERVICE_ROLE_KEY=[REDACTED]");
  assertEquals(redact('"password": "hunter22"'), '"password": "[REDACTED]"');
  assertEquals(redact("VOYAGE_API_KEY: pa-xyz12345"), "VOYAGE_API_KEY: [REDACTED]");
});

Deno.test("redact: connection string", () => {
  assertEquals(
    redact("postgresql://postgres:S3cret!@db.x.supabase.co:5432/postgres"),
    "postgresql://[USER]:[PASSWORD]@db.x.supabase.co:5432/postgres",
  );
});

Deno.test("redact: טקסט רגיל לא נפגע", () => {
  const text = "צריך לשלוח ל-WigPro את ההצעה עד יום חמישי, 3 פריטים ב-450 ₪. commit a1b2c3d";
  assertEquals(redact(text), text);
  assertEquals(redact("the token count was 1500"), "the token count was 1500");
});
