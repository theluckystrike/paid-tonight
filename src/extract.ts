import { z, type ZodError } from "zod";
import { ExtractError } from "./types.js";
import type { AiRunner, InvoiceDraft, LineItem } from "./types.js";

export type { AiRunner } from "./types.js";

const CURRENCIES = new Set(["USD", "EUR", "GBP", "PLN", "CAD", "AUD"]);

const QTY_MAX_SCALED = 1_000_000n * 1000n; // quantity < 1,000,000
const AMOUNT_MAX_SCALED = 1_000_000_000n * 100n; // unit amount < 1,000,000,000
const TAX_MAX_SCALED = 3000n; // 30.00 %

interface RawDraft {
  customerName?: string;
  customerEmail?: string | null;
  currency?: string;
  items: RawItem[];
  taxPercent?: string | null;
  note?: string | null;
}

interface RawItem {
  name: string;
  quantity: string;
  unitAmount: string;
  unit?: string | null;
}

const SYSTEM_PROMPT = `You extract structured invoice data from a tradesperson's spoken or typed description of a completed job.
Reply with a single JSON object and nothing else: no markdown fences, no commentary, no code.

The object must match this shape:
{
  "customerName": string,
  "customerEmail": string | null,
  "currency": "USD" | "EUR" | "GBP" | "PLN" | "CAD" | "AUD",
  "items": [
    { "name": string, "quantity": number-or-string, "unitAmount": number-or-string, "unit": "HOURS" | "AMOUNT" | "QUANTITY" | null }
  ],
  "taxPercent": number-or-string | null,
  "note": string | null
}

Rules:
- quantity and unitAmount are plain decimal numbers with no currency symbol and no thousands separators. unitAmount is the price PER unit.
- unit is "HOURS" for labour billed by the hour, "QUANTITY" for a count of physical things, "AMOUNT" for a flat fee, or null.
- taxPercent is the VAT/tax percentage (for example 23, NOT 0.23). Use null only when the description mentions no tax.
- customerEmail is null when no email is mentioned. customerName is "" when no name is mentioned.
- currency defaults to "USD" when the description names no currency.
- note is a short job note, or null when there is nothing beyond the line items.
- NEVER compute or return any totals. Do not add subtotal, tax amount or total fields.

Worked example 1 (hours x rate):
Description: "Fixed a leaking radiator for Bob, bob@example.com. 3 hours at 40 an hour, plus 20 percent VAT."
Output: {"customerName":"Bob","customerEmail":"bob@example.com","currency":"USD","items":[{"name":"Radiator leak repair, labour","quantity":"3","unitAmount":"40","unit":"HOURS"}],"taxPercent":"20","note":"Fixed a leaking radiator."}

Worked example 2 (materials plus labour):
Description: "Supplied and fitted a new bathroom tap for Anna Kowalski, anna@example.com. Tap 89.99, pipe fittings 12.50, 1 hour labour at 45."
Output: {"customerName":"Anna Kowalski","customerEmail":"anna@example.com","currency":"USD","items":[{"name":"Bathroom tap","quantity":"1","unitAmount":"89.99","unit":"QUANTITY"},{"name":"Pipe fittings","quantity":"1","unitAmount":"12.50","unit":"QUANTITY"},{"name":"Tap fitting, labour","quantity":"1","unitAmount":"45","unit":"HOURS"}],"taxPercent":null,"note":"Supplied and fitted a new bathroom tap."}

Name each item so the customer understands it without the description: say what the labour was for ("Kitchen tap replacement, labour"), never just "Labour". The note is one short sentence that says what was done.`;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function scaleRound(s: string, scale: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const fracRaw = m[2] ?? "";
  const base = BigInt(m[1]!) * pow10(scale) + BigInt((fracRaw + "0".repeat(scale)).slice(0, scale));
  if (fracRaw.length > scale && fracRaw.charCodeAt(scale) >= 53) return base + 1n;
  return base;
}

function decimal(label: string, scale: number, maxScaled: bigint) {
  return z.preprocess(
    (v) => (typeof v === "number" ? String(v) : v),
    z
      .string(`${label} must be a decimal`)
      .trim()
      .regex(/^\d+(\.\d+)?$/, `${label} must be a non-negative decimal`)
      .superRefine((s, ctx) => {
        const scaled = scaleRound(s, scale);
        if (scaled === null || scaled >= maxScaled) {
          ctx.addIssue({ code: "custom", message: `${label} is too large` });
        }
      }),
  );
}

const rawItemSchema = z.object({
  name: z.string("item name is required").trim().min(1, "item name is required"),
  quantity: decimal("quantity", 3, QTY_MAX_SCALED),
  unitAmount: decimal("unitAmount", 2, AMOUNT_MAX_SCALED),
  unit: z.string().optional().nullable(),
});

const rawSchema = z.object({
  customerName: z.string().optional(),
  customerEmail: z.string().optional().nullable(),
  currency: z.string().optional(),
  items: z.array(rawItemSchema).min(1, "at least one item").max(20, "at most 20 items"),
  taxPercent: decimal("taxPercent", 2, TAX_MAX_SCALED + 1n).optional().nullable(),
  note: z.string().optional().nullable(),
});

function extractJson(output: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let text = output.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  if (fence) text = fence[1]!.trim();
  let error = "not valid JSON";
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error };
}

function describeIssues(err: ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");
}

function parseAndValidate(output: string): { ok: true; raw: RawDraft } | { ok: false; error: string } {
  const json = extractJson(output);
  if (!json.ok) return { ok: false, error: json.error };
  const result = rawSchema.safeParse(json.value);
  if (!result.success) return { ok: false, error: describeIssues(result.error) };
  return { ok: true, raw: result.data as RawDraft };
}

function buildMessages(text: string, today: string): { role: string; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Today's date: ${today}.\n\nExtract the invoice from this description:\n\n${text}` },
  ];
}

function formatMoney(cents: bigint): string {
  const s = cents.toString().padStart(3, "0");
  return s.slice(0, -2) + "." + s.slice(-2);
}

function formatQuantity(thousandths: bigint): string {
  const whole = thousandths / 1000n;
  const frac = (thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function formatPercent(s: string): string {
  const t = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return t || "0";
}

function normalizeUnit(unit: string | null | undefined): LineItem["unit"] {
  const u = (unit ?? "").trim().toUpperCase();
  return u === "HOURS" || u === "AMOUNT" || u === "QUANTITY" ? u : undefined;
}

function normalizeCurrency(currency: string | undefined): string {
  const u = (currency ?? "").trim().toUpperCase();
  return CURRENCIES.has(u) ? u : "USD";
}

function subtotalExceeds(items: LineItem[]): boolean {
  let cents = 0n;
  for (const it of items) {
    const q = scaleRound(it.quantity, 3) ?? 0n;
    const u = scaleRound(it.unitAmount, 2) ?? 0n;
    cents += (q * u + 500n) / 1000n;
  }
  return cents > 1_000_000n;
}

function buildWarnings(raw: RawDraft, text: string, customerName: string, customerEmail: string | null, taxPercent: string | null, items: LineItem[]): string[] {
  const warnings: string[] = [];
  if (!customerEmail) warnings.push("No customer email");
  if (!customerName || !raw.customerName?.trim()) warnings.push("No customer name");
  if (items.some((it) => it.unitAmount === "0.00")) warnings.push("Item priced at 0");
  if (subtotalExceeds(items)) warnings.push("Total above 10000");
  const saysNoTax = /\b(no|without|exempt from|excluding|zero)\s+(vat|tax)\b|\b(vat|tax)[\s-]*(free|exempt)\b/i.test(text);
  if (taxPercent === null && !saysNoTax && /(^|\W)(vat|tax)(\W|$)/i.test(text)) warnings.push("VAT mentioned but no tax percent");
  return warnings;
}

function normalize(raw: RawDraft, text: string): InvoiceDraft {
  const items: LineItem[] = raw.items.map((it) => {
    const item: LineItem = {
      name: it.name.trim().slice(0, 120),
      quantity: formatQuantity(scaleRound(it.quantity, 3) ?? 0n),
      unitAmount: formatMoney(scaleRound(it.unitAmount, 2) ?? 0n),
    };
    const unit = normalizeUnit(it.unit);
    if (unit) item.unit = unit;
    return item;
  });
  const nameRaw = (raw.customerName ?? "").trim();
  const customerName = nameRaw || "Customer";
  const customerEmail = (raw.customerEmail ?? "").trim() || null;
  const taxPercent = raw.taxPercent == null ? null : formatPercent(raw.taxPercent);
  const note = (raw.note ?? "").trim() || null;
  const currency = normalizeCurrency(raw.currency);
  const warnings = buildWarnings(raw, text, customerName, customerEmail, taxPercent, items);
  return { customerName, customerEmail, currency, items, taxPercent, note, warnings };
}

export async function extractDraft(text: string, ai: AiRunner, today: string): Promise<InvoiceDraft> {
  const messages = buildMessages(text, today);
  let output = await ai(messages);
  let result = parseAndValidate(output);
  if (!result.ok) {
    const retry = [
      ...messages,
      { role: "assistant", content: output },
      { role: "user", content: `Your reply was not a valid invoice: ${result.error}. Reply with corrected JSON only.` },
    ];
    output = await ai(retry);
    result = parseAndValidate(output);
    if (!result.ok) throw new ExtractError(`Could not extract a valid invoice: ${result.error}`);
  }
  return normalize(result.raw, text);
}
