import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDraft, type AiRunner } from "../src/extract.js";
import { ExtractError } from "../src/types.js";

type Messages = { role: string; content: string }[];

function fakeAi(responses: string[]): { ai: AiRunner; calls: Messages[] } {
  let i = 0;
  const calls: Messages[] = [];
  const ai: AiRunner = async (messages) => {
    calls.push(messages);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r;
  };
  return { ai, calls };
}

function aiOnce(response: string): AiRunner {
  return async () => response;
}

const TODAY = "2026-10-17";

function draftJson(overrides: Record<string, unknown> = {}): string {
  const obj = {
    customerName: "Anna Kowalski",
    customerEmail: "anna@example.com",
    currency: "PLN",
    items: [
      { name: "Labour", quantity: "2", unitAmount: "45", unit: "HOURS" },
      { name: "Tap", quantity: 1, unitAmount: "89.99", unit: "QUANTITY" },
    ],
    taxPercent: "23",
    note: "Replaced kitchen tap",
    ...overrides,
  };
  return JSON.stringify(obj);
}

test("extracts and normalises a valid invoice", async () => {
  const draft = await extractDraft("two hours at 45", aiOnce(draftJson()), TODAY);
  assert.equal(draft.customerName, "Anna Kowalski");
  assert.equal(draft.customerEmail, "anna@example.com");
  assert.equal(draft.currency, "PLN");
  assert.equal(draft.taxPercent, "23");
  assert.equal(draft.note, "Replaced kitchen tap");
  assert.equal(draft.items.length, 2);
  assert.deepEqual(draft.items[0], { name: "Labour", quantity: "2", unitAmount: "45.00", unit: "HOURS" });
  assert.deepEqual(draft.items[1], { name: "Tap", quantity: "1", unitAmount: "89.99", unit: "QUANTITY" });
  assert.deepEqual(draft.warnings, []);
});

test("accepts JSON wrapped in a code fence", async () => {
  const fenced = "```json\n" + draftJson() + "\n```";
  const draft = await extractDraft("job", aiOnce(fenced), TODAY);
  assert.equal(draft.customerName, "Anna Kowalski");
});

test("retries once when the first response is bad JSON and the second is good", async () => {
  const { ai, calls } = fakeAi(["not json at all {{{", draftJson()]);
  const draft = await extractDraft("job", ai, TODAY);
  assert.equal(draft.customerName, "Anna Kowalski");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]![calls[1]!.length - 1]!.role, "user");
  assert.match(calls[1]![calls[1]!.length - 1]!.content, /not valid JSON/);
});

test("retries once when validation fails then succeeds", async () => {
  const bad = draftJson({ items: [{ name: "x", quantity: "1", unitAmount: "-5" }] });
  const { ai, calls } = fakeAi([bad, draftJson()]);
  const draft = await extractDraft("job", ai, TODAY);
  assert.equal(draft.customerName, "Anna Kowalski");
  assert.equal(calls.length, 2);
  assert.match(calls[1]![calls[1]!.length - 1]!.content, /unitAmount/);
});

test("throws ExtractError after two failures", async () => {
  await assert.rejects(extractDraft("job", aiOnce("nope"), TODAY), ExtractError);
});

test("throws ExtractError when validation fails twice", async () => {
  const bad = draftJson({ items: [{ name: "x", quantity: "1", unitAmount: "-5" }] });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("rejects wrong types (boolean quantity)", async () => {
  const bad = draftJson({ items: [{ name: "x", quantity: true, unitAmount: "5" }] });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("rejects negative price", async () => {
  const bad = draftJson({ items: [{ name: "x", quantity: "1", unitAmount: "-5" }] });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("rejects a huge quantity", async () => {
  const bad = draftJson({ items: [{ name: "x", quantity: "999999999", unitAmount: "1" }] });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("rejects more than 20 items", async () => {
  const items = Array.from({ length: 21 }, (_, i) => ({ name: `i${i}`, quantity: "1", unitAmount: "1" }));
  const bad = draftJson({ items });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("rejects a non-object JSON value", async () => {
  await assert.rejects(extractDraft("job", aiOnce('["not","an","object"]'), TODAY), ExtractError);
});

test("defaults currency to USD when missing", async () => {
  const json = draftJson({ currency: undefined });
  const draft = await extractDraft("job", aiOnce(JSON.stringify(JSON.parse(json))), TODAY);
  assert.equal(draft.currency, "USD");
});

test("defaults currency to USD when invalid", async () => {
  const draft = await extractDraft("job", aiOnce(draftJson({ currency: "JPY" })), TODAY);
  assert.equal(draft.currency, "USD");
});

test("normalises money to two decimal places", async () => {
  const draft = await extractDraft("job", aiOnce(draftJson({ items: [{ name: "x", quantity: "1", unitAmount: "45.5" }] })), TODAY);
  assert.equal(draft.items[0]!.unitAmount, "45.50");
});

test("normalises quantity to at most three decimal places", async () => {
  const draft = await extractDraft(
    "job",
    aiOnce(draftJson({ items: [{ name: "x", quantity: "0.333333", unitAmount: "45" }] })),
    TODAY,
  );
  assert.equal(draft.items[0]!.quantity, "0.333");
});

test("rejects tax percent above 30", async () => {
  const bad = draftJson({ taxPercent: "35" });
  await assert.rejects(extractDraft("job", aiOnce(bad), TODAY), ExtractError);
});

test("truncates item names over 120 characters", async () => {
  const long = "a".repeat(200);
  const draft = await extractDraft("job", aiOnce(draftJson({ items: [{ name: long, quantity: "1", unitAmount: "1" }] })), TODAY);
  assert.equal(draft.items[0]!.name.length, 120);
});

test("warns on missing email and missing name", async () => {
  const json = draftJson({ customerEmail: null, customerName: "" });
  const draft = await extractDraft("job", aiOnce(json), TODAY);
  assert.equal(draft.customerName, "Customer");
  assert.ok(draft.warnings.includes("No customer email"));
  assert.ok(draft.warnings.includes("No customer name"));
});

test("warns on a zero-priced item", async () => {
  const json = draftJson({ items: [{ name: "Free", quantity: "1", unitAmount: "0" }] });
  const draft = await extractDraft("job", aiOnce(json), TODAY);
  assert.ok(draft.warnings.includes("Item priced at 0"));
});

test("warns when total exceeds 10000", async () => {
  const json = draftJson({ items: [{ name: "Big", quantity: "1", unitAmount: "12000" }], taxPercent: null });
  const draft = await extractDraft("job", aiOnce(json), TODAY);
  assert.ok(draft.warnings.includes("Total above 10000"));
});

test("warns when the text mentions VAT but tax is missing", async () => {
  const json = draftJson({ taxPercent: null });
  const draft = await extractDraft("plus 23 percent VAT please", aiOnce(json), TODAY);
  assert.equal(draft.taxPercent, null);
  assert.ok(draft.warnings.includes("VAT mentioned but no tax percent"));
});

test("strips extra fields the AI should not compute", async () => {
  const json = draftJson({ total: "999", subtotal: "1" });
  const draft = await extractDraft("job", aiOnce(json), TODAY);
  assert.equal(draft.items.length, 2);
});

test("includes the description and date in the prompt", async () => {
  let seen: Messages = [];
  const ai: AiRunner = async (messages) => {
    seen = messages;
    return draftJson();
  };
  await extractDraft("fixed a tap for 2 hours", ai, TODAY);
  const joined = seen.map((m) => m.content).join("\n");
  assert.match(joined, /fixed a tap for 2 hours/);
  assert.match(joined, /2026-10-17/);
  assert.match(joined, /NEVER compute or return any totals/);
});
