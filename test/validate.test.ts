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
