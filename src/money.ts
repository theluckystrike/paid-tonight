import type { InvoiceDraft, Totals } from "./types";

export interface PayPalItem {
  name: string;
  quantity: string;
  unit_amount: { currency_code: string; value: string };
  unit_of_measure: string;
  tax: { name: string; percent: string };
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;

// Parse a non-negative decimal string into an integer scaled by 10^scale,
// rounding half-up at that scale. Throws on hostile/invalid input.
function parseDecimal(value: string, scale: number): bigint {
  if (typeof value !== "string" || !DECIMAL_RE.test(value.trim())) {
    throw new Error(`invalid decimal string: ${value}`);
  }
  const t = value.trim();
  const [intPart = "0", fracPart = ""] = t.split(".");
  const int = BigInt(intPart) * 10n ** BigInt(scale);
  const frac = fracPart.padEnd(scale + 1, "0");
  const kept = frac.slice(0, scale);
  const next = frac.slice(scale, scale + 1);
  let fracVal = BigInt(kept === "" ? "0" : kept);
  if (next >= "5") fracVal += 1n;
  return int + fracVal;
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = abs % 100n;
  return `${sign}${intPart}.${fracPart.toString().padStart(2, "0")}`;
}

function lineCents(item: { quantity: string; unitAmount: string }): bigint {
  return (parseDecimal(item.quantity, 3) * parseDecimal(item.unitAmount, 2) + 500n) / 1000n;
}

function percentTax(cents: bigint, bps: bigint): bigint {
  return (cents * bps + 5000n) / 10000n;
}

/**
 * Totals as PayPal computes them: tax per line, each line rounded half-up, then summed. With an invoice-level
 * discount, tax is taken on the discounted subtotal. /api/send re-reads PayPal's own total and refuses to send
 * when it differs, so a rounding difference can never reach a customer.
 */
export function totals(draft: InvoiceDraft): Totals {
  const lines = draft.items.map(lineCents);
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  const discount = draft.discount ? parseDecimal(draft.discount, 2) : 0n;
  if (discount > subtotal) throw new Error("discount is larger than the subtotal");
  const bps = draft.taxPercent == null ? 0n : parseDecimal(draft.taxPercent, 2);
  const tax = discount > 0n ? percentTax(subtotal - discount, bps) : lines.reduce((a, c) => a + percentTax(c, bps), 0n);
  const total = subtotal - discount + tax;
  return { subtotal: formatCents(subtotal), discount: formatCents(discount), tax: formatCents(tax), total: formatCents(total) };
}

export function toPayPalItems(draft: InvoiceDraft): PayPalItem[] {
  const percent = draft.taxPercent ?? "0";
  return draft.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unit_amount: { currency_code: draft.currency, value: item.unitAmount },
    unit_of_measure: item.unit ?? "QUANTITY",
    tax: { name: "Tax", percent },
  }));
}
