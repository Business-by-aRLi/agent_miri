// חיבור Google Calendar. שני נתיבים:
//   /start?state=…    → הפניה למסך ההסכמה של Google (ה-state נוצר רק מ-/calendar בטלגרם)
//   /callback         → Google מחזיר לכאן; שומרים refresh token ב-Vault ויוצרים את היומן "משימות"
import { ensureTasksCalendar, exchangeCode, authUrl } from "../_shared/calendar.ts";
import { miriChatId, sendText } from "../_shared/channels/telegram.ts";
import { db } from "../_shared/db.ts";

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.6">` +
      `<h2>${title}</h2><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

async function validState(state: string | null): Promise<boolean> {
  if (!state) return false;
  const { data } = await db().from("oauth_states").select("expires_at, used_at").eq("state", state).eq("provider", "google")
    .maybeSingle();
  return !!data && !data.used_at && new Date(data.expires_at) > new Date();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");

  if (url.pathname.endsWith("/start")) {
    if (!await validState(state)) return page("הקישור פג תוקף", "שלחי שוב /calendar בטלגרם כדי לקבל קישור חדש.", 400);
    return Response.redirect(authUrl(state!), 302);
  }

  if (url.pathname.endsWith("/callback")) {
    if (url.searchParams.get("error")) return page("החיבור בוטל", "לא חובר כלום. אפשר לנסות שוב עם /calendar.");
    if (!await validState(state)) return page("הקישור פג תוקף", "שלחי שוב /calendar בטלגרם כדי לקבל קישור חדש.", 400);
    // state חד-פעמי: מסמנים לפני ההחלפה — רענון של הדף לא יחבר פעמיים
    await db().from("oauth_states").update({ used_at: new Date().toISOString() }).eq("state", state);

    try {
      const tokens = await exchangeCode(url.searchParams.get("code") ?? "");
      if (!tokens.refresh_token) throw new Error("Google לא החזיר refresh_token");
      const email = tokens.id_token ? JSON.parse(atob(tokens.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email : null;
      await db().rpc("set_google_refresh_token", { p_token: tokens.refresh_token });
      await db().from("settings").update({ gcal_connected_at: new Date().toISOString(), gcal_email: email }).eq("id", true);
      await ensureTasksCalendar();
      await sendText(
        miriChatId(),
        `📅 היומן מחובר${email ? ` (${email})` : ""}!\n\n` +
          "יצרתי יומן חדש בשם \"משימות\" — שם אשבץ דברים. ביומנים האחרים שלך אני רק מסתכל מתי את תפוסה, בלי לשנות כלום.\n\n" +
          "נסי: \"תשבץ לי את התיקונים לעקיבא\" או /today.",
      );
      return page("✅ היומן מחובר", "אפשר לסגור את החלון ולחזור לטלגרם.");
    } catch (e) {
      console.error("oauth callback failed", e);
      return page("משהו נכשל", "החיבור לא הושלם. אפשר לנסות שוב עם /calendar בטלגרם.", 500);
    }
  }

  return new Response("not found", { status: 404 });
});
