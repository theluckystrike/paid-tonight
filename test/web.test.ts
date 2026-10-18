import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUnpaid, overdueLabel, reminderMailto, recordPaymentRequest, computeTotals, computeWarnings, discountChoice, localDay, paidTodayFor } from "../web/app.js";
import { totals } from "../src/money";
import { validateDraft } from "../src/validate";
import type { InvoiceDraft } from "../src/types";

const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("R5: a partially paid invoice keeps both its total and its due amount", () => {
  const invoice = normalizeUnpaid({
    id: "INV-1", number: "0001", status: "PARTIALLY_PAID", customerName: "Ola",
    total: "100.00", dueAmount: "40.00", currency: "EUR",
    dueDate: "2026-10-17", invoiceDate: "2026-10-10",
    payUrl: "https://www.sandbox.paypal.com/invoice/p/#INV-1",
  });
  assert.equal(invoice?.total, "100.00");
  assert.equal(invoice?.dueAmount, "40.00");
  assert.equal(invoice?.payUrl, "https://www.sandbox.paypal.com/invoice/p/#INV-1");
});

test("R5: the email reminder body includes the pay link", () => {
  const url = reminderMailto(
    { customerEmail: "anna@example.com", payUrl: "https://www.sandbox.paypal.com/invoice/p/#INV-1" },
    "Reminder for INV-1",
    "Please pay when you can.",
  );
  assert.match(url, /^mailto:anna%40example\.com\?subject=Reminder%20for%20INV-1&body=/);
  const body = decodeURIComponent(url.split("&body=")[1] ?? "");
  assert.equal(body, "Please pay when you can.\n\nPay online at https://www.sandbox.paypal.com/invoice/p/#INV-1");
  assert.equal(reminderMailto({ customerEmail: null }, "x", "y"), "");
});

test("R5: the due label no longer calls an invoice due yesterday Due today", () => {
  assert.equal(overdueLabel({ dueDate: "2026-10-17" }, "2026-10-17").text, "Due today");
  assert.equal(overdueLabel({ dueDate: "2026-10-17" }, "2026-10-18").text, "Overdue 1 day");
  assert.equal(overdueLabel({ dueDate: "2026-10-17" }, "2026-10-19").text, "Overdue 2 days");
  assert.equal(overdueLabel({ dueDate: "2026-10-20" }, "2026-10-18").text, "Due in 2 days");
});

test("R6: reminder actions use a 2 column grid and the primary button spans the phone width", () => {
  assert.match(app, /actions actions--reminder/);
  assert.match(css, /\.actions--reminder\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /@media \(max-width: 419px\)\s*\{[\s\S]*?\.actions--reminder \.btn--primary\s*\{[^}]*grid-column:\s*1 \/ -1/);
});

test("record payment: a pending 202 becomes a message, not an error", async () => {
  const pendingFetch = (async () => new Response(
    JSON.stringify({ pending: true, message: "PayPal is still recording the payment. Tap Refresh in a minute." }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
  const result = await recordPaymentRequest("INV-1", pendingFetch);
  assert.equal(result.pending, true);
  assert.equal(result.status, null);
  assert.equal(result.message, "PayPal is still recording the payment. Tap Refresh in a minute.");
});

test("record payment: a recorded payment returns the invoice status", async () => {
  const okFetch = (async () => new Response(
    JSON.stringify({ invoice: { id: "INV-1", status: "MARKED_AS_PAID", total: "20.00", paidAmount: "20.00", dueAmount: "0.00", currency: "USD", paid: true } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
  const result = await recordPaymentRequest("INV-1", okFetch);
  assert.equal(result.pending, false);
  assert.equal(result.status?.status, "MARKED_AS_PAID");
  assert.equal(result.status?.paid, true);
});

test("record payment: the pending result shows the message with a Refresh button, never the error line", () => {
  assert.match(app, /function pendingNotice\(message, onRefresh\)[\s\S]*?"Refresh"[\s\S]*?wrap\.append\(text, refreshBtn\)/);
  assert.match(app, /if \(result\.pending\) \{[\s\S]*?pendingNotice\(result\.message/);
});

test("R10: the preview has a clearable discount percent field next to the amount, and edits to either recompute", () => {
  assert.match(app, /discountPercentInput/);
  assert.match(app, /Discount \(percent\)/);
  assert.match(app, /discountPercentInput\.addEventListener\("input",[\s\S]*?state\.draft\.discountPercent[\s\S]*?sync\(\)/);
  assert.match(app, /discountInput\.addEventListener\("input",[\s\S]*?state\.draft\.discount[\s\S]*?sync\(\)/);
});

test("R10: a percent and a fixed amount that disagree warns in the preview and drops neither total", () => {
  const draft = {
    customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [],
    discount: "10.00", discountPercent: "10", items: [{ name: "Work", quantity: "1", unitAmount: "200" }],
  };
  assert.ok(computeWarnings(draft).some((w) => w.includes("not both")), computeWarnings(draft).join(" | "));
  assert.equal(computeTotals(draft).total, "200.00");
});

test("R10: the browser computes the live German percentage case the way PayPal does", () => {
  const draft = {
    customerName: "Herr Weber", customerEmail: null, currency: "EUR", taxPercent: "19", note: null, warnings: [], discountPercent: "10",
    items: [{ name: "Arbeit", quantity: "3.5", unitAmount: "65.50", unit: "HOURS" }, { name: "Heizung", quantity: "1", unitAmount: "1249.00" }],
  };
  assert.equal(computeTotals(draft).total, "1583.21");
});

test("R10: the unpaid row wraps on a narrow screen", () => {
  assert.match(css, /\.unpaid-row__bottom\s*\{[^}]*flex-wrap:\s*wrap/);
});

test("R10: the cash confirm shows the amount due", () => {
  assert.match(app, /handleRecordPayment[\s\S]*?invoice\.dueAmount \|\| invoice\.total[\s\S]*?as paid in cash/);
  assert.match(app, /Record \$\{amount\} as paid in cash/);
});

// A percent draft as the server returns it: the extracted fixed share sits next to the percent. Editing any number
// makes the stale share disagree, which is the live 422 until the amount box is cleared.
function percentDraft(): InvoiceDraft {
  return {
    customerName: "Herr Weber", customerEmail: null, currency: "EUR", taxPercent: "19", note: null, warnings: [],
    discount: "147.83", discountPercent: "10",
    items: [
      { name: "Arbeit", quantity: "3.5", unitAmount: "65.50", unit: "HOURS" },
      { name: "Heizung", quantity: "1", unitAmount: "1249.00" },
    ],
  };
}

test("R11: editing hours on a percent draft keeps one source of truth, so totals match and Send is accepted", () => {
  const draft = percentDraft();
  draft.items[0]!.quantity = "4";
  assert.throws(() => validateDraft(draft));
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.draft.discountPercent, "10");
  assert.equal(choice.locked, true);
  assert.equal(choice.amount, computeTotals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
  assert.equal(validateDraft(choice.draft).discount, null);
});

test("R11: editing a unit price on a percent draft keeps one source of truth", () => {
  const draft = percentDraft();
  draft.items[1]!.unitAmount = "1199.00";
  assert.throws(() => validateDraft(draft));
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.amount, computeTotals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
});

test("R11: editing the percent on a percent draft keeps one source of truth", () => {
  const draft = percentDraft();
  draft.discountPercent = "12";
  assert.throws(() => validateDraft(draft));
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.amount, computeTotals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
});

test("R11: the amount box shows the computed discount, so the line never differs from the field by a cent", () => {
  const draft: InvoiceDraft = {
    customerName: "A", customerEmail: null, currency: "GBP", taxPercent: null, note: null, warnings: [],
    discount: "0.05", discountPercent: "3",
    items: [
      { name: "Work", quantity: "1", unitAmount: "1" },
      { name: "Parts", quantity: "0.5", unitAmount: "1" },
    ],
  };
  // The exact percent share is 0.05, the per line rounding makes the discount line 0.04: the old field showed 0.05.
  assert.equal(totals(draft).discount, "0.04");
  assert.equal(draft.discount, "0.05");
  assert.notEqual(draft.discount, totals(draft).discount);
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.amount, "0.04");
  assert.equal(choice.amount, totals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
});

test("R11: the preview keeps one discount source of truth and the Paid today list uses the local day", () => {
  assert.match(app, /function discountChoice\(draft\)/);
  assert.match(app, /const choice = discountChoice\(state\.draft\)/);
  assert.match(app, /discountInput\.readOnly = choice\.locked/);
  assert.match(app, /discountInput\.addEventListener\("input",[\s\S]*?state\.draft\.discountPercent = null[\s\S]*?sync\(\)/);
  assert.match(app, /discountPercentInput\.addEventListener\("input",[\s\S]*?discountInput\.value = ""[\s\S]*?sync\(\)/);
  assert.match(app, /renderPaidToday\(ui, paidTodayFor\(data\.paidToday\)\)/);
  assert.match(app, /function localDay\(date\)/);
});

test("R11: localDay reads the browser's local calendar day, not the UTC date", () => {
  assert.equal(localDay(new Date(2026, 9, 18, 23, 30, 0)), "2026-10-18");
  assert.equal(localDay(new Date(2026, 9, 18, 0, 30, 0)), "2026-10-18");
  assert.equal(localDay(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
  assert.equal(localDay("not a date"), null);
});

test("R11: the Paid today list keeps only the browser's local calendar day", () => {
  const now = new Date(2026, 9, 18, 12, 0, 0);
  const rows = [
    { id: "A", at: new Date(2026, 9, 18, 1, 0, 0).toISOString() },
    { id: "B", at: new Date(2026, 9, 17, 23, 0, 0).toISOString() },
    { id: "C", at: new Date(2026, 9, 19, 0, 30, 0).toISOString() },
    { id: "D", at: null },
  ];
  assert.deepEqual(paidTodayFor(rows, now).map((r) => r.id), ["A", "D"]);
  assert.deepEqual(paidTodayFor(rows, new Date(2030, 0, 1)).map((r) => r.id), ["D"]);
  const noTime = [{ id: "E", at: undefined }];
  assert.deepEqual(paidTodayFor(noTime, now).map((r) => r.id), ["E"]);
});
