import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft, DraftInvalid } from "../src/validate";

const base = { customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discount: null };

test("an edited draft above 100,000 is refused on send, like a fresh one", () => {
  const big = { ...base, items: [{ name: "Boiler", quantity: "1", unitAmount: "150000.00" }] };
  assert.throws(() => validateDraft(big), DraftInvalid);
});

test("a normal draft passes", () => {
  const ok = { ...base, items: [{ name: "Boiler", quantity: "2", unitAmount: "50.00" }] };
  assert.equal(validateDraft(ok).items.length, 1);
});
