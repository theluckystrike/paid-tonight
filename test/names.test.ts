import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDraft } from "../src/extract.js";
import { needsNameCheck, splitCustomerName, stripHonorific } from "../src/names.js";
import type { AiRunner } from "../src/types.js";

const TODAY = "2026-10-17";

function aiOnce(response: string): AiRunner {
  return async () => response;
}

function draftJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    customerName: "Anna Kowalski",
    customerEmail: "anna@example.com",
    currency: "EUR",
    items: [{ name: "Labour", quantity: "2", unitAmount: "45", unit: "HOURS" }],
    taxPercent: null,
    note: null,
    ...overrides,
  });
}

test("R4: stripHonorific removes the listed honorifics", () => {
  const cases: Array<[string, string]> = [
    ["Pani Anna Nowak", "Anna Nowak"],
    ["Pan Jan Kowalski", "Jan Kowalski"],
    ["Panią Annę Nowak", "Annę Nowak"],
    ["Herr Thomas Müller", "Thomas Müller"],
    ["Herrn Thomas Müller", "Thomas Müller"],
    ["Frau Eva Schmidt", "Eva Schmidt"],
    ["Mrs Anna Smith", "Anna Smith"],
    ["Mr John Smith", "John Smith"],
    ["Ms Jane Doe", "Jane Doe"],
    ["Miss Jane Doe", "Jane Doe"],
    ["Dr. Anna Kowalski", "Anna Kowalski"],
    ["Mme Marie Curie", "Marie Curie"],
    ["Mlle Marie Curie", "Marie Curie"],
    ["M. Jean Dupont", "Jean Dupont"],
    ["Sr. Juan Pérez", "Juan Pérez"],
    ["Sra. Ana Pérez", "Ana Pérez"],
    ["Sig. Marco Rossi", "Marco Rossi"],
    ["Sig.ra Maria Rossi", "Maria Rossi"],
    ["Dr. Mrs Anna Smith", "Anna Smith"],
  ];
  for (const [input, expected] of cases) assert.equal(stripHonorific(input), expected, input);
});

test("R4: splitCustomerName splits after stripping the honorific", () => {
  assert.deepEqual(splitCustomerName("Pani Anna Nowak"), { fullName: "Anna Nowak", givenName: "Anna", surname: "Nowak" });
  assert.deepEqual(splitCustomerName("Sig.ra Maria Rossi"), { fullName: "Maria Rossi", givenName: "Maria", surname: "Rossi" });
  assert.deepEqual(splitCustomerName("Dr. Anna Kowalski"), { fullName: "Anna Kowalski", givenName: "Anna", surname: "Kowalski" });
});

test("R4: Polish genitive after u, dla or od asks for a name check", () => {
  assert.equal(needsNameCheck("Naprawa dla Pani Anny Nowak"), true);
  assert.equal(needsNameCheck("u Pani Anny Nowak"), true);
  assert.equal(needsNameCheck("zapłata od Anny Nowak"), true);
  assert.equal(needsNameCheck("Naprawa dla Anny Nowak"), true);
  assert.equal(needsNameCheck("Fixed the tap for Anna Nowak"), false);
});

test("R4: extraction strips an honorific and warns on a Polish genitive name", async () => {
  const draft = await extractDraft(
    "Naprawa bojlera dla Pani Anny Nowak, anna@example.com, 2 godziny po 45, 19 % VAT",
    aiOnce(draftJson({ customerName: "Pani Anna Nowak", taxPercent: "19" })),
    TODAY,
  );
  assert.equal(draft.customerName, "Anna Nowak");
  assert.ok(draft.warnings.some((w) => w.includes("check the customer name")), draft.warnings.join(" | "));
});

test("R4: a plain name does not get the Polish name warning", async () => {
  const draft = await extractDraft("Fixed a tap for Anna Kowalski, anna@example.com", aiOnce(draftJson()), TODAY);
  assert.equal(draft.customerName, "Anna Kowalski");
  assert.ok(!draft.warnings.some((w) => w.includes("genitive")));
});
