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

function gcd(a: bigint, b: bigint): bigint {
  while (b > 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** The whole-cent step a line's baked discount must be a multiple of, so the per-unit amount stays a whole cent. */
function shareStep(qScaled: bigint): bigint {
  if (qScaled <= 0n) return 0n;
  return qScaled / gcd(qScaled, 1000n);
}

/**
 * Split a fixed discount so each line's share divides exactly by its quantity. The floor share of every line is
 * rounded down to a whole step and the leftover cents go to a quantity 1 line when one exists, because a quantity 1
 * line can hold any number of cents. A line can only give what its quantity times its unit amount holds, so the
 * share never drives the reduced unit price below zero. Returns null when no split can use the whole discount, so
 * PayPal takes it at invoice level instead.
 */
function allocateBakeable(lines: bigint[], qScaled: bigint[], unitCents: bigint[], discount: bigint): bigint[] | null {
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  if (discount <= 0n) return lines.map(() => 0n);
  if (subtotal <= 0n) return null;
  const steps = qScaled.map((q) => shareStep(q));
  // The most a line can give: floor(quantity times unit amount), so the reduced unit price is never negative.
  const caps = qScaled.map((q, i) => (q > 0n ? (unitCents[i]! * q) / 1000n : 0n));
  const shares = lines.map((line, i) => {
    const step = steps[i]!;
    if (step <= 0n) return 0n;
    let base = (line * discount) / subtotal;
    const cap = caps[i]!;
    if (base > cap) base = cap;
    return (base / step) * step;
  });
  let remainder = discount - shares.reduce((a, b) => a + b, 0n);
  // Quantity 1 lines first (any remainder fits), then the rest in whole steps, largest line first.
  const order = lines
    .map((_, i) => i)
    .sort((a, b) => {
      const sa = steps[a] === 1n ? 0 : 1;
      const sb = steps[b] === 1n ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (lines[a]! > lines[b]!) return -1;
      if (lines[a]! < lines[b]!) return 1;
      return a - b;
    });
  for (const i of order) {
    if (remainder <= 0n) break;
    const step = steps[i]!;
    if (step <= 0n) continue;
    const room = caps[i]! - shares[i]!;
    if (room < step) continue;
    const units = room / step;
    const wanted = remainder / step;
    const k = units < wanted ? units : wanted;
    shares[i] = shares[i]! + k * step;
    remainder -= k * step;
  }
  if (remainder !== 0n) return null;
  return shares;
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
  /** The part PayPal must take at invoice level, after tax. Zero when everything is baked into the unit prices. */
  invoiceDiscount: bigint;
  warning: string | null;
}

/** The percent a discount represents, scaled by 100 (so 0.5 is 50), or 0 when the subtotal is empty. */
function effectiveHundredths(discount: bigint, subtotal: bigint): bigint {
  if (subtotal <= 0n) return 0n;
  return (discount * 10_000n + subtotal / 2n) / subtotal;
}

/** True when the effective discount is more than half a percentage point away from the stated percent. */
function offByMoreThanHalfPoint(discount: bigint, subtotal: bigint, pct: bigint): boolean {
  if (subtotal <= 0n) return false;
  const effective = effectiveHundredths(discount, subtotal);
  const diff = effective > pct ? effective - pct : pct - effective;
  return diff > 50n;
}

/** The index of the largest quantity 1 line, or -1 when the draft has none. It can hold any leftover cents. */
function largestSingleLine(lines: bigint[], qScaled: bigint[]): number {
  let best = -1;
  for (let i = 0; i < qScaled.length; i++) {
    if (qScaled[i] !== 1000n) continue;
    if (best < 0 || lines[i]! > lines[best]!) best = i;
  }
  return best;
}

/**
 * The plan for a percentage discount alone. A percentage bakes by reducing each unit price and taking the difference
 * from the original line; when rounding moves the effective rate by more than half a point it is kept on a quantity 1
 * line, or PayPal takes it at invoice level after tax.
 */
function percentPlan(lines: bigint[], unitCents: bigint[], qScaled: bigint[], pct: bigint, percent: string): DiscountPlan {
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  const factor = 10_000n - pct;
  const reduced = unitCents.map((cents) => (cents * factor + 5000n) / 10_000n);
  const reducedLines = reduced.map((cents, i) => lineCentsFor(qScaled[i]!, cents));
  const lineDiscount = reducedLines.map((rl, i) => lines[i]! - rl);
  const totalDiscount = lineDiscount.reduce((a, b) => a + b, 0n);
  // Rounding a unit price can move the effective discount away from the stated percent on small amounts.
  if (offByMoreThanHalfPoint(totalDiscount, subtotal, pct)) {
    const target = (subtotal * pct + 5000n) / 10_000n;
    const single = largestSingleLine(lines, qScaled);
    if (single >= 0) {
      // Keep the leftover cents on the quantity 1 line, whose unit price can hold any share.
      const others = totalDiscount - lineDiscount[single]!;
      let share = target - others;
      if (share < 0n) share = 0n;
      if (share > lines[single]!) share = lines[single]!;
      const adjusted = lineDiscount.slice();
      const adjustedUnits = reduced.slice();
      adjusted[single] = share;
      adjustedUnits[single] = unitCents[single]! - share;
      const adjustedTotal = adjusted.reduce((a, b) => a + b, 0n);
      if (!offByMoreThanHalfPoint(adjustedTotal, subtotal, pct)) {
        return { lines, unitCents: adjustedUnits, lineDiscount: adjusted, totalDiscount: adjustedTotal, baked: true, percent, invoiceDiscount: 0n, warning: null };
      }
    }
    return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: target, baked: false, percent, invoiceDiscount: target, warning: INVOICE_DISCOUNT_WARNING };
  }
  return { lines, unitCents: reduced, lineDiscount, totalDiscount, baked: true, percent, invoiceDiscount: 0n, warning: null };
}

/**
 * Work out how a draft's discount is applied. PayPal Invoicing v2 taxes an item before an item-level discount, so an
 * item.discount cannot give VAT after the discount. A discount is baked into the unit prices instead, which PayPal
 * taxes correctly. A percentage bakes by reducing each unit price and taking the difference from the original line,
 * the way PayPal rounds a line. A fixed amount bakes when its shares divide exactly by each quantity (the leftover
 * cents go on a quantity 1 line); otherwise PayPal takes it at invoice level, after tax, and the draft warns. When a
 * draft carries both a percentage and a separate fixed amount, the percentage bakes and the fixed amount is added at
 * invoice level, after tax, so both come off.
 */
function discountPlan(draft: InvoiceDraft): DiscountPlan {
  const qScaled = draft.items.map((item) => parseDecimal(item.quantity, 3));
  const unitCents = draft.items.map((item) => parseDecimal(item.unitAmount, 2));
  const lines = draft.items.map((item, i) => lineCentsFor(qScaled[i]!, unitCents[i]!));
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  const percent = draft.discountPercent != null && draft.discountPercent !== "" ? draft.discountPercent : null;
  const fixed = draft.discount != null && draft.discount !== "" ? draft.discount : null;

  if (percent != null) {
    const pct = parseDecimal(percent, 2);
    const plan = percentPlan(lines, unitCents, qScaled, pct, percent);
    if (fixed != null) {
      // A draft carries a separate amount only when the description named both a percent and an amount (the extractor
      // drops a model echo of the percent's own share), so both come off: the percent bakes and the amount is taken
      // at invoice level. Taking off more than the subtotal is refused.
      const fixedCents = parseDecimal(fixed, 2);
      if (plan.totalDiscount + fixedCents > subtotal) throw new Error("discount is larger than the subtotal");
      return {
        lines, unitCents: plan.unitCents, lineDiscount: plan.lineDiscount,
        totalDiscount: plan.totalDiscount + fixedCents, baked: plan.baked, percent: plan.percent,
        invoiceDiscount: plan.baked ? fixedCents : plan.totalDiscount + fixedCents,
        warning: plan.baked ? null : INVOICE_DISCOUNT_WARNING,
      };
    }
    return plan;
  }
  if (fixed != null) {
    const discount = parseDecimal(fixed, 2);
    if (discount > subtotal) throw new Error("discount is larger than the subtotal");
    const allocated = allocateBakeable(lines, qScaled, unitCents, discount);
    if (allocated) {
      const reduced = allocated.map((cents, i) => unitCents[i]! - (qScaled[i]! > 0n ? (cents * 1000n) / qScaled[i]! : 0n));
      return { lines, unitCents: reduced, lineDiscount: allocated, totalDiscount: discount, baked: true, percent: null, invoiceDiscount: 0n, warning: null };
    }
    return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: discount, baked: false, percent: null, invoiceDiscount: discount, warning: INVOICE_DISCOUNT_WARNING };
  }
  return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: 0n, baked: false, percent: null, invoiceDiscount: 0n, warning: null };
}

/**
 * Totals for a draft. A percentage discount is baked into the unit prices and tax is charged per line on the
 * discounted amount. A fixed discount that divides exactly by each quantity bakes the same way; one that cannot is
 * taken by PayPal at invoice level, so tax is charged on the full lines and the discount is subtracted after tax.
 * When a draft carries both a percentage and a separate fixed amount, the percentage bakes, tax is charged on the
 * discounted lines, and the fixed amount is subtracted at invoice level, after tax.
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
 * The invoice-level discount for PayPal, or null when there is none to send. It carries the part PayPal must take
 * after tax: a fixed discount whose share per line does not divide exactly by the quantity, a percentage that cannot
 * bake, or the fixed amount of a draft that also carries a percentage.
 */
export function invoiceDiscount(draft: InvoiceDraft): { amount: { currency_code: string; value: string } } | null {
  const plan = discountPlan(draft);
  if (plan.invoiceDiscount <= 0n) return null;
  return { amount: { currency_code: draft.currency, value: formatCents(plan.invoiceDiscount) } };
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
