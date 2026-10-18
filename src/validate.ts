import { z } from "zod";
import { SUPPORTED } from "./extract.js";
import type { InvoiceDraft } from "./types.js";
import { discountWarning, totals } from "./money.js";

// Server-side check of a draft the user edited in the browser. Runs before anything is created or sent at PayPal.
const money = z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, "must be an amount between 0 and 999999.99");
const qty = z.string().trim().regex(/^\d{1,6}(\.\d{1,3})?$/, "must be a quantity").refine((v) => Number(v) > 0, "must be more than 0");

const draftSchema = z.object({
  customerName: z.string().trim().min(1, "is required").max(100),
  customerEmail: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "is not a valid email").nullable(),
  currency: z.enum(SUPPORTED as [string, ...string[]], "is not supported"),
  items: z.array(z.object({
    name: z.string().trim().min(1, "is required").max(120),
    quantity: qty,
    unitAmount: money,
    unit: z.enum(["HOURS", "AMOUNT", "QUANTITY"]).optional(),
  })).min(1, "needs at least one item").max(20),
  taxPercent: z.string().trim().regex(/^\d{1,2}(\.\d{1,3})?$/, "must be a percent with up to 3 decimals").refine((v) => Number(v) <= 30, "must be 30 or less").nullable(),
  discount: money.nullable().optional(),
  discountPercent: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "must be a percent with up to 2 decimals").refine((v) => Number(v) <= 100, "must be 100 or less").nullable().optional(),
  note: z.string().trim().max(300).nullable(),
  warnings: z.array(z.string()).optional(),
});

export class DraftInvalid extends Error {
  constructor(public fields: string[]) { super(fields.join("; ")); this.name = "DraftInvalid"; }
}

export function validateDraft(input: unknown): InvoiceDraft {
  const r = draftSchema.safeParse(input);
  if (!r.success) throw new DraftInvalid(r.error.issues.map((i) => `${i.path.join(".") || "draft"} ${i.message}`));
  const draft = { ...r.data, warnings: r.data.warnings ?? [] } as InvoiceDraft;
  let t: ReturnType<typeof totals>;
  try { t = totals(draft); } catch (err) { throw new DraftInvalid([err instanceof Error ? err.message : "totals failed"]); }
  // Same ceiling as extraction, so an edited draft cannot send what a fresh one would refuse.
  if (Number(t.total) >= 100_000) throw new DraftInvalid(["The total is above 100,000. Check the amounts and try again."]);
  // A zero total has nothing to pay, so PayPal must not be asked to invoice it.
  if (t.total === "0.00") throw new DraftInvalid(["The total is 0.00, so there is nothing to bill. Remove the discount or set a price."]);
  const warning = discountWarning(draft);
  if (warning && !draft.warnings.includes(warning)) draft.warnings.push(warning);
  return draft;
}
