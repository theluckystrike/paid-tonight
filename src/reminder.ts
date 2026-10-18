import type { AiRunner, UnpaidInvoice } from "./types.js";

export type { AiRunner } from "./types.js";

const DAY_MS = 86_400_000;
const MAX_NOTE = 400;
const MAX_SUBJECT = 120;

const SYSTEM_PROMPT = `You write a short payment reminder for an unpaid invoice. Reply with a single JSON object and nothing else, no markdown fences, no commentary:
{"subject": string, "note": string}

Rules:
- The note is 2 to 4 sentences.
- The note refers to the work the customer already received and the amount they owe, and tells them to use the payment link in the email.
- Match the requested tone. A "friendly" reminder is warm and light; a "firm" reminder is direct but still respectful.
- No threats, no mention of legal action or collections, no emojis, no ALL CAPS.
- Only call the invoice overdue when "Days overdue" is a number above 0. Otherwise say it is due now.
- Write like a person, not a template. No opener like "We hope you're enjoying", no colons, no dashes, no semicolons.
- The subject must contain the invoice number.`;

interface ParsedReminder {
  subject?: string;
  note?: string;
}

function daysOverdue(dueDate: string | null, today: string): number {
  if (!dueDate) return 0;
  const due = Date.parse(dueDate.slice(0, 10) + "T00:00:00Z");
  const now = Date.parse(today.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  // PayPal sets the due date in the seller's time zone (often US time), so a day of grace keeps an invoice sent today
  // from reading as overdue in UTC. It counts as overdue only once its due date has ended everywhere.
  return Math.max(0, Math.floor((now - due) / DAY_MS) - 1);
}

function computeTone(days: number): "friendly" | "firm" {
  return days > 14 ? "firm" : "friendly";
}

function stripEmoji(text: string): string {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/\p{Emoji_Presentation}/gu, "").replace(/\s+/g, " ").trim();
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseReminder(output: string): ParsedReminder | null {
  let text = output.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  if (fence) text = fence[1]!.trim();
  let parsed = tryParse(text);
  if (!parsed || typeof parsed !== "object") {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1));
  }
  return parsed && typeof parsed === "object" ? (parsed as ParsedReminder) : null;
}

function fallbackNote(inv: UnpaidInvoice): string {
  return `This is a reminder that invoice ${inv.number} for ${inv.total} ${inv.currency} is still unpaid. Please use the payment link in this email when you are ready.`;
}

function sanitizeSubject(subject: string | undefined, number: string): string {
  const clean = stripEmoji(subject ?? "").slice(0, MAX_SUBJECT);
  if (!clean || !clean.includes(number)) return `Reminder: invoice ${number}`;
  return clean;
}

function sanitizeNote(note: string | undefined, inv: UnpaidInvoice): string {
  const clean = stripEmoji(note ?? "").slice(0, MAX_NOTE);
  return clean || fallbackNote(inv).slice(0, MAX_NOTE);
}

export async function draftReminder(
  inv: UnpaidInvoice,
  ai: AiRunner,
  today: string,
): Promise<{ subject: string; note: string; tone: "friendly" | "firm" }> {
  const days = daysOverdue(inv.dueDate, today);
  const tone = computeTone(days);
  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Today's date: ${today}.\nTone: ${tone}.\nCustomer: ${inv.customerName}.\n` +
        `Invoice number: ${inv.number}.\nAmount due: ${inv.total} ${inv.currency}.\n` +
        `Days overdue: ${days <= 0 ? "not overdue" : days}.\nWrite the reminder.`,
    },
  ];
  const raw = await ai(messages);
  const parsed = parseReminder(raw);
  const subject = sanitizeSubject(parsed?.subject, inv.number);
  const note = sanitizeNote(parsed?.note ?? raw, inv);
  return { subject, note, tone };
}
