import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUnpaid, overdueLabel, reminderMailto, recordPaymentRequest, computeTotals, computeWarnings } from "../web/app.js";

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
