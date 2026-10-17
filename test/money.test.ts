import { test } from "node:test";
import assert from "node:assert/strict";
import { totals, toPayPalItems } from "../src/money";
import type { InvoiceDraft } from "../src/types";

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    customerName: "Anna Kowalski",
    customerEmail: "anna@example.com",
    currency: "USD",
    items: [],
    taxPercent: null,
    note: null,
    warnings: [],
    ...overrides,
  };
}

test("totals: labour only, no tax", () => {
  const t = totals(draft({ items: [{ name: "Labour", quantity: "2", unitAmount: "45.00", unit: "HOURS" }] }));
  assert.deepEqual(t, { subtotal: "90.00", discount: "0.00", tax: "0.00", total: "90.00" });
});

test("totals: labour plus materials with 23% VAT", () => {
  const t = totals(draft({
    taxPercent: "23",
    items: [
      { name: "Labour", quantity: "2", unitAmount: "45.00", unit: "HOURS" },
      { name: "Tap", quantity: "1", unitAmount: "89.99", unit: "AMOUNT" },
    ],
  }));
  assert.deepEqual(t, { subtotal: "179.99", discount: "0.00", tax: "41.40", total: "221.39" });
});

test("totals: fractional quantity rounds half-up per line", () => {
  const t = totals(draft({ items: [{ name: "Hours", quantity: "1.333", unitAmount: "45.00" }] }));
  assert.deepEqual(t, { subtotal: "59.99", discount: "0.00", tax: "0.00", total: "59.99" });
});

test("totals: tax rounds half-up on an exact half cent", () => {
  const t = totals(draft({ taxPercent: "50", items: [{ name: "x", quantity: "1", unitAmount: "0.01" }] }));
  assert.deepEqual(t, { subtotal: "0.01", discount: "0.00", tax: "0.01", total: "0.02" });
});

test("totals: empty items yields zero", () => {
  const t = totals(draft({}));
  assert.deepEqual(t, { subtotal: "0.00", discount: "0.00", tax: "0.00", total: "0.00" });
});

test("totals: rejects malformed quantity", () => {
  assert.throws(
    () => totals(draft({ items: [{ name: "x", quantity: "abc", unitAmount: "1.00" }] })),
    /invalid decimal/,
  );
});

test("totals: rejects negative unit amount", () => {
  assert.throws(
    () => totals(draft({ items: [{ name: "x", quantity: "1", unitAmount: "-5.00" }] })),
    /invalid decimal/,
  );
});

test("toPayPalItems: maps fields and defaults unit to QUANTITY", () => {
  const items = toPayPalItems(draft({
    currency: "EUR",
    taxPercent: "23",
    items: [{ name: "Tap", quantity: "1", unitAmount: "89.99" }],
  }));
  assert.deepEqual(items, [{
    name: "Tap",
    quantity: "1",
    unit_amount: { currency_code: "EUR", value: "89.99" },
    unit_of_measure: "QUANTITY",
    tax: { name: "Tax", percent: "23" },
  }]);
});

test("toPayPalItems: null tax percent becomes zero and unit passes through", () => {
  const items = toPayPalItems(draft({
    items: [{ name: "Tap", quantity: "1", unitAmount: "89.99", unit: "HOURS" }],
  }));
  assert.equal(items[0]?.tax.percent, "0");
  assert.equal(items[0]?.unit_of_measure, "HOURS");
});

test("totals: tax per line as PayPal computes it", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [],
    items: [{ name: "Labour", quantity: "1.5", unitAmount: "45" }, { name: "Part", quantity: "1", unitAmount: "12.50" }, { name: "Seal", quantity: "1", unitAmount: "6.50" }] };
  assert.deepEqual(totals(draft), { subtotal: "86.50", discount: "0.00", tax: "19.91", total: "106.41" });
});

test("totals: an invoice discount comes off before tax", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discount: "15.00",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50" }, { name: "Valve", quantity: "1", unitAmount: "30" }] };
  assert.deepEqual(totals(draft), { subtotal: "130.00", discount: "15.00", tax: "0.00", total: "115.00" });
});
