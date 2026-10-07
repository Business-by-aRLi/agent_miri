// לקוח Supabase עם service role — הדרך היחידה לגשת לנתונים (RLS חוסם כל השאר).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`חסר משתנה סביבה: ${name}`);
  return v;
}
