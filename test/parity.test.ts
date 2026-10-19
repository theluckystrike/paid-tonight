import { test } from "node:test";
import assert from "node:assert/strict";
import { totals } from "../src/money";
import type { InvoiceDraft } from "../src/types";
import { computeTotals } from "../web/app.js";

const QUANTITIES = ["1", "2", "0.5", "1.25", "3.333", "0.333", "7", "1.125"];
const TAXES = [null, "0", "7.375", "8.875", "9.125", "19", "21", "23", "30"];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function scaled(value: string, scale: number): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale));
}

function cents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function makeDraft(next: () => number): InvoiceDraft {
  const count = 1 + Math.floor(next() * 5);
  const items = Array.from({ length: count }, (_, i) => ({
    name: `Item ${i + 1}`,
    quantity: QUANTITIES[Math.floor(next() * QUANTITIES.length)]!,
    unitAmount: cents(BigInt(Math.floor(next() * 200_001))),
    unit: "QUANTITY" as const,
  }));
  const subtotal = items.reduce((sum, item) => sum + (scaled(item.quantity, 3) * scaled(item.unitAmount, 2) + 500n) / 1000n, 0n);
  let tax: string | null;
  if (next() < 0.2) {
    const thousandths = Math.floor(next() * 30001);
    tax = `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, "0")}`;
  } else {
    tax = TAXES[Math.floor(next() * TAXES.length)]!;
  }
  const mode = Math.floor(next() * 4);
  const draft: InvoiceDraft = {
    customerName: "Parity",
    customerEmail: null,
    currency: "USD",
    items,
    taxPercent: tax,
    note: null,
    warnings: [],
  };
  if (mode === 1 && subtotal > 0n) {
    draft.discount = cents(BigInt(Math.floor(next() * Number(subtotal + 1n))));
  } else if (mode === 2) {
    draft.discountPercent = (Math.floor(next() * 10001) / 100).toFixed(2);
  } else if (mode === 3) {
    draft.discount = subtotal > 0n ? cents(BigInt(Math.floor(next() * Number(subtotal + 1n)))) : "0.00";
    draft.discountPercent = (Math.floor(next() * 10001) / 100).toFixed(2);
  }
  return draft;
}

test("R2: browser and server totals agree on 5,000 random drafts, covering both discount rules", () => {
  const next = random(20261018);
  let percent = 0;
  let fixed = 0;
  for (let i = 0; i < 5000; i++) {
    const draft = makeDraft(next);
    if (draft.discountPercent) percent++;
    if (draft.discount) fixed++;
    assert.deepEqual(computeTotals(draft), totals(draft), `draft ${i}: ${JSON.stringify(draft)}`);
  }
  assert.ok(percent > 1000, `percent drafts: ${percent}`);
  assert.ok(fixed > 1000, `fixed drafts: ${fixed}`);
});
