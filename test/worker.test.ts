import test from "node:test";
import assert from "node:assert/strict";
import worker, { maskEmail, WRITE_RATE_LIMIT_PER_HOUR } from "../src/worker.js";

// A fake PayPal sandbox: records calls, keeps invoices by id, answers like the Invoicing v2 API.
function fakePayPal(opts: { totalOverride?: string; qrFails?: boolean; payUrlAbsent?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
  const invoices = new Map<string, Record<string, unknown>>();
  let n = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? (String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.pathname === "/v1/oauth2/token") return Response.json({ access_token: "t", expires_in: 3600 });
    if (u.pathname === "/v2/invoicing/invoices" && init?.method === "POST") {
      const b = body as { detail: { invoice_number?: string }; items: Array<{ quantity: string; unit_amount: { value: string } }> };
      for (const inv of invoices.values()) if ((inv.detail as { invoice_number?: string }).invoice_number === b.detail.invoice_number) return Response.json({ name: "DUPLICATE_INVOICE_NUMBER", message: "dup" }, { status: 422 });
      const id = `INV2-${++n}`;
      const detail = opts.payUrlAbsent ? { ...b.detail } : { ...b.detail, metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } };
      invoices.set(id, { id, detail, amount: { value: opts.totalOverride ?? "", currency_code: "EUR" }, items: b.items, status: "DRAFT" });
      return Response.json({ href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}` }, { status: 201 });
    }
    if (u.pathname === "/v2/invoicing/invoices" && (init?.method ?? "GET") === "GET") return Response.json({ items: [...invoices.values()] });
    const m = /^\/v2\/invoicing\/invoices\/([^/]+)(?:\/(send|generate-qr-code|remind))?$/.exec(u.pathname);
    const inv = m ? invoices.get(decodeURIComponent(m[1]!)) : undefined;
    if (!inv) return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    if (m![2] === "send") { inv.status = "SENT"; return Response.json({ href: "x" }); }
    if (m![2] === "generate-qr-code") return opts.qrFails ? new Response("boom", { status: 500 }) : new Response("iVBORw0KGgo=");
    return Response.json(inv);
  }) as typeof fetch;
  return { calls, invoices, fetchFn };
}

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, m };
}

const draft = { customerName: "Ola", customerEmail: "ola@example.com", currency: "EUR", taxPercent: "23", discount: null, note: "Tap fixed", warnings: [],
  items: [{ name: "Labour", quantity: "1.5", unitAmount: "45" }, { name: "Part", quantity: "1", unitAmount: "12.50" }, { name: "Seal", quantity: "1", unitAmount: "6.50" }] };

async function call(env: Record<string, unknown>, path: string, payload: unknown, ct = "application/json") {
  const res = await worker.fetch(new Request("http://x" + path, { method: "POST", headers: { "content-type": ct }, body: JSON.stringify(payload) }), env as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function envWith(pp: ReturnType<typeof fakePayPal>, limits = kv()) {
  globalThis.fetch = pp.fetchFn;
  return { PAYPAL_CLIENT_ID: "c", PAYPAL_CLIENT_SECRET: "s", LIMITS: limits, AI: { run: async () => ({}) }, ASSETS: { fetch: async () => new Response("") } };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("send: PayPal's total must match before anything is sent; a mismatch sends nothing", async () => {
  const pp = fakePayPal({ totalOverride: "106.40" });
  const r = await call(envWith(pp), "/api/send", { draft, draftId: "ABCDEFGH12" });
  assert.equal(r.status, 409);
  assert.ok(!pp.calls.some((c) => c.path.endsWith("/send")));
});

test("send: invoice number from the draft id, request id header, and a retry neither duplicates nor re-sends", async () => {
  const pp = fakePayPal({ totalOverride: "106.41" });
  const env = envWith(pp);
  const first = await call(env, "/api/send", { draft, draftId: "ABCDEFGH12" });
  assert.equal(first.status, 200);
  assert.match(String(first.body.number), /^PT-ABCDEFGH12-[0-9A-F]{6}$/);
  assert.match(String(first.body.href), /sandbox\.paypal\.com/);
  const create = pp.calls.find((c) => c.path === "/v2/invoicing/invoices" && c.method === "POST")!;
  assert.equal(create.headers["PayPal-Request-Id"], first.body.number);
  const again = await call(env, "/api/send", { draft, draftId: "ABCDEFGH12" });
  assert.equal(again.status, 200);
  assert.equal(pp.calls.filter((c) => c.path === "/v2/invoicing/invoices" && c.method === "POST").length, 1);
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/send")).length, 1);
});

test("send: a QR failure after sending is a partial success, not an error", async () => {
  const pp = fakePayPal({ totalOverride: "106.41", qrFails: true });
  const r = await call(envWith(pp), "/api/send", { draft, draftId: "QRFAILS123" });
  assert.equal(r.status, 200);
  assert.equal(r.body.partial, true);
  assert.equal(r.body.qr, null);
});

test("send: the pay link falls back to the customer pay page, never an api link", async () => {
  const pp = fakePayPal({ totalOverride: "106.41", payUrlAbsent: true });
  const r = await call(envWith(pp), "/api/send", { draft, draftId: "PAYLINK123" });
  assert.equal(r.status, 200);
  assert.match(String(r.body.href), /^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#/);
  assert.equal(String(r.body.href).includes("api.sandbox"), false);
});

test("send: no email means PayPal does not email anyone", async () => {
  const pp = fakePayPal({ totalOverride: "106.41" });
  await call(envWith(pp), "/api/send", { draft: { ...draft, customerEmail: null }, draftId: "NOEMAIL123" });
  assert.deepEqual(pp.calls.find((c) => c.path.endsWith("/send"))!.body, { send_to_recipient: false });
});

test("send: an edited draft is validated before PayPal is called", async () => {
  const pp = fakePayPal();
  const env = envWith(pp);
  for (const bad of [{ ...draft, items: [{ name: "Discount", quantity: "1", unitAmount: "-15" }] }, { ...draft, taxPercent: "99" }, { ...draft, customerEmail: "lisa at gmail dot com" }, { ...draft, currency: "JPY" }]) {
    const r = await call(env, "/api/send", { draft: bad, draftId: "VALIDATE12" });
    assert.equal(r.status, 422, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(pp.calls.length, 0);
});

test("JSON only: a text/plain cross-site post is refused", async () => {
  const r = await call(envWith(fakePayPal()), "/api/totals", { draft }, "text/plain");
  assert.equal(r.status, 422);
});

test("remind: only an unpaid invoice can be reminded, and no custom text is sent", async () => {
  const pp = fakePayPal();
  const env = envWith(pp);
  const r = await call(env, "/api/remind", { id: "INV2-999" });
  assert.equal(r.status, 422);
  assert.ok(!pp.calls.some((c) => c.path.endsWith("/remind")));
});

test("N1: a corrected draft is never sent as the old invoice", async () => {
  const pp = fakePayPal({ totalOverride: "106.41" });
  const env = envWith(pp);
  // First try fails at the total check (PayPal disagrees), so nothing is sent.
  const bad = fakePayPal({ totalOverride: "1.00" });
  globalThis.fetch = bad.fetchFn;
  const r1 = await call(env, "/api/send", { draft: { ...draft, customerEmail: "olla@exmaple.com" }, draftId: "FIXEMAIL12" });
  assert.equal(r1.status, 409);
  globalThis.fetch = pp.fetchFn;
  const r2 = await call(env, "/api/send", { draft, draftId: "FIXEMAIL12" });
  assert.equal(r2.status, 200);
  const sentCreate = pp.calls.find((c) => c.path === "/v2/invoicing/invoices" && c.method === "POST")!;
  assert.equal((sentCreate.body as { primary_recipients: Array<{ billing_info: { email_address: string } }> }).primary_recipients[0]!.billing_info.email_address, "ola@example.com");
  // After sending, a changed draft under the same id is refused.
  const r3 = await call(env, "/api/send", { draft: { ...draft, note: "changed" }, draftId: "FIXEMAIL12" });
  assert.equal(r3.status, 409);
  assert.equal(pp.calls.filter((c) => c.path.endsWith("/send")).length, 1);
});

test("R12: an edited AI percent draft is accepted by /api/totals, one source of truth", async () => {
  // The extractor returns a percent draft with no separate amount, so editing a number cannot leave a stale amount behind.
  const percentDraft = {
    customerName: "Herr Weber", customerEmail: null, currency: "EUR", taxPercent: "19", note: null, warnings: [], discountPercent: "10",
    items: [
      { name: "Arbeit", quantity: "3.5", unitAmount: "65.50", unit: "HOURS" as const },
      { name: "Heizung", quantity: "1", unitAmount: "1249.00" },
    ],
  };
  const before = await call(envWith(fakePayPal()), "/api/totals", { draft: percentDraft });
  assert.equal(before.status, 200);
  assert.equal((before.body.totals as { discount: string }).discount, "147.82");
  percentDraft.items[0]!.quantity = "4";
  const after = await call(envWith(fakePayPal()), "/api/totals", { draft: percentDraft });
  assert.equal(after.status, 200);
  assert.equal((after.body.totals as { discount: string }).discount, "151.10");
});

test("H5: with DEMO_SEND_CODE set, PayPal routes need the code; drafting does not", async () => {
  const pp = fakePayPal({ totalOverride: "106.41" });
  const env = { ...envWith(pp), DEMO_SEND_CODE: "s3cret-code" };
  const no = await call(env, "/api/send", { draft, draftId: "CODECHECK1" });
  assert.equal(no.status, 401);
  assert.equal(pp.calls.length, 0);
  const res = await worker.fetch(new Request("http://x/api/send", { method: "POST", headers: { "content-type": "application/json", "x-demo-code": "s3cret-code" }, body: JSON.stringify({ draft, draftId: "CODECHECK1" }) }), env as never);
  assert.equal(res.status, 200);
  const totalsRes = await call(env, "/api/totals", { draft });
  assert.equal(totalsRes.status, 200);
});

test("R12: maskEmail keeps the first letter and the domain, and refuses anything that is not an address", () => {
  assert.equal(maskEmail("anna@example.com"), "a***@example.com");
  assert.equal(maskEmail("ola.nowak@firma.pl"), "o***@firma.pl");
  assert.equal(maskEmail(""), null);
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail("not an email"), null);
  assert.equal(maskEmail("anna@"), null);
  assert.equal(maskEmail("@x.com"), null);
});

test("R12: PayPal write routes are rate limited per address with a plain 429", async () => {
  const env = envWith(fakePayPal());
  const headers = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" };
  for (let i = 0; i < WRITE_RATE_LIMIT_PER_HOUR; i++) {
    // No unpaid invoice, so each call fails fast with 422 until the bucket is full.
    const res = await worker.fetch(new Request("http://x/api/remind", { method: "POST", headers, body: JSON.stringify({ id: "INV-X" }) }), env as never);
    assert.equal(res.status, 422, `call ${i + 1}`);
  }
  const blocked = await worker.fetch(new Request("http://x/api/remind", { method: "POST", headers, body: JSON.stringify({ id: "INV-X" }) }), env as never);
  assert.equal(blocked.status, 429);
  const body = await blocked.json() as { error?: string };
  assert.match(String(body.error), /^Too many requests from this address\./);
  // Another address has its own bucket.
  const other = await worker.fetch(new Request("http://x/api/remind", { method: "POST", headers: { ...headers, "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ id: "INV-X" }) }), env as never);
  assert.equal(other.status, 422);
});

test("R10: a rate limit store that throws fails open and logs once", async () => {
  const pp = fakePayPal();
  const throwing = { get: async () => { throw new Error("storage down"); }, put: async () => { throw new Error("storage down"); } };
  const env = { ...envWith(pp, throwing as never) };
  const headers = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" };
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map((a) => String(a)).join(" ")); };
  try {
    // The limiter fails open: the request reaches the handler and its normal 422, never a 500 from the store.
    const first = await worker.fetch(new Request("http://x/api/remind", { method: "POST", headers, body: JSON.stringify({ id: "INV-X" }) }), env as never);
    assert.equal(first.status, 422);
    const second = await worker.fetch(new Request("http://x/api/remind", { method: "POST", headers, body: JSON.stringify({ id: "INV-X" }) }), env as never);
    assert.equal(second.status, 422);
  } finally {
    console.log = real;
  }
  assert.equal(lines.filter((l) => /rate limit/i.test(l)).length, 1);
});
