// ערוץ טלגרם. כל שליחה לטלגרם עוברת כאן — כך שהוספת ערוץ נוסף (WhatsApp) לא תיגע בלוגיקה.
import { requireEnv } from "../db.ts";

const MAX_LEN = 4096; // מגבלת טלגרם להודעה

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result as T;
}

/** מפצל טקסט ארוך בגבולות שורה, כדי לא לחתוך באמצע משפט. */
export function splitMessage(text: string, max = MAX_LEN): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > max && current) {
      parts.push(current);
      current = "";
    }
    // שורה בודדת ארוכה מדי — חיתוך קשיח
    let rest = line;
    while (rest.length > max) {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    current = current ? `${current}\n${rest}` : rest;
  }
  if (current) parts.push(current);
  return parts;
}

export async function sendText(chatId: number | string, text: string): Promise<number[]> {
  const ids: number[] = [];
  for (const part of splitMessage(text)) {
    const msg = await call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: part,
      link_preview_options: { is_disabled: true },
    });
    ids.push(msg.message_id);
  }
  return ids;
}

export async function sendTyping(chatId: number | string): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

export const miriChatId = () => Number(requireEnv("MIRI_CHAT_ID"));

// טיפוסים מינימליים — רק מה שאנחנו קוראים מהעדכון
export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  voice?: unknown;
  photo?: unknown;
  document?: unknown;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage; from: { id: number } };
}
