import { test } from "node:test";
import assert from "node:assert/strict";
import { INVOICE_DISCOUNT_WARNING, discountWarning, invoiceDiscount, totals, toPayPalItems } from "../src/money";
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

test("toPayPalItems: null tax percent sends no tax object, and unit passes through", () => {
  const items = toPayPalItems(draft({
    items: [{ name: "Tap", quantity: "1", unitAmount: "89.99", unit: "HOURS" }],
  }));
  assert.equal(items[0]?.tax, undefined);
  assert.equal(items[0]?.unit_of_measure, "HOURS");
});

test("totals: tax per line as PayPal computes it", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [],
    items: [{ name: "Labour", quantity: "1.5", unitAmount: "45" }, { name: "Part", quantity: "1", unitAmount: "12.50" }, { name: "Seal", quantity: "1", unitAmount: "6.50" }] };
  assert.deepEqual(totals(draft), { subtotal: "86.50", discount: "0.00", tax: "19.91", total: "106.41" });
});

test("totals: an invoice discount with no tax", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discount: "15.00",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50" }, { name: "Valve", quantity: "1", unitAmount: "30" }] };
  assert.deepEqual(totals(draft), { subtotal: "130.00", discount: "15.00", tax: "0.00", total: "115.00" });
});

test("totals: the discount is spread across the lines before tax (boiler reference case)", () => {
  const draft = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discount: "13.00",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(draft), { subtotal: "130.00", discount: "13.00", tax: "26.91", total: "143.91" });
});

test("totals: a 100 percent discount leaves no tax", () => {
  const draft = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discount: "130.00",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(draft), { subtotal: "130.00", discount: "130.00", tax: "0.00", total: "0.00" });
});

test("totals: a discountPercent is computed from the subtotal and taxed after allocation", () => {
  const draft = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discountPercent: "10",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(draft), { subtotal: "130.00", discount: "13.00", tax: "26.91", total: "143.91" });
});

test("totals: the discount remainder goes to the largest line", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discount: "0.02",
    items: [{ name: "Small", quantity: "1", unitAmount: "0.01" }, { name: "Big", quantity: "1", unitAmount: "0.02" }] };
  assert.deepEqual(totals(draft), { subtotal: "0.03", discount: "0.02", tax: "0.00", total: "0.01" });
});

test("totals: tax rates with 3 decimals are exact", () => {
  const draft = { customerName: "A", customerEmail: null, currency: "USD", taxPercent: "8.875", note: null, warnings: [],
    items: [{ name: "Heater", quantity: "1", unitAmount: "1249.00" }, { name: "Labour", quantity: "3", unitAmount: "95.00", unit: "HOURS" as const }] };
  assert.deepEqual(totals(draft), { subtotal: "1534.00", discount: "0.00", tax: "136.14", total: "1670.14" });
});

test("boiler: a 10 percent discount bakes into the unit prices, no item discount object", () => {
  const d = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discountPercent: "10",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(d), { subtotal: "130.00", discount: "13.00", tax: "26.91", total: "143.91" });
  const items = toPayPalItems(d);
  assert.equal(items[0]?.unit_amount.value, "45.00");
  assert.equal(items[1]?.unit_amount.value, "27.00");
  assert.equal("discount" in items[0]!, false);
  assert.equal("discount" in items[1]!, false);
  assert.equal(items[0]?.description, "10% off included");
  assert.equal(invoiceDiscount(d), null);
  assert.equal(discountWarning(d), null);
});

test("boiler: a fixed 13.00 discount bakes in the same way and matches the percentage totals", () => {
  const d = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discount: "13.00",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(d), { subtotal: "130.00", discount: "13.00", tax: "26.91", total: "143.91" });
  const items = toPayPalItems(d);
  assert.equal(items[0]?.unit_amount.value, "45.00");
  assert.equal(items[1]?.unit_amount.value, "27.00");
  assert.equal("discount" in items[0]!, false);
  assert.equal(invoiceDiscount(d), null);
  assert.equal(discountWarning(d), null);
});

test("a fixed 10.00 that cannot split exactly falls back to the invoice-level discount with a warning", () => {
  const d = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discount: "10.00",
    items: [{ name: "Hours", quantity: "3", unitAmount: "33.33" }] };
  assert.deepEqual(totals(d), { subtotal: "99.99", discount: "10.00", tax: "23.00", total: "112.99" });
  const items = toPayPalItems(d);
  assert.equal(items[0]?.unit_amount.value, "33.33");
  assert.equal("discount" in items[0]!, false);
  assert.deepEqual(invoiceDiscount(d), { amount: { currency_code: "EUR", value: "10.00" } });
  assert.equal(discountWarning(d), INVOICE_DISCOUNT_WARNING);
});

test("a 100 percent discount gives a 0.00 total", () => {
  const d = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "23", note: null, warnings: [], discountPercent: "100",
    items: [{ name: "Boiler repair, labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }] };
  assert.deepEqual(totals(d), { subtotal: "130.00", discount: "130.00", tax: "0.00", total: "0.00" });
  assert.equal(toPayPalItems(d)[0]?.unit_amount.value, "0.00");
});

test("toPayPalItems: a 3 decimal tax percent is sent as given", () => {
  const items = toPayPalItems(draft({ taxPercent: "8.875", items: [{ name: "Heater", quantity: "1", unitAmount: "1249.00" }] }));
  assert.deepEqual(items[0]?.tax, { name: "Tax", percent: "8.875" });
});
