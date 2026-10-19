import test from "node:test";
import assert from "node:assert/strict";
import worker, { dayKeyInTimeZone } from "../src/worker.js";

interface InvoiceRow {
  id: string;
  status: string;
  detail: { invoice_number: string; metadata?: { recipient_view_url: string } };
  amount: { currency_code: string; value: string };
  due_amount?: { currency_code: string; value: string };
  primary_recipients: unknown[];
}

function invoice(id: string, status: string, total: string, due: string, name = "Ola"): InvoiceRow {
  return {
    id,
    status,
    detail: { invoice_number: id, metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } },
    amount: { currency_code: "EUR", value: total },
    due_amount: { currency_code: "EUR", value: due },
    primary_recipients: [{ billing_info: { name: { full_name: name } } }],
  };
}

interface Req {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakePayPal(opts: { verify?: string; verifyError?: boolean; verify4xx?: boolean; paymentTimesOut?: boolean; paymentTimesOutPaid?: boolean } = {}) {
  const calls: Req[] = [];
  const invoices = new Map<string, InvoiceRow>();
  let verification = opts.verify ?? "SUCCESS";
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: u.pathname, body, headers });
    if (u.pathname === "/v1/oauth2/token") return Response.json({ access_token: "t", expires_in: 3600 });
    if (u.pathname === "/v1/notifications/verify-webhook-signature") {
      if (opts.verifyError) return Response.json({ name: "INTERNAL_SERVER_ERROR" }, { status: 500 });
      if (opts.verify4xx) return Response.json({ name: "INVALID_REQUEST" }, { status: 400 });
      return Response.json({ verification_status: verification });
    }
    if (u.pathname === "/v1/notifications/webhooks" && method === "POST") return Response.json({ id: "WH-NEW" }, { status: 201 });
    if (u.pathname === "/v2/invoicing/invoices" && method === "GET") return Response.json({ items: [...invoices.values()] });
    const m = /^\/v2\/invoicing\/invoices\/([^/]+)(?:\/(payments|send|generate-qr-code|remind))?$/.exec(u.pathname);
    const inv = m ? invoices.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !inv) return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    if (m[2] === "payments") {
      const paid = body as { method: string; payment_date: string; amount: { currency_code: string; value: string } };
      if (opts.paymentTimesOut) throw new Error("The operation was aborted due to timeout");
      if (opts.paymentTimesOutPaid) {
        // PayPal recorded the payment but the answer never made it back to us.
        inv.status = "MARKED_AS_PAID";
        inv.due_amount = { currency_code: paid.amount.currency_code, value: "0.00" };
        throw new Error("The operation was aborted due to timeout");
      }
      inv.status = "MARKED_AS_PAID";
      inv.due_amount = { currency_code: paid.amount.currency_code, value: "0.00" };
      return Response.json({ payment_id: "PAY-1", ...paid });
    }
    if (m[2] === "send") { inv.status = "SENT"; return Response.json({ href: "x" }); }
    if (m[2] === "generate-qr-code") return new Response("iVBORw0KGgo=");
    return Response.json(inv);
  }) as typeof fetch;
  return { calls, invoices, fetchFn, setVerify: (v: string) => { verification = v; } };
}

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, m };
}

function envWith(pp: ReturnType<typeof fakePayPal>, limits = kv(), extra: Record<string, unknown> = {}) {
  globalThis.fetch = pp.fetchFn;
  return {
    PAYPAL_CLIENT_ID: "c", PAYPAL_CLIENT_SECRET: "s", PAYPAL_WEBHOOK_ID: "WH-1",
    LIMITS: limits, AI: { run: async () => ({}) }, ASSETS: { fetch: async () => new Response("") },
    ...extra,
  };
}

async function call(env: Record<string, unknown>, path: string, payload?: unknown, headers: Record<string, string> = {}, method?: string) {
  const init: RequestInit = { method: method ?? (payload === undefined ? "GET" : "POST"), headers: { "content-type": "application/json", ...headers } };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const res = await worker.fetch(new Request("https://paid.example" + path, init), env as never);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) { try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { text }; } }
  return { status: res.status, body };
}

function webhookHeaders(): Record<string, string> {
  return {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.paypal.com/cert.pem",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig-1",
    "paypal-transmission-time": "2026-10-18T10:00:00Z",
  };
}

function event(id: string, type: string, row: InvoiceRow) {
  return { id, event_type: type, resource: row };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
/** The Warsaw calendar day, matching the worker's Paid today key and cash payment date. */
const DAY = () => dayKeyInTimeZone(new Date(), "Europe/Warsaw");

test("R12: the Paid today day key is the Warsaw date, including a Warsaw evening that crosses UTC midnight", () => {
  // 22:30 UTC on 18 October is 00:30 on 19 October in Warsaw (CEST, UTC+2).
  assert.equal(dayKeyInTimeZone(new Date("2026-10-18T22:30:00Z"), "Europe/Warsaw"), "2026-10-19");
  // 21:30 UTC is still 23:30 on the same Warsaw day.
  assert.equal(dayKeyInTimeZone(new Date("2026-10-18T21:30:00Z"), "Europe/Warsaw"), "2026-10-18");
  // Winter time is UTC+1.
  assert.equal(dayKeyInTimeZone(new Date("2026-12-31T23:30:00Z"), "Europe/Warsaw"), "2027-01-01");
  // A UTC clock would call the first case the day before, which is the bug this fixes.
  assert.equal(dayKeyInTimeZone(new Date("2026-10-18T22:30:00Z"), "UTC"), "2026-10-18");
});

test("status endpoint reads PayPal live and returns status, paid amount and due amount", async () => {
  const pp = fakePayPal();
  pp.invoices.set("INV-1", invoice("INV-1", "PAID", "121.00", "0.00"));
  const r = await call(envWith(pp), "/api/invoice/INV-1/status");
  assert.equal(r.status, 200);
  const inv = r.body.invoice as Record<string, unknown>;
  assert.equal(inv.status, "PAID");
  assert.equal(inv.paidAmount, "121.00");
  assert.equal(inv.dueAmount, "0.00");
  assert.equal(inv.paid, true);
  assert.equal(r.body.source, "paypal");
});

test("status endpoint falls back to the stored webhook hint only when the live read fails", async () => {
  const pp = fakePayPal();
  const limits = kv();
  await limits.put("webhook:invoice:INV-GONE", JSON.stringify({
    id: "INV-GONE", number: "INV-GONE", status: "PAID", customerName: "Ola", total: "50.00",
    paidAmount: "50.00", dueAmount: "0.00", currency: "EUR", paid: true, eventId: "EV-9", at: "2026-10-18T10:00:00Z",
  }));
  const r = await call(envWith(pp, limits), "/api/invoice/INV-GONE/status");
  assert.equal(r.status, 200);
  assert.equal(r.body.source, "webhook");
  assert.equal((r.body.invoice as Record<string, unknown>).status, "PAID");
});

test("record-payment is guarded like send and posts CASH for the amount due", async () => {
  const pp = fakePayPal();
  pp.invoices.set("INV-C", invoice("INV-C", "UNPAID", "80.00", "80.00"));
  const locked = envWith(pp, kv(), { DEMO_SEND_CODE: "door-code" });
  const no = await call(locked, "/api/invoice/INV-C/record-payment", {});
  assert.equal(no.status, 401);
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/payments")).length, 0);

  const ok = await call(locked, "/api/invoice/INV-C/record-payment", {}, { "x-demo-code": "door-code" });
  assert.equal(ok.status, 200);
  const payment = pp.calls.find((c) => c.path.endsWith("/payments"));
  assert.ok(payment);
  assert.deepEqual(payment.body, {
    method: "CASH", payment_date: DAY(),
    amount: { currency_code: "EUR", value: "80.00" },
  });
  const inv = ok.body.invoice as Record<string, unknown>;
  assert.equal(inv.status, "MARKED_AS_PAID");
  assert.equal(inv.paid, true);
  assert.equal(inv.dueAmount, "0.00");
});

test("webhook rejects a forged event that fails verification and stores nothing", async () => {
  const pp = fakePayPal({ verify: "FAILURE" });
  pp.invoices.set("INV-F", invoice("INV-F", "PAID", "10.00", "0.00"));
  const limits = kv();
  const r = await call(envWith(pp, limits), "/api/paypal/webhook", event("EV-BAD", "INVOICING.INVOICE.PAID", pp.invoices.get("INV-F")!), webhookHeaders());
  assert.equal(r.status, 400);
  assert.equal(limits.m.has("webhook:invoice:INV-F"), false);
  assert.equal(limits.m.has("webhook:event:EV-BAD"), false);
});

test("webhook stores the latest status for an invoice and ignores a replayed event id", async () => {
  const pp = fakePayPal();
  const limits = kv();
  const env = envWith(pp, limits);
  const paidRow = invoice("INV-W", "PAID", "60.00", "0.00");
  const first = await call(env, "/api/paypal/webhook", event("EV-1", "INVOICING.INVOICE.PAID", paidRow), webhookHeaders());
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  const stored = JSON.parse(limits.m.get("webhook:invoice:INV-W") ?? "{}") as Record<string, unknown>;
  assert.equal(stored.status, "PAID");
  assert.equal(stored.paidAmount, "60.00");

  const replay = await call(env, "/api/paypal/webhook", event("EV-1", "INVOICING.INVOICE.CANCELLED", invoice("INV-W", "CANCELLED", "60.00", "0.00")), webhookHeaders());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  const after = JSON.parse(limits.m.get("webhook:invoice:INV-W") ?? "{}") as Record<string, unknown>;
  assert.equal(after.status, "PAID");
  assert.equal(pp.calls.filter((c) => c.path === "/v1/notifications/verify-webhook-signature").length, 2);
});

test("a refunded event updates the stored status", async () => {
  const pp = fakePayPal();
  const limits = kv();
  const r = await call(envWith(pp, limits), "/api/paypal/webhook",
    event("EV-REF", "INVOICING.INVOICE.REFUNDED", invoice("INV-R", "REFUNDED", "30.00", "0.00")), webhookHeaders());
  assert.equal(r.status, 200);
  const stored = JSON.parse(limits.m.get("webhook:invoice:INV-R") ?? "{}") as Record<string, unknown>;
  assert.equal(stored.status, "REFUNDED");
});

test("unpaid drops an invoice whose stored webhook status is PAID and shows it in Paid today", async () => {
  const pp = fakePayPal();
  pp.invoices.set("INV-P", invoice("INV-P", "SENT", "75.00", "75.00", "Anna"));
  pp.invoices.set("INV-O", invoice("INV-O", "SENT", "25.00", "25.00", "Bob"));
  const limits = kv();
  const record = {
    id: "INV-P", number: "INV-P", status: "PAID", customerName: "Anna", total: "75.00",
    paidAmount: "75.00", dueAmount: "0.00", currency: "EUR", paid: true, eventId: "EV-P", at: "2026-10-18T10:00:00Z",
  };
  await limits.put("webhook:invoice:INV-P", JSON.stringify(record));
  await limits.put(`webhook:paid:${DAY()}`, JSON.stringify([record]));
  const r = await call(envWith(pp, limits), "/api/unpaid");
  assert.equal(r.status, 200);
  const list = r.body.invoices as Array<{ id: string }>;
  assert.deepEqual(list.map((i) => i.id), ["INV-O"]);
  const paid = r.body.paidToday as Array<{ id: string; status: string }>;
  assert.equal(paid[0]?.id, "INV-P");
  assert.equal(paid[0]?.status, "PAID");
});

test("R12: /api/unpaid masks the customer email and keeps the domain", async () => {
  const pp = fakePayPal();
  const row = invoice("INV-M", "SENT", "20.00", "20.00", "Anna");
  (row.primary_recipients as Array<{ billing_info: Record<string, unknown> }>)[0]!.billing_info.email_address = "anna@example.com";
  pp.invoices.set("INV-M", row);
  const r = await call(envWith(pp), "/api/unpaid");
  assert.equal(r.status, 200);
  const list = r.body.invoices as Array<{ customerEmail: string | null }>;
  assert.equal(list[0]?.customerEmail, "a***@example.com");
  assert.equal(JSON.stringify(r.body).includes("anna@example.com"), false);
});

test("admin register-webhook refuses when the secret is not set and when the header is wrong", async () => {
  const pp = fakePayPal();
  const missing = await call(envWith(pp), "/api/admin/register-webhook", {});
  assert.equal(missing.status, 503);
  const wrong = await call(envWith(pp, kv(), { ADMIN_CODE: "admin-secret" }), "/api/admin/register-webhook", {}, { "x-admin-code": "nope" });
  assert.equal(wrong.status, 401);
  assert.equal(pp.calls.filter((c) => c.path === "/v1/notifications/webhooks").length, 0);
});

test("admin register-webhook registers the worker URL for the three events and returns the id", async () => {
  const pp = fakePayPal();
  const r = await call(envWith(pp, kv(), { ADMIN_CODE: "admin-secret" }), "/api/admin/register-webhook", {}, { "x-admin-code": "admin-secret" });
  assert.equal(r.status, 200);
  assert.equal(r.body.webhookId, "WH-NEW");
  assert.equal(r.body.url, "https://paid.example/api/paypal/webhook");
  const create = pp.calls.find((c) => c.path === "/v1/notifications/webhooks");
  assert.deepEqual(create?.body, {
    url: "https://paid.example/api/paypal/webhook",
    event_types: [
      { name: "INVOICING.INVOICE.PAID" },
      { name: "INVOICING.INVOICE.CANCELLED" },
      { name: "INVOICING.INVOICE.REFUNDED" },
    ],
  });
});

test("record-payment that times out while PayPal is still working returns 202 pending, not an error", async () => {
  const pp = fakePayPal({ paymentTimesOut: true });
  pp.invoices.set("INV-PEND", invoice("INV-PEND", "UNPAID", "45.00", "45.00"));
  const r = await call(envWith(pp), "/api/invoice/INV-PEND/record-payment", {});
  assert.equal(r.status, 202);
  assert.equal(r.body.pending, true);
  assert.equal(r.body.message, "PayPal is still recording the payment. Tap Refresh in a minute.");
  assert.equal(r.body.error, undefined);
  assert.equal(pp.invoices.get("INV-PEND")?.status, "UNPAID");
});

test("record-payment that times out but PayPal did record it returns the paid invoice as success", async () => {
  const pp = fakePayPal({ paymentTimesOutPaid: true });
  pp.invoices.set("INV-TP", invoice("INV-TP", "UNPAID", "45.00", "45.00"));
  const r = await call(envWith(pp), "/api/invoice/INV-TP/record-payment", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.pending, undefined);
  const inv = r.body.invoice as Record<string, unknown>;
  assert.equal(inv.status, "MARKED_AS_PAID");
  assert.equal(inv.paid, true);
  assert.equal(inv.dueAmount, "0.00");
});

test("record-payment refuses with 409 when nothing is due and never posts a payment", async () => {
  const pp = fakePayPal();
  pp.invoices.set("INV-Z", invoice("INV-Z", "PAID", "50.00", "0.00"));
  const r = await call(envWith(pp), "/api/invoice/INV-Z/record-payment", {});
  assert.equal(r.status, 409);
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/payments")).length, 0);
});

/** Run something with console.log captured, one line per call. */
async function logsOf(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try { await run(); } finally { console.log = real; }
  return lines;
}

test("webhook reads the nested resource.invoice shape and stores the paid amount", async () => {
  const pp = fakePayPal();
  const limits = kv();
  const nested = {
    id: "EV-NEST", event_type: "INVOICING.INVOICE.PAID",
    resource: {
      invoice: {
        id: "INV-NEST", status: "PAID", detail: { invoice_number: "PT-NEST" },
        amount: { currency_code: "EUR", value: "121.00" },
        payments: { paid_amount: { currency_code: "EUR", value: "121.00" } },
        due_amount: { currency_code: "EUR", value: "0.00" },
      },
    },
  };
  const r = await call(envWith(pp, limits), "/api/paypal/webhook", nested, webhookHeaders());
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "PAID");
  const stored = JSON.parse(limits.m.get("webhook:invoice:INV-NEST") ?? "{}") as Record<string, unknown>;
  assert.equal(stored.id, "INV-NEST");
  assert.equal(stored.status, "PAID");
  assert.equal(stored.paidAmount, "121.00");
  assert.equal(stored.dueAmount, "0.00");
  assert.equal(stored.paid, true);
});

test("webhook reads an invoice sitting directly on resource, with the paid amount under payments", async () => {
  const pp = fakePayPal();
  const limits = kv();
  const direct = {
    id: "EV-DIRECT", event_type: "INVOICING.INVOICE.PAID",
    resource: {
      id: "INV-DIRECT", status: "PAID", amount: { currency_code: "EUR", value: "50.00" },
      payments: { paid_amount: { value: "50.00" } }, due_amount: { value: "0.00" },
    },
  };
  const r = await call(envWith(pp, limits), "/api/paypal/webhook", direct, webhookHeaders());
  assert.equal(r.status, 200);
  const stored = JSON.parse(limits.m.get("webhook:invoice:INV-DIRECT") ?? "{}") as Record<string, unknown>;
  assert.equal(stored.id, "INV-DIRECT");
  assert.equal(stored.status, "PAID");
  assert.equal(stored.paidAmount, "50.00");
  assert.equal(stored.dueAmount, "0.00");
});

test("webhook verification that errors asks PayPal to retry with 503 and stores nothing", async () => {
  const pp = fakePayPal({ verifyError: true });
  const limits = kv();
  const r = await call(envWith(pp, limits), "/api/paypal/webhook",
    event("EV-ERR", "INVOICING.INVOICE.PAID", invoice("INV-ERR", "PAID", "10.00", "0.00")), webhookHeaders());
  assert.equal(r.status, 503);
  assert.equal(limits.m.has("webhook:invoice:INV-ERR"), false);
  assert.equal(limits.m.has("webhook:event:EV-ERR"), false);
});

test("webhook verification answered with a 4xx is refused with 400, not a retry", async () => {
  const pp = fakePayPal({ verify4xx: true });
  const limits = kv();
  const r = await call(envWith(pp, limits), "/api/paypal/webhook",
    event("EV-4XX", "INVOICING.INVOICE.PAID", invoice("INV-4XX", "PAID", "10.00", "0.00")), webhookHeaders());
  assert.equal(r.status, 400);
  assert.equal(limits.m.has("webhook:invoice:INV-4XX"), false);
  assert.equal(limits.m.has("webhook:event:EV-4XX"), false);
});

test("webhook logs one safe line per event with the type, the id and a reason code", async () => {
  const env = envWith(fakePayPal(), kv());
  const stored = await logsOf(() => call(env, "/api/paypal/webhook", event("EV-L1", "INVOICING.INVOICE.PAID", invoice("INV-L1", "PAID", "10.00", "0.00")), webhookHeaders()));
  assert.deepEqual(stored, ["paypal webhook INVOICING.INVOICE.PAID EV-L1 stored"]);

  const duplicate = await logsOf(() => call(env, "/api/paypal/webhook", event("EV-L1", "INVOICING.INVOICE.PAID", invoice("INV-L1", "PAID", "10.00", "0.00")), webhookHeaders()));
  assert.deepEqual(duplicate, ["paypal webhook INVOICING.INVOICE.PAID EV-L1 duplicate"]);

  const ignored = await logsOf(() => call(env, "/api/paypal/webhook", event("EV-L2", "INVOICING.INVOICE.SENT", invoice("INV-L2", "SENT", "10.00", "10.00")), webhookHeaders()));
  assert.deepEqual(ignored, ["paypal webhook INVOICING.INVOICE.SENT EV-L2 ignored"]);

  const noInvoice = await logsOf(() => call(env, "/api/paypal/webhook", { id: "EV-L3", event_type: "INVOICING.INVOICE.PAID", resource: { status: "PAID" } }, webhookHeaders()));
  assert.deepEqual(noInvoice, ["paypal webhook INVOICING.INVOICE.PAID EV-L3 no_invoice_id"]);

  const failure = await logsOf(() => call(envWith(fakePayPal({ verify: "FAILURE" })), "/api/paypal/webhook", event("EV-L4", "INVOICING.INVOICE.PAID", invoice("INV-L4", "PAID", "10.00", "0.00")), webhookHeaders()));
  assert.deepEqual(failure, ["paypal webhook INVOICING.INVOICE.PAID EV-L4 verify_failure"]);

  const error = await logsOf(() => call(envWith(fakePayPal({ verifyError: true })), "/api/paypal/webhook", event("EV-L5", "INVOICING.INVOICE.PAID", invoice("INV-L5", "PAID", "10.00", "0.00")), webhookHeaders()));
  assert.deepEqual(error, ["paypal webhook INVOICING.INVOICE.PAID EV-L5 verify_error"]);
});

test("webhook logs never include a header, a body or a secret", async () => {
  const lines = await logsOf(() => call(envWith(fakePayPal(), kv()), "/api/paypal/webhook",
    event("EV-L6", "INVOICING.INVOICE.PAID", invoice("INV-L6", "PAID", "10.00", "0.00")), webhookHeaders()));
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  for (const secret of ["sig-1", "tid-1", "cert.pem", "SHA256withRSA", "paypal-transmission", "billing_info", "resource"]) {
    assert.equal(line.includes(secret), false, `the log leaked ${secret}`);
  }
});
