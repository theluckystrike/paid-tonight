import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUnpaid, overdueLabel, reminderMailto, recordPaymentRequest, computeTotals, computeWarnings, discountChoice, localDay, paidTodayFor, POLL_INTERVAL_MS, POLL_MAX_MS, POLL_ENDED_MESSAGE, shouldStopPolling, statusHeadline, createInvoicePoller, resolveSpeechLang, loadSavedSpeechLang, saveSpeechLang } from "../web/app.js";
import { totals } from "../src/money";
import { validateDraft } from "../src/validate";
import { extractDraft } from "../src/extract.js";
import type { InvoiceDraft } from "../src/types";

const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

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

test("R13: the preview bills a percent and a separate amount together, with no refusing warning", () => {
  const draft = {
    customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [],
    discount: "10.00", discountPercent: "10", items: [{ name: "Work", quantity: "1", unitAmount: "200" }],
  };
  assert.ok(!computeWarnings(draft).some((w) => w.includes("not both")), computeWarnings(draft).join(" | "));
  assert.equal(computeTotals(draft).discount, "30.00");
  assert.equal(computeTotals(draft).total, "170.00");
  const choice = discountChoice(draft);
  assert.equal(choice.locked, false);
  assert.equal(choice.draft.discount, "10.00");
  assert.equal(choice.draft.discountPercent, "10");
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

// A percent draft as the server returns it for a lone percent: no separate amount, so editing any number cannot
// leave a stale amount behind.
function percentDraft(): InvoiceDraft {
  return {
    customerName: "Herr Weber", customerEmail: null, currency: "EUR", taxPercent: "19", note: null, warnings: [],
    discountPercent: "10",
    items: [
      { name: "Arbeit", quantity: "3.5", unitAmount: "65.50", unit: "HOURS" },
      { name: "Heizung", quantity: "1", unitAmount: "1249.00" },
    ],
  };
}

// A draft that names both a percent and a separate amount: the percent bakes and the amount is taken at invoice level.
function bothDraft(): InvoiceDraft {
  return {
    customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [],
    discount: "5.00", discountPercent: "10",
    items: [{ name: "Work", quantity: "1", unitAmount: "200" }],
  };
}

test("R11: editing hours on a percent draft keeps one source of truth, so totals match and Send is accepted", () => {
  const draft = percentDraft();
  draft.items[0]!.quantity = "4";
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
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.amount, computeTotals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
});

test("R11: editing the percent on a percent draft keeps one source of truth", () => {
  const draft = percentDraft();
  draft.discountPercent = "12";
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, null);
  assert.equal(choice.amount, computeTotals(choice.draft).discount);
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
});

test("R13: editing a number on a both-discounts draft keeps both, and the preview still equals the server", () => {
  const draft = bothDraft();
  draft.items[0]!.quantity = "2";
  const choice = discountChoice(draft);
  assert.equal(choice.locked, false);
  assert.equal(choice.draft.discount, "5.00");
  assert.equal(choice.draft.discountPercent, "10");
  assert.deepEqual(computeTotals(choice.draft), totals(choice.draft));
  assert.doesNotThrow(() => validateDraft(choice.draft));
  assert.equal(validateDraft(choice.draft).discount, "5.00");
});

test("R13: the preview and /api/totals agree to the cent on a both-discounts draft", () => {
  const draft = bothDraft();
  const choice = discountChoice(draft);
  const preview = computeTotals(choice.draft);
  const server = totals(validateDraft(draft));
  assert.deepEqual(preview, server);
  assert.deepEqual(preview, { subtotal: "200.00", discount: "25.00", tax: "0.00", total: "175.00" });
});

test("R13: a both-discounts draft from the extractor keeps the preview and the server equal", async () => {
  const json = JSON.stringify({
    customerName: "Ola", customerEmail: null, currency: "EUR", taxPercent: "19",
    items: [{ name: "Arbeit", quantity: "1", unitAmount: "200", unit: "HOURS" }],
    discount: "5", discountPercent: "10", note: null,
  });
  const draft = await extractDraft("Arbeit 200 Euro, 10 % Rabatt und minus 5 Euro", async () => json, "2026-10-17");
  const choice = discountChoice(draft);
  assert.equal(choice.draft.discount, "5.00");
  assert.equal(choice.draft.discountPercent, "10");
  assert.deepEqual(computeTotals(choice.draft), totals(draft));
  assert.deepEqual(computeTotals(choice.draft), totals(validateDraft(draft)));
  assert.equal(computeTotals(choice.draft).total, "209.20");
});

test("R11: the amount box shows the computed discount, so the line never differs from the field by a cent", () => {
  const draft: InvoiceDraft = {
    customerName: "A", customerEmail: null, currency: "GBP", taxPercent: null, note: null, warnings: [],
    discountPercent: "3",
    items: [
      { name: "Work", quantity: "1", unitAmount: "1" },
      { name: "Parts", quantity: "0.5", unitAmount: "1" },
    ],
  };
  // The exact percent share is 0.05, the per line rounding makes the discount line 0.04: the box shows the line value.
  assert.equal(totals(draft).discount, "0.04");
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

test("R12: the success card says Unpaid, never the SENT placeholder, and stops when settled", () => {
  assert.equal(statusHeadline({ status: "UNPAID", paid: false }), "Unpaid");
  assert.equal(statusHeadline({ status: "SENT", paid: false }), "Unpaid");
  assert.equal(statusHeadline({ status: "PAID", paid: true }), "Paid");
  assert.equal(POLL_INTERVAL_MS, 5000);
  assert.equal(POLL_MAX_MS, 120000);
  assert.equal(shouldStopPolling({ status: "UNPAID", paid: false }), false);
  assert.equal(shouldStopPolling({ status: "PAID", paid: false }), true);
  assert.equal(shouldStopPolling({ status: "MARKED_AS_PAID", paid: false }), true);
  assert.equal(shouldStopPolling({ status: "SENT", paid: true }), true);
});

test("R12: the poller shows the first UNPAID read and stops on a paid read", async () => {
  const statuses = [
    { status: "UNPAID", paid: false },
    { status: "PAID", paid: true, paidAmount: "10.00", total: "10.00" },
  ];
  let calls = 0;
  let scheduled: (() => void) | null = null;
  let cleared = 0;
  const seen: Array<{ status?: string; paid?: boolean }> = [];
  const poller = createInvoicePoller({
    fetchStatus: async () => statuses[Math.min(calls++, statuses.length - 1)],
    onStatus: (status) => seen.push(status as { status?: string; paid?: boolean }),
    intervalMs: 5,
    maxMs: 120,
    now: () => 0,
    setTimeoutFn: (fn) => { scheduled = fn; return 7; },
    clearTimeoutFn: () => { cleared += 1; },
  });
  assert.equal(typeof scheduled, "function");
  await poller.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, "UNPAID");
  assert.equal(cleared, 0);
  await poller.tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.status, "PAID");
  assert.equal(cleared, 1);
  await poller.tick();
  assert.equal(seen.length, 2);
});

test("R12: the poller stops at the 2 minute limit", async () => {
  let clock = 0;
  let cleared = 0;
  const seen: unknown[] = [];
  const poller = createInvoicePoller({
    fetchStatus: async () => ({ status: "UNPAID", paid: false }),
    onStatus: (status) => seen.push(status),
    maxMs: 100,
    now: () => clock,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => { cleared += 1; },
  });
  await poller.tick();
  assert.equal(cleared, 0);
  clock = 100;
  await poller.tick();
  assert.equal(cleared, 1);
  await poller.tick();
  assert.equal(seen.length, 2);
});

test("R10: the poller self schedules and reports the quiet end after 2 minutes", async () => {
  let clock = 0;
  let scheduled = 0;
  let ended = 0;
  const poller = createInvoicePoller({
    fetchStatus: async () => ({ status: "UNPAID", paid: false }),
    onStatus: () => undefined,
    maxMs: 100,
    now: () => clock,
    setTimeoutFn: () => { scheduled += 1; return scheduled; },
    clearTimeoutFn: () => undefined,
    onEnd: () => { ended += 1; },
  });
  // The first tick is scheduled by a timeout, not an interval, so ticks cannot overlap.
  assert.ok(scheduled >= 1);
  await poller.tick();
  assert.equal(ended, 0);
  clock = 100;
  await poller.tick();
  assert.equal(ended, 1);
  await poller.tick();
  assert.equal(ended, 1);
  assert.equal(POLL_ENDED_MESSAGE, "Checked PayPal for 2 minutes, tap Refresh");
});

test("R10: a new invoice clears the running status poller", () => {
  assert.match(app, /function stopActiveStatusPoller\(\)/);
  assert.match(app, /async function handleMake\(ui\) \{[\s\S]*?stopActiveStatusPoller\(\)/);
  assert.match(app, /function showSuccess\(ui, result\) \{[\s\S]*?stopActiveStatusPoller\(\)/);
  assert.match(app, /createInvoicePoller\(\{[\s\S]*?onEnd:[\s\S]*?POLL_ENDED_MESSAGE/);
});

test("R10: a percent above 100 is clamped in the preview and warns instead of a negative total", () => {
  const draft = {
    customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], discountPercent: "150",
    items: [{ name: "Work", quantity: "1", unitAmount: "200" }],
  };
  const t = computeTotals(draft);
  assert.equal(t.total, "0.00");
  assert.equal(Number(t.total) < 0, false);
  assert.equal(Number(t.discount) <= Number(t.subtotal), true);
  assert.ok(computeWarnings(draft).includes("Percent must be 100 or less"));
  const choice = discountChoice(draft);
  assert.equal(choice.locked, true);
  assert.equal(Number(choice.amount) <= 200, true);
});

test("R12: the success card shows the send total at once and starts the poller", () => {
  assert.match(app, /function sendDraftRequest\(draft, fetchFn\)[\s\S]*?total: data\.totals/);
  assert.match(app, /buildStatusBox\(result\.id, \{\s*status: "SENT",\s*total: result\.total/);
  assert.match(app, /apply\(initial\);[\s\S]*?startPolling\(\);/);
  assert.match(app, /function createInvoicePoller\(options\)/);
});

test("R12: the speech language follows the browser language and a saved picker choice", () => {
  assert.equal(resolveSpeechLang("pl-PL", null), "pl-PL");
  assert.equal(resolveSpeechLang("pl", null), "pl-PL");
  assert.equal(resolveSpeechLang("de-AT", null), "de-DE");
  assert.equal(resolveSpeechLang("nl-BE", null), "nl-NL");
  assert.equal(resolveSpeechLang("fr-FR", null), "en-US");
  assert.equal(resolveSpeechLang(null, "nl-NL"), "nl-NL");
  // A saved choice wins over the browser language.
  assert.equal(resolveSpeechLang("de-DE", "pl-PL"), "pl-PL");
  assert.equal(resolveSpeechLang("", ""), "en-US");
});

test("R12: the picker offers Polish, English, German and Dutch and is remembered in localStorage with try and catch", () => {
  for (const lang of ["pl-PL", "en-US", "de-DE", "nl-NL"]) assert.match(html, new RegExp(`value="${lang}"`));
  assert.match(html, /id="speech-lang"/);
  assert.match(app, /navigator\.language/);
  assert.match(app, /recognition\.lang = \(ui\.speechLang && ui\.speechLang\.value\)/);
  assert.match(app, /function loadSavedSpeechLang\(\) \{\s*try \{[\s\S]*?localStorage\.getItem[\s\S]*?\} catch \(err\) \{ return null; \}/);
  assert.match(app, /function saveSpeechLang\(lang\) \{\s*try \{[\s\S]*?localStorage\.setItem[\s\S]*?\} catch \(err\)/);
});

test("R12: the saved speech language helpers do not throw when storage is unavailable", () => {
  // Node has no localStorage, so the try and catch path is the one exercised here.
  assert.equal(loadSavedSpeechLang(), null);
  assert.doesNotThrow(() => saveSpeechLang("pl-PL"));
});

test("a masked customer email opens the reminder draft without a recipient", () => {
  const url = reminderMailto({ customerEmail: "e***@example.com", payUrl: null }, "Invoice", "Hello");
  assert.ok(url.startsWith("mailto:?subject="), url);
  assert.ok(reminderMailto({ customerEmail: "ewa@example.com", payUrl: null }, "Invoice", "Hello").startsWith("mailto:ewa%40example.com?"));
  const starred = reminderMailto({ customerEmail: "we*ird@example.com", payUrl: null }, "Invoice", "Hello");
  assert.ok(starred.startsWith("mailto:we*ird%40example.com?"), starred);
});
