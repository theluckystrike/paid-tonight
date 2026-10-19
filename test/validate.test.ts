import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft, DraftInvalid } from "../src/validate";
import { totals } from "../src/money";

const base = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discount: null };

test("an edited draft above 100,000 is refused on send, like a fresh one", () => {
  const big = { ...base, items: [{ name: "Boiler", quantity: "1", unitAmount: "150000.00" }] };
  assert.throws(() => validateDraft(big), DraftInvalid);
});

test("a normal draft passes", () => {
  const ok = { ...base, items: [{ name: "Boiler", quantity: "2", unitAmount: "50.00" }] };
  assert.equal(validateDraft(ok).items.length, 1);
});

test("an NYC 8.875 percent draft validates and totals 136.14 tax", () => {
  const nyc = { ...base, currency: "USD", taxPercent: "8.875",
    items: [{ name: "Heater", quantity: "1", unitAmount: "1249.00" }, { name: "Labour", quantity: "3", unitAmount: "95.00", unit: "HOURS" }] };
  const draft = validateDraft(nyc);
  assert.equal(draft.taxPercent, "8.875");
  const t = totals(draft);
  assert.equal(t.tax, "136.14");
  assert.equal(t.total, "1670.14");
});

test("a tax percent with more than 3 decimals is refused", () => {
  const bad = { ...base, taxPercent: "8.8755", items: [{ name: "Boiler", quantity: "1", unitAmount: "50.00" }] };
  assert.throws(() => validateDraft(bad), DraftInvalid);
});

test("a 100 percent discount totals zero and is refused with a clear message", () => {
  const free = { ...base, discountPercent: "100", items: [{ name: "Boiler", quantity: "2", unitAmount: "50.00" }] };
  assert.equal(totals({ ...free, taxPercent: "23" }).total, "0.00");
  assert.throws(() => validateDraft(free), (err: unknown) => err instanceof DraftInvalid && err.fields.some((f) => f.includes("0.00")));
});

test("a fixed discount and a percent that disagree are both billed, not refused", () => {
  const both = { ...base, discount: "10.00", discountPercent: "10", items: [{ name: "Work", quantity: "1", unitAmount: "200.00" }] };
  const draft = validateDraft(both);
  assert.equal(totals(draft).discount, "30.00");
  assert.equal(totals(draft).total, "170.00");
});

test("a pair of discounts larger than the work billed is refused, so the total cannot go negative", () => {
  const both = { ...base, discount: "150.00", discountPercent: "50", items: [{ name: "Work", quantity: "1", unitAmount: "200.00" }] };
  assert.throws(() => validateDraft(both), (err: unknown) => err instanceof DraftInvalid && err.fields.some((f) => /larger than the subtotal/.test(f)));
});

test("a separate amount equal to the percent share is billed as a second discount", () => {
  const both = { ...base, discount: "20.00", discountPercent: "10", items: [{ name: "Work", quantity: "1", unitAmount: "200.00" }] };
  const draft = validateDraft(both);
  assert.equal(totals(draft).discount, "40.00");
  assert.equal(totals(draft).total, "160.00");
});

test("R10: a percent draft with no separate amount is accepted and totals the baked discount", () => {
  // Per line rounding bakes 0.04 on this 1.50 subtotal, so a lone percent needs no amount box value.
  const draft = { ...base, currency: "GBP", discountPercent: "3",
    items: [{ name: "Work", quantity: "1", unitAmount: "1" }, { name: "Parts", quantity: "0.5", unitAmount: "1" }] };
  assert.equal(totals(draft).discount, "0.04");
  const ok = validateDraft(draft);
  assert.equal(ok.discountPercent, "3");
  assert.equal(ok.discount ?? null, null);
  assert.equal(totals(ok).total, "1.46");
});
