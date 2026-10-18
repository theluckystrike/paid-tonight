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
    customerEmail: "anna@example.com", total: "221.39", currency: "USD",
    dueDate: "2026-10-17", invoiceDate: "2026-10-17",
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
