import type { InvoiceDraft, Totals } from "./types";

export interface PayPalItem {
  name: string;
  description?: string;
  quantity: string;
  unit_amount: { currency_code: string; value: string };
  unit_of_measure: string;
  tax?: { name: string; percent: string };
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

// A line amount = quantity times unit amount, rounded half-up to cents, the way PayPal rounds a line.
function lineCentsFor(qScaled: bigint, unitCents: bigint): bigint {
  return (qScaled * unitCents + 500n) / 1000n;
}

// Tax percent scaled by 1000, so 8.875 is kept exactly.
function percentThousandths(value: string): bigint {
  return parseDecimal(value, 3);
}

function percentTax(cents: bigint, thousandths: bigint): bigint {
  return (cents * thousandths + 50_000n) / 100_000n;
}

function orderedBySize(lines: bigint[]): number[] {
  return lines
    .map((_, i) => i)
    .sort((a, b) => {
      const la = lines[a]!;
      const lb = lines[b]!;
      if (la > lb) return -1;
      if (la < lb) return 1;
      return a - b;
    });
}

/**
 * Split an invoice discount across the lines in whole cents. Each line gets its floor share and the remainder goes to
 * the largest line, spilling to the next largest only if that line cannot hold it.
 */
function allocateDiscount(lines: bigint[], discount: bigint): bigint[] {
  const allocated = lines.map(() => 0n);
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  if (discount <= 0n || subtotal <= 0n) return allocated;
  for (let i = 0; i < lines.length; i++) allocated[i] = (lines[i]! * discount) / subtotal;
  let remainder = discount - allocated.reduce((a, b) => a + b, 0n);
  for (const i of orderedBySize(lines)) {
    if (remainder <= 0n) break;
    const room = lines[i]! - allocated[i]!;
    const added = remainder < room ? remainder : room;
    allocated[i] = allocated[i]! + added;
    remainder -= added;
  }
  return allocated;
}

/** The warning shown when PayPal can only take the discount at invoice level, after tax. */
export const INVOICE_DISCOUNT_WARNING = "PayPal applies this discount after tax, so VAT is charged on the full price";

interface DiscountPlan {
  lines: bigint[];
  unitCents: bigint[];
  lineDiscount: bigint[];
  totalDiscount: bigint;
  /** True when the discount is baked into the unit prices, so PayPal taxes the discounted amounts. */
  baked: boolean;
  /** The percentage as given, for the item description, or null for a fixed discount. */
  percent: string | null;
  warning: string | null;
}

/**
 * Work out how a draft's discount is applied. PayPal Invoicing v2 taxes an item before an item-level discount, so an
 * item.discount cannot give VAT after the discount. A discount is baked into the unit prices instead, which PayPal
 * taxes correctly. A percentage always bakes. A fixed amount bakes when every line's share divides exactly by its
 * quantity; otherwise PayPal takes it at invoice level, after tax, and the draft carries a warning.
 */
function discountPlan(draft: InvoiceDraft): DiscountPlan {
  const qScaled = draft.items.map((item) => parseDecimal(item.quantity, 3));
  const unitCents = draft.items.map((item) => parseDecimal(item.unitAmount, 2));
  const lines = draft.items.map((item, i) => lineCentsFor(qScaled[i]!, unitCents[i]!));
  const percent = draft.discountPercent != null && draft.discountPercent !== "" ? draft.discountPercent : null;
  const fixed = draft.discount != null && draft.discount !== "" ? draft.discount : null;

  if (percent != null) {
    const factor = 10_000n - parseDecimal(percent, 2);
    const reduced = unitCents.map((cents) => (cents * factor + 5000n) / 10_000n);
    const lineDiscount = reduced.map((cents, i) => lineCentsFor(qScaled[i]!, unitCents[i]! - cents));
    return { lines, unitCents: reduced, lineDiscount, totalDiscount: lineDiscount.reduce((a, b) => a + b, 0n), baked: true, percent, warning: null };
  }
  if (fixed != null) {
    const discount = parseDecimal(fixed, 2);
    const subtotal = lines.reduce((a, b) => a + b, 0n);
    if (discount > subtotal) throw new Error("discount is larger than the subtotal");
    const allocated = allocateDiscount(lines, discount);
    const canBake = allocated.every((cents, i) => cents === 0n || (qScaled[i]! > 0n && (cents * 1000n) % qScaled[i]! === 0n));
    if (canBake) {
      const reduced = allocated.map((cents, i) => unitCents[i]! - (qScaled[i]! > 0n ? (cents * 1000n) / qScaled[i]! : 0n));
      return { lines, unitCents: reduced, lineDiscount: allocated, totalDiscount: discount, baked: true, percent: null, warning: null };
    }
    return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: discount, baked: false, percent: null, warning: INVOICE_DISCOUNT_WARNING };
  }
  return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: 0n, baked: false, percent: null, warning: null };
}

/**
 * Totals for a draft. A percentage discount is baked into the unit prices and tax is charged per line on the
 * discounted amount. A fixed discount that divides exactly by each quantity bakes the same way; one that cannot is
 * taken by PayPal at invoice level, so tax is charged on the full lines and the discount is subtracted after tax.
 * Every tax amount is rounded half-up per line. /api/send re-reads PayPal's own total and refuses to send when it
 * differs, so a rounding difference can never reach a customer.
 */
export function totals(draft: InvoiceDraft): Totals {
  const plan = discountPlan(draft);
  const subtotal = plan.lines.reduce((a, b) => a + b, 0n);
  const thousandths = draft.taxPercent == null ? 0n : percentThousandths(draft.taxPercent);
  let tax = 0n;
  for (let i = 0; i < plan.lines.length; i++) {
    const base = plan.baked ? plan.lines[i]! - plan.lineDiscount[i]! : plan.lines[i]!;
    tax += percentTax(base, thousandths);
  }
  const total = subtotal - plan.totalDiscount + tax;
  return { subtotal: formatCents(subtotal), discount: formatCents(plan.totalDiscount), tax: formatCents(tax), total: formatCents(total) };
}

/** The warning the draft should show, or null. */
export function discountWarning(draft: InvoiceDraft): string | null {
  return discountPlan(draft).warning;
}

/**
 * The invoice-level discount for PayPal, or null when there is none to send. It is only present for a fixed discount
 * whose share per line does not divide exactly by the quantity; every other discount is baked into the unit prices.
 */
export function invoiceDiscount(draft: InvoiceDraft): { amount: { currency_code: string; value: string } } | null {
  const plan = discountPlan(draft);
  if (plan.baked || plan.totalDiscount <= 0n) return null;
  return { amount: { currency_code: draft.currency, value: formatCents(plan.totalDiscount) } };
}

export function toPayPalItems(draft: InvoiceDraft): PayPalItem[] {
  const plan = discountPlan(draft);
  // No tax given: no tax object at all, so the PayPal invoice shows no "Tax 0%" line.
  return draft.items.map((item, i) => {
    const out: PayPalItem = {
      name: item.name,
      quantity: item.quantity,
      unit_amount: { currency_code: draft.currency, value: formatCents(plan.unitCents[i]!) },
      unit_of_measure: item.unit ?? "QUANTITY",
    };
    if (draft.taxPercent != null) out.tax = { name: "Tax", percent: draft.taxPercent };
    // A percentage discount is baked into the unit price, so the line says so on the invoice.
    if (plan.percent != null && plan.totalDiscount > 0n && plan.lineDiscount[i]! > 0n) {
      out.description = `${plan.percent}% off included`;
    }
    return out;
  });
}
