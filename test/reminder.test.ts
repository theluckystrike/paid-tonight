import { test } from "node:test";
import assert from "node:assert/strict";
import { draftReminder } from "../src/reminder.js";
import type { AiRunner, UnpaidInvoice } from "../src/types.js";

const TODAY = "2026-10-17";

function invoice(overrides: Partial<UnpaidInvoice> = {}): UnpaidInvoice {
  return {
    id: "INV2-ABC",
    number: "INV-0042",
    status: "UNPAID",
    customerName: "Anna Kowalski",
    customerEmail: "anna@example.com",
    total: "179.99",
    currency: "USD",
    dueDate: "2026-10-20",
    invoiceDate: "2026-10-10",
    ...overrides,
  };
}

function aiOnce(response: string): AiRunner {
  return async () => response;
}

function aiCapturing(response: string): { ai: AiRunner; calls: { role: string; content: string }[][] } {
  const calls: { role: string; content: string }[][] = [];
  const ai: AiRunner = async (messages) => {
    calls.push(messages);
    return response;
  };
  return { ai, calls };
}

const good = JSON.stringify({ subject: "Payment reminder for invoice INV-0042", note: "We completed the plumbing work at your home. The balance of 179.99 USD is still open. Please use the payment link in this email when convenient." });

test("not due gives friendly tone", async () => {
  const r = await draftReminder(invoice({ dueDate: "2026-10-25" }), aiOnce(good), TODAY);
  assert.equal(r.tone, "friendly");
});

test("one day overdue gives friendly tone", async () => {
  const r = await draftReminder(invoice({ dueDate: "2026-10-16" }), aiOnce(good), TODAY);
  assert.equal(r.tone, "friendly");
});

test("fourteen days overdue gives friendly tone", async () => {
  const r = await draftReminder(invoice({ dueDate: "2026-10-03" }), aiOnce(good), TODAY);
  assert.equal(r.tone, "friendly");
});

test("fifteen days overdue gives firm tone", async () => {
  const r = await draftReminder(invoice({ dueDate: "2026-10-02" }), aiOnce(good), TODAY);
  assert.equal(r.tone, "firm");
});

test("missing due date gives friendly tone", async () => {
  const r = await draftReminder(invoice({ dueDate: null }), aiOnce(good), TODAY);
  assert.equal(r.tone, "friendly");
});

test("keeps a subject that names the invoice number", async () => {
  const r = await draftReminder(invoice(), aiOnce(good), TODAY);
  assert.equal(r.subject, "Payment reminder for invoice INV-0042");
  assert.equal(r.note, "We completed the plumbing work at your home. The balance of 179.99 USD is still open. Please use the payment link in this email when convenient.");
});

test("replaces a subject that omits the invoice number", async () => {
  const r = await draftReminder(invoice(), aiOnce(JSON.stringify({ subject: "Hey there", note: "Please pay soon." })), TODAY);
  assert.match(r.subject, /INV-0042/);
});

test("caps a long note at 400 characters", async () => {
  const long = "Please pay. ".repeat(60);
  const r = await draftReminder(invoice(), aiOnce(JSON.stringify({ subject: "Invoice INV-0042", note: long })), TODAY);
  assert.equal(r.note.length, 400);
});

test("strips emojis from subject and note", async () => {
  const r = await draftReminder(
    invoice(),
    aiOnce(JSON.stringify({ subject: "Invoice INV-0042 🎉", note: "Please pay soon 😊. Thank you." })),
    TODAY,
  );
  assert.ok(!/\p{Extended_Pictographic}/u.test(r.subject));
  assert.ok(!/\p{Extended_Pictographic}/u.test(r.note));
});

test("falls back gracefully when the AI returns non-JSON", async () => {
  const r = await draftReminder(invoice(), aiOnce("Here is a friendly reminder to pay invoice INV-0042."), TODAY);
  assert.match(r.subject, /INV-0042/);
  assert.ok(r.note.length > 0);
});

test("falls back when the note is empty", async () => {
  const r = await draftReminder(invoice(), aiOnce(JSON.stringify({ subject: "Invoice INV-0042", note: "" })), TODAY);
  assert.ok(r.note.includes("INV-0042"));
  assert.ok(r.note.includes("179.99"));
});

test("prompt names the customer, invoice number, amount and tone", async () => {
  const { ai, calls } = aiCapturing(good);
  await draftReminder(invoice({ dueDate: "2026-10-02" }), ai, TODAY);
  const content = calls[0]!.map((m) => m.content).join("\n");
  assert.match(content, /Anna Kowalski/);
  assert.match(content, /INV-0042/);
  assert.match(content, /179\.99 USD/);
  assert.match(content, /firm/);
});
