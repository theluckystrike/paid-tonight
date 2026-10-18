import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUnpaid, overdueLabel, reminderMailto } from "../web/app.js";

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
