import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceDiscount, totals, toPayPalItems, type PayPalItem } from "../src/money";
import type { InvoiceDraft } from "../src/types";

// A PayPal Invoicing v2 simulator: it computes an invoice the way PayPal does, from the items the app would send.
// Each line is quantity times unit amount rounded half up to cents, tax is rounded half up per line, and an
// invoice-level discount (when present) is subtracted after tax. The app's total must equal this total.
function scaled(value: string, scale: number): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale));
}

function cents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function simulatePayPal(items: PayPalItem[], invoiceDiscountValue: string | null): string {
  let subtotal = 0n;
  let tax = 0n;
  for (const item of items) {
    const quantity = scaled(item.quantity, 3);
    const unit = scaled(item.unit_amount.value, 2);
    const line = (quantity * unit + 500n) / 1000n;
    subtotal += line;
    if (item.tax) tax += (line * scaled(item.tax.percent, 3) + 50_000n) / 100_000n;
  }
  const discount = invoiceDiscountValue == null ? 0n : scaled(invoiceDiscountValue, 2);
  return cents(subtotal + tax - discount);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const QUANTITIES = ["0.5", "1", "1.25", "1.5", "2", "2.5", "3", "3.5", "0.333", "1.125", "2.75", "3.333", "4.5", "7"];
const TAXES = [null, "0", "7.375", "8.875", "19", "20", "21", "23", "30"];

function makeDraft(next: () => number): InvoiceDraft {
  const count = 1 + Math.floor(next() * 5);
  const items = Array.from({ length: count }, (_, i) => {
    // Small unit prices make per-unit rounding move the effective percent, so they are part of the sweep.
    const small = next() < 0.3;
    const unitCents = small ? 1n + BigInt(Math.floor(next() * 40)) : BigInt(1 + Math.floor(next() * 200_000));
    return {
      name: `Item ${i + 1}`,
      quantity: QUANTITIES[Math.floor(next() * QUANTITIES.length)]!,
      unitAmount: cents(unitCents),
      unit: "QUANTITY" as const,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + (scaled(item.quantity, 3) * scaled(item.unitAmount, 2) + 500n) / 1000n, 0n);
  const draft: InvoiceDraft = {
    customerName: "Sim",
    customerEmail: null,
    currency: "EUR",
    items,
    taxPercent: TAXES[Math.floor(next() * TAXES.length)]!,
    note: null,
    warnings: [],
  };
  const mode = Math.floor(next() * 4);
  if (mode === 1) {
    draft.discountPercent = (Math.floor(next() * 10001) / 100).toFixed(2);
  } else if (mode === 2) {
    draft.discount = subtotal > 0n ? cents(BigInt(Math.floor(next() * Number(subtotal + 1n)))) : "0.00";
  } else if (mode === 3) {
    // A percent plus a separate fixed amount: the percent bakes and the amount is taken at invoice level. The amount
    // stays within what is left after the percent, so together they never take off more than the subtotal.
    const hundredths = BigInt(Math.floor(next() * 10001));
    draft.discountPercent = (Number(hundredths) / 100).toFixed(2);
    const share = (subtotal * hundredths + 5000n) / 10000n;
    const remaining = subtotal > share ? subtotal - share : 0n;
    draft.discount = remaining > 0n ? cents(BigInt(Math.floor(next() * Number(remaining + 1n)))) : "0.00";
  }
  return draft;
}

test("our total equals a PayPal simulation on 5,000 random drafts with fractional quantities", () => {
  const next = random(20261018);
  let baked = 0;
  let fallback = 0;
  let percent = 0;
  for (let i = 0; i < 5000; i++) {
    const draft = makeDraft(next);
    const items = toPayPalItems(draft);
    const simulated = simulatePayPal(items, invoiceDiscount(draft)?.amount.value ?? null);
    const ours = totals(draft);
    assert.equal(ours.total, simulated, `draft ${i}: ${JSON.stringify(draft)} => ours ${ours.total}, PayPal ${simulated}`);
    if (invoiceDiscount(draft)) fallback++;
    else baked++;
    if (draft.discountPercent != null) percent++;
  }
  assert.ok(percent > 1000, `percent drafts: ${percent}`);
  assert.ok(fallback > 200, `fallback drafts: ${fallback}`);
  assert.ok(baked > 1000, `baked drafts: ${baked}`);
});

test("R13: a percent plus a separate fixed amount matches the PayPal simulation and carries both", () => {
  const draft: InvoiceDraft = {
    customerName: "Herr Weber",
    customerEmail: null,
    currency: "EUR",
    taxPercent: "19",
    discount: "5.00",
    discountPercent: "10",
    note: null,
    warnings: [],
    items: [{ name: "Arbeit", quantity: "1", unitAmount: "200.00", unit: "HOURS" }],
  };
  const ours = totals(draft);
  assert.deepEqual(ours, { subtotal: "200.00", discount: "25.00", tax: "34.20", total: "209.20" });
  assert.equal(toPayPalItems(draft)[0]!.unit_amount.value, "180.00");
  assert.equal(invoiceDiscount(draft)?.amount.value, "5.00");
  assert.equal(simulatePayPal(toPayPalItems(draft), invoiceDiscount(draft)?.amount.value ?? null), "209.20");
});

test("the live German case: 3.5 hours at 65.50 and a 1249.00 part, 10 percent off, 19 percent VAT", () => {
  const draft: InvoiceDraft = {
    customerName: "Herr Weber",
    customerEmail: null,
    currency: "EUR",
    taxPercent: "19",
    discountPercent: "10",
    note: null,
    warnings: [],
    items: [
      { name: "Arbeit", quantity: "3.5", unitAmount: "65.50", unit: "HOURS" },
      { name: "Heizung", quantity: "1", unitAmount: "1249.00" },
    ],
  };
  const ours = totals(draft);
  assert.deepEqual(ours, { subtotal: "1478.25", discount: "147.82", tax: "252.78", total: "1583.21" });
  assert.equal(simulatePayPal(toPayPalItems(draft), null), "1583.21");
  assert.equal(toPayPalItems(draft)[0]!.unit_amount.value, "58.95");
});
