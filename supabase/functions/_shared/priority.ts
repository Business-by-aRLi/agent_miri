// ניקוד עדיפות — טהור. ה-LLM קובע importance/urgency; הקוד מחשב את הציון.
// למה בקוד: מיון עקבי וניתן להסבר. אותה משימה תקבל אותו ציון היום ומחר (למעט קרבת המועד, בכוונה).

export interface PriorityInput {
  importance: number; // 1-3
  urgency: number; // 1-3
  due_at: string | null;
  snooze_count: number;
}

/**
 * ציון 0-100 בערך.
 * - חשיבות × דחיפות: עד 45 (חשיבות שוקלת קצת יותר — "חשוב ולא דחוף" עדיף על "דחוף ולא חשוב").
 * - קרבת מועד: עד 40. באיחור = מקסימום; היום ≈ 32; בעוד שבוע ≈ 8; בלי מועד = 0.
 * - דחיות: עד 10. משימה שנדחתה שוב ושוב עולה — כדי שלא תיעלם בתחתית לנצח.
 */
export function priorityScore(t: PriorityInput, now: Date): number {
  const base = (t.importance * 2 + t.urgency) / 9 * 45;
  let dueScore = 0;
  if (t.due_at) {
    const hours = (new Date(t.due_at).getTime() - now.getTime()) / 3600_000;
    dueScore = hours <= 0 ? 40 : Math.max(0, 40 * Math.exp(-hours / 72));
  }
  const snooze = Math.min(t.snooze_count, 5) * 2;
  return Math.round((base + dueScore + snooze) * 10) / 10;
}

export function byPriority<T extends PriorityInput>(tasks: T[], now: Date): T[] {
  return [...tasks].sort((a, b) => priorityScore(b, now) - priorityScore(a, now));
}
