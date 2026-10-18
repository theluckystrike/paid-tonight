import { test } from "node:test";
import assert from "node:assert/strict";
import { PayPal } from "../src/paypal";
import { PayPalError } from "../src/types";
import type { InvoiceDraft } from "../src/types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface Req {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetch(handler: (req: Req) => Response | Promise<Response>): { fetch: typeof fetch; calls: Req[] } {
  const calls: Req[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
    else if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    const req: Req = {
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.search,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponse(): Response {
  return json({ access_token: "tok123", expires_in: 3600 });
}

function baseDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    customerName: "Anna Kowalski",
    customerEmail: "anna@example.com",
    currency: "USD",
    items: [],
    taxPercent: null,
    note: null,
    warnings: [],
    ...overrides,
  };
}

test("token: sends client credentials and caches the token", async () => {
  const { fetch, calls } = makeFetch((req) => tokenResponse());
  const pp = new PayPal("cid", "sec", fetch);
  const t1 = await pp.token();
  const t2 = await pp.token();
  assert.equal(t1, "tok123");
  assert.equal(t2, "tok123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.path, "/v1/oauth2/token");
  assert.equal(calls[0]?.body, "grant_type=client_credentials");
  assert.equal(calls[0]?.headers["Authorization"], `Basic ${btoa("cid:sec")}`);
  assert.equal(calls[0]?.headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("token: refetches when the token is within 60s of expiry", async () => {
  const { fetch, calls } = makeFetch((req) => json({ access_token: "tok", expires_in: 1 }));
  const pp = new PayPal("cid", "sec", fetch);
  await pp.token();
  await pp.token();
  assert.equal(calls.length, 2);
});

test("createDraft: builds the invoice payload with email", async () => {
  const { fetch, calls } = makeFetch((req) => {
    if (req.path === "/v1/oauth2/token") return tokenResponse();
    if (req.path === "/v2/invoicing/invoices") return json({ id: "INV2-123", href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-123" }, 201);
    return json({}, 404);
  });
  const pp = new PayPal("cid", "sec", fetch);
  const draft = baseDraft({
    taxPercent: "23",
    note: "Kitchen tap",
    items: [
      { name: "Labour", quantity: "2", unitAmount: "45.00", unit: "HOURS" },
      { name: "Tap", quantity: "1", unitAmount: "89.99", unit: "AMOUNT" },
    ],
  });
  const result = await pp.createDraft(draft, { businessName: "ACME Plumbing" });
  assert.equal(result.id, "INV2-123");
  assert.equal(result.href, "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-123");
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  assert.ok(create);
  assert.equal(create.method, "POST");
  assert.equal(create.headers["Authorization"], "Bearer tok123");
  assert.deepEqual(JSON.parse(create.body ?? "{}"), {
    detail: { currency_code: "USD", note: "Kitchen tap", payment_term: { term_type: "DUE_ON_RECEIPT" } },
    invoicer: { business_name: "ACME Plumbing" },
    primary_recipients: [{ billing_info: { name: { full_name: "Anna Kowalski", given_name: "Anna", surname: "Kowalski" }, email_address: "anna@example.com" } }],
    items: [
      { name: "Labour", quantity: "2", unit_amount: { currency_code: "USD", value: "45.00" }, unit_of_measure: "HOURS", tax: { name: "Tax", percent: "23" } },
      { name: "Tap", quantity: "1", unit_amount: { currency_code: "USD", value: "89.99" }, unit_of_measure: "AMOUNT", tax: { name: "Tax", percent: "23" } },
    ],
  });
});

test("createDraft: omits email_address and note when null", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-9" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  const result = await pp.createDraft(
    baseDraft({ customerEmail: null, items: [{ name: "Tap", quantity: "1", unitAmount: "89.99" }] }),
    { businessName: "ACME" },
  );
  assert.equal(result.id, "INV-9");
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  assert.ok(create);
  const body = JSON.parse(create.body ?? "{}");
  assert.deepEqual(body.detail, { currency_code: "USD", payment_term: { term_type: "DUE_ON_RECEIPT" } });
  assert.deepEqual(body.primary_recipients, [{ billing_info: { name: { full_name: "Anna Kowalski", given_name: "Anna", surname: "Kowalski" } } }]);
});

test("createDraft: derives id from href when id is absent", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV-42" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  const result = await pp.createDraft(baseDraft({ customerEmail: null }), { businessName: "B" });
  assert.equal(result.id, "INV-42");
  assert.equal(result.href, "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV-42");
});

test("send: sends to recipient by default", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response(null, { status: 204 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.send("INV-1");
  const send = calls.find((c) => c.path.endsWith("/send"));
  assert.ok(send);
  assert.equal(send.method, "POST");
  assert.deepEqual(JSON.parse(send.body ?? "{}"), { send_to_invoicer: false, send_to_recipient: true });
});

test("send: no recipient when there is no email", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response("", { status: 202 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.send("INV-1", false);
  const send = calls.find((c) => c.path.endsWith("/send"));
  assert.ok(send);
  assert.deepEqual(JSON.parse(send.body ?? "{}"), { send_to_recipient: false });
});

test("qr: returns clean base64 from a plain body", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response(PNG, { status: 200 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  assert.equal(await pp.qr("INV-1"), PNG);
});

test("qr: extracts base64 from a multipart body", async () => {
  const multipart = [
    "--BOUNDARY",
    "Content-Type: image/png",
    'Content-Disposition: form-data; name="file"; filename="qr.png"',
    "",
    PNG,
    "--BOUNDARY--",
    "",
  ].join("\r\n");
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response(multipart, { status: 200 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  assert.equal(await pp.qr("INV-1"), PNG);
});

test("qr: joins base64 wrapped across lines and strips headers", async () => {
  const wrapped = PNG.match(/.{1,20}/g)!.join("\r\n");
  const body = `Content-Type: multipart/form-data; boundary=XYZ\r\n--XYZ\r\nContent-Type: image/png\r\n\r\n${wrapped}\r\n--XYZ--\r\n`;
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response(body, { status: 200 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  assert.equal(await pp.qr("INV-1"), PNG);
});

test("qr: throws when there is no base64 payload", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response("Content-Type: image/png\r\n\r\nnot base64!!", { status: 200 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await assert.rejects(() => pp.qr("INV-1"), /no base64 PNG payload/);
});

test("listUnpaid: filters statuses and maps fields", async () => {
  const { fetch, calls } = makeFetch((req) => {
    if (req.path === "/v1/oauth2/token") return tokenResponse();
    return json({
      items: [
        {
          id: "INV-1", status: "SENT",
          detail: { invoice_number: "0001", invoice_date: "2026-10-17", due_date: "2026-10-17" },
          amount: { currency_code: "USD", value: "221.39" },
          primary_recipients: [{ billing_info: { name: { full_name: "Anna Kowalski" }, email_address: "anna@example.com" } }],
        },
        {
          id: "INV-2", status: "UNPAID",
          detail: { invoice_number: "0002", invoice_date: "2026-10-01", due_date: "2026-10-01" },
          amount: { currency_code: "USD", value: "45.00" },
          primary_recipients: [{ billing_info: { name: { full_name: "Bob" } } }],
        },
        {
          id: "INV-3", status: "PARTIALLY_PAID",
          detail: { invoice_number: "0003" },
          amount: { currency_code: "EUR", value: "10.00" },
          primary_recipients: [],
        },
        { id: "INV-4", status: "PAID", detail: { invoice_number: "0004" }, amount: { currency_code: "USD", value: "1.00" }, primary_recipients: [] },
        { id: "INV-5", status: "CANCELLED", detail: { invoice_number: "0005" }, amount: { currency_code: "USD", value: "2.00" }, primary_recipients: [] },
        null,
      ],
    });
  });
  const pp = new PayPal("cid", "sec", fetch);
  const list = await pp.listUnpaid();
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], {
    id: "INV-1", number: "0001", status: "SENT", customerName: "Anna Kowalski",
    customerEmail: "anna@example.com", total: "221.39", dueAmount: "221.39", currency: "USD",
    dueDate: "2026-10-17", invoiceDate: "2026-10-17", payUrl: null,
  });
  assert.equal(list[1]?.number, "0002");
  assert.equal(list[1]?.customerEmail, null);
  assert.equal(list[2]?.status, "PARTIALLY_PAID");
  const listCall = calls.find((c) => c.path === "/v2/invoicing/invoices" && c.method === "GET");
  assert.ok(listCall);
  assert.equal(listCall.search, "?page=1&page_size=50&total_required=true");
});

test("remind: posts only send_to_invoicer false (PayPal ignores custom subject and note)", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : new Response(null, { status: 204 }),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.remind("INV-1");
  const remind = calls.find((c) => c.path.endsWith("/remind"));
  assert.ok(remind);
  assert.equal(remind.method, "POST");
  assert.deepEqual(JSON.parse(remind.body ?? "{}"), { send_to_invoicer: false });
});

test("non-2xx throws PayPalError with details description and debug_id", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token"
      ? tokenResponse()
      : json({ name: "INVALID_REQUEST", message: "Request is not well-formed", debug_id: "abc-123", details: [{ field: "x", description: "Detailed description" }] }, 400),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await assert.rejects(() => pp.get("INV-1"), (err: unknown) => {
    assert.ok(err instanceof PayPalError);
    assert.equal((err as PayPalError).status, 400);
    assert.equal((err as PayPalError).message, "x: Detailed description");
    assert.equal((err as PayPalError).debugId, "abc-123");
    return true;
  });
});

test("error message falls back to message then name", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ name: "RESOURCE_NOT_FOUND" }, 404),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await assert.rejects(() => pp.get("INV-1"), (err: unknown) => {
    assert.ok(err instanceof PayPalError);
    assert.equal((err as PayPalError).status, 404);
    assert.equal((err as PayPalError).message, "RESOURCE_NOT_FOUND");
    return true;
  });
});

test("network failure throws PayPalError with status 0", async () => {
  const failingFetch = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const pp = new PayPal("cid", "sec", failingFetch);
  await assert.rejects(() => pp.get("INV-1"), (err: unknown) => {
    assert.ok(err instanceof PayPalError);
    assert.equal((err as PayPalError).status, 0);
    assert.equal((err as PayPalError).message, "boom");
    return true;
  });
});

test("L2: every PayPal validation detail is shown with a readable field name", async () => {
  const { fetch } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse()
      : json({ name: "UNPROCESSABLE_ENTITY", details: [{ field: "/primary_recipients/0/billing_info/email_address", description: "Invalid email address." }, { field: "/items/1/unit_amount/value", description: "Must be positive." }] }, 422));
  const pp = new PayPal("cid", "sec", fetch);
  await assert.rejects(pp.get("INV-1"), (e: Error) => /Customer email: Invalid email address\. ; Item 2 price: Must be positive\./.test(e.message.replace(";", " ;")));
});

test("L1: a 401 drops the token and retries once with a fresh one", async () => {
  let tokens = 0, gets = 0;
  const { fetch } = makeFetch((req) => {
    if (req.path === "/v1/oauth2/token") { tokens++; return tokenResponse(); }
    gets++;
    return gets === 1 ? json({ name: "AUTHENTICATION_FAILURE" }, 401) : json({ id: "INV-1" });
  });
  const pp = new PayPal("cid", "sec", fetch);
  await pp.get("INV-1");
  assert.equal(tokens, 2);
  assert.equal(gets, 2);
});

test("L4: no tax given means no tax object on PayPal items", async () => {
  const { toPayPalItems } = await import("../src/money.js");
  const items = toPayPalItems({ customerName: "A", customerEmail: null, currency: "EUR", taxPercent: null, note: null, warnings: [], items: [{ name: "x", quantity: "1", unitAmount: "5.00" }] });
  assert.equal("tax" in items[0]!, false);
});

test("unpaid list reads the customer name when PayPal splits it into given_name and surname", async () => {
  const { mapInvoice } = await import("../src/paypal");
  const row = mapInvoice({ id: "INV2-X", status: "SENT", detail: { invoice_number: "PT-1" }, amount: { value: "10.00", currency_code: "EUR" },
    primary_recipients: [{ billing_info: { name: { given_name: "Ola", surname: "Nowak" }, email_address: "ola@example.com" } }] });
  assert.equal(row?.customerName, "Ola Nowak");
});

function unpaidItem(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, status: "SENT",
    detail: { invoice_number: id, invoice_date: "2026-10-17", due_date: "2026-10-17" },
    amount: { currency_code: "USD", value: "10.00" },
    primary_recipients: [],
    ...extra,
  };
}

test("R5: listUnpaid pages past the first 50 invoices", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => unpaidItem(`INV-A${i}`));
  const page2 = [unpaidItem("INV-B1"), unpaidItem("INV-B2")];
  const { fetch, calls } = makeFetch((req) => {
    if (req.path === "/v1/oauth2/token") return tokenResponse();
    return json({ items: req.search.includes("page=1") ? page1 : page2 });
  });
  const pp = new PayPal("cid", "sec", fetch);
  const list = await pp.listUnpaid();
  assert.equal(list.length, 52);
  const listCalls = calls.filter((c) => c.path === "/v2/invoicing/invoices");
  assert.equal(listCalls.length, 2);
  assert.match(listCalls[0]!.search, /page=1/);
  assert.match(listCalls[1]!.search, /page=2/);
  assert.equal(list[51]?.id, "INV-B2");
});

test("R5: a PARTIALLY_PAID invoice exposes its due_amount", async () => {
  const { fetch } = makeFetch((req) => req.path === "/v1/oauth2/token" ? tokenResponse() : json({ items: [
    unpaidItem("INV-P1", { status: "PARTIALLY_PAID", amount: { currency_code: "EUR", value: "100.00" }, due_amount: { currency_code: "EUR", value: "40.00" } }),
  ] }));
  const pp = new PayPal("cid", "sec", fetch);
  const list = await pp.listUnpaid();
  assert.equal(list[0]?.total, "100.00");
  assert.equal(list[0]?.dueAmount, "40.00");
});

test("R5: the unpaid invoice carries the recipient view link or a PayPal invoice link", async () => {
  const { fetch } = makeFetch((req) => req.path === "/v1/oauth2/token" ? tokenResponse() : json({ items: [
    unpaidItem("INV-L1", { detail: { invoice_number: "L1", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#L1" } } }),
    unpaidItem("INV-L2", { links: [{ rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p/#L2" }] }),
  ] }));
  const pp = new PayPal("cid", "sec", fetch);
  const list = await pp.listUnpaid();
  assert.equal(list[0]?.payUrl, "https://www.sandbox.paypal.com/invoice/p/#L1");
  assert.equal(list[1]?.payUrl, "https://www.sandbox.paypal.com/invoice/p/#L2");
});

test("R4: createDraft strips honorifics before splitting the name", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-NAME" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({ customerName: "Herrn Thomas Müller", items: [{ name: "Work", quantity: "1", unitAmount: "10.00" }] }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.deepEqual(body.primary_recipients[0].billing_info.name, { full_name: "Thomas Müller", given_name: "Thomas", surname: "Müller" });
});

test("R2: createDraft bakes a fixed discount into the unit prices and sends no discount object", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-DISC" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({
    currency: "EUR", taxPercent: "23", discount: "13.00",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }],
  }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.equal(body.amount, undefined);
  assert.equal("discount" in body.items[0], false);
  assert.equal("discount" in body.items[1], false);
  assert.equal(body.items[0].unit_amount.value, "45.00");
  assert.equal(body.items[1].unit_amount.value, "27.00");
  assert.equal(body.items[0].tax.percent, "23");
});

test("R2: createDraft sends an invoice-level discount when a fixed amount cannot split exactly", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-INVDISC" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({
    currency: "EUR", taxPercent: "23", discount: "10.00",
    items: [{ name: "Hours", quantity: "3", unitAmount: "33.33" }],
  }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.equal(body.items[0].unit_amount.value, "33.33");
  assert.equal("discount" in body.items[0], false);
  assert.deepEqual(body.amount, { currency_code: "EUR", breakdown: { discount: { invoice_discount: { amount: { currency_code: "EUR", value: "10.00" } } } } });
});

test("R2: the fallback invoice discount is sent as invoice_discount.amount and no item carries a discount", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-FB" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({
    currency: "USD", taxPercent: "10", discount: "10.00",
    items: [{ name: "Hours", quantity: "3", unitAmount: "33.33" }],
  }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.deepEqual(body.amount, { currency_code: "USD", breakdown: { discount: { invoice_discount: { amount: { currency_code: "USD", value: "10.00" } } } } });
  assert.equal(body.amount.breakdown.discount.invoice_discount.amount.value, "10.00");
  assert.equal(body.items[0].unit_amount.value, "33.33");
  for (const item of body.items) assert.equal("discount" in item, false);
});

test("R2: the baked cases carry no invoice_discount", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-BAKED" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({
    currency: "EUR", taxPercent: "23", discount: "13.00",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }],
  }), { businessName: "B" });
  const baked = JSON.parse(calls.find((c) => c.path === "/v2/invoicing/invoices")?.body ?? "{}");
  assert.equal("amount" in baked, false);
  calls.length = 0;
  await pp.createDraft(baseDraft({
    currency: "EUR", taxPercent: "23", discountPercent: "10",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }],
  }), { businessName: "B" });
  const percent = JSON.parse(calls.find((c) => c.path === "/v2/invoicing/invoices")?.body ?? "{}");
  assert.equal("amount" in percent, false);
});

test("R2: createDraft bakes a percentage discount into the unit prices and labels the line", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-PCT" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({
    currency: "EUR", taxPercent: "23", discountPercent: "10",
    items: [{ name: "Labour", quantity: "2", unitAmount: "50.00" }, { name: "Valve", quantity: "1", unitAmount: "30.00" }],
  }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.equal(body.amount, undefined);
  assert.equal(body.items[0].unit_amount.value, "45.00");
  assert.equal(body.items[1].unit_amount.value, "27.00");
  assert.equal(body.items[0].description, "10% off included");
  assert.equal("discount" in body.items[0], false);
});

test("R3: createDraft sends a 3 decimal tax percent as a string", async () => {
  const { fetch, calls } = makeFetch((req) =>
    req.path === "/v1/oauth2/token" ? tokenResponse() : json({ id: "INV-TAX" }, 201),
  );
  const pp = new PayPal("cid", "sec", fetch);
  await pp.createDraft(baseDraft({ currency: "USD", taxPercent: "8.875", items: [{ name: "Heater", quantity: "1", unitAmount: "1249.00" }] }), { businessName: "B" });
  const create = calls.find((c) => c.path === "/v2/invoicing/invoices");
  const body = JSON.parse(create?.body ?? "{}");
  assert.equal(body.items[0].tax.percent, "8.875");
});
