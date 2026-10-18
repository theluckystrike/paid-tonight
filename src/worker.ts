import { extractDraft } from "./extract.js";
import { takeAiCall, type Counter } from "./limit.js";
import { discountWarning, totals } from "./money.js";
import { mapStatus, PAID_STATUSES, PaymentPendingError, PayPal, payUrlOf, WEBHOOK_EVENTS } from "./paypal.js";
import { draftReminder } from "./reminder.js";
import { ExtractError, PayPalError, type AiRunner, type InvoiceDraft, type InvoiceStatus } from "./types.js";
import { DraftInvalid, validateDraft } from "./validate.js";

interface Env {
  AI: { run: (model: string, input: unknown) => Promise<{ response?: unknown }> };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  LIMITS?: Counter;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  BUSINESS_NAME?: string;
  AI_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Optional: when set, the PayPal routes (send, unpaid, reminder, remind, record payment) need this code in the x-demo-code header. */
  DEMO_SEND_CODE?: string;
  /** Set by the owner after POST /api/admin/register-webhook returns it. Every webhook is checked against it. */
  PAYPAL_WEBHOOK_ID?: string;
  /** Required for the admin webhook setup route. When it is not set, that route refuses every request. */
  ADMIN_CODE?: string;
}

const WEBHOOK_TTL = 30 * 86400;
const WEBHOOK_EVENT_PREFIX = "webhook:event:";
const WEBHOOK_INVOICE_PREFIX = "webhook:invoice:";
const PAID_TODAY_PREFIX = "webhook:paid:";
const NOT_OPEN = new Set([...PAID_STATUSES, "CANCELLED", "REFUNDED"]);

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** The local calendar day, so a payment made at 11pm sits under today, not tomorrow's UTC date. */
function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function aiRunner(env: Env): AiRunner {
  return async (messages) => {
    if (!(await takeAiCall(env.LIMITS, today()))) throw new ExtractError("The demo reached today's AI limit. Please try again tomorrow, or run it yourself with the README steps.");
    const out = await env.AI.run(MODEL, { messages, max_tokens: 900, temperature: 0.1 });
    return typeof out.response === "string" ? out.response : JSON.stringify(out.response ?? "");
  };
}

// One client per isolate, so the OAuth token cache survives across requests.
let cached: { key: string; client: PayPal } | null = null;
function paypal(env: Env): PayPal {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new PayPalError(503, "PayPal sandbox credentials are not configured on this server.");
  const key = env.PAYPAL_CLIENT_ID;
  if (!cached || cached.key !== key) cached = { key, client: new PayPal(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET) };
  return cached.client;
}

function fail(err: unknown): Response {
  if (err instanceof DraftInvalid) return Response.json({ error: "Check the draft: " + err.fields.join("; "), fields: err.fields }, { status: 422 });
  if (err instanceof ExtractError) return Response.json({ error: err.message }, { status: 422 });
  if (err instanceof PayPalError) {
    const message = /^PayPal\b/.test(err.message) ? err.message : `PayPal says ${err.message}`;
    return Response.json({ error: message, debugId: err.debugId ?? null }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 });
  }
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

async function body<T>(request: Request): Promise<T> {
  // JSON only (parsed MIME type): a cross-site form or text/plain post cannot reach PayPal through this server.
  const essence = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") throw new ExtractError("Send JSON with content-type application/json.");
  if (Number(request.headers.get("content-length") ?? "0") > 20_000) throw new ExtractError("The request is too large.");
  const text = await request.text();
  if (text.length > 20_000) throw new ExtractError("The request is too large.");
  try { return JSON.parse(text) as T; } catch { throw new ExtractError("Send JSON."); }
}

type Handler = (request: Request, env: Env) => Promise<Response>;

const GUARDED = new Set(["POST /api/send", "GET /api/unpaid", "POST /api/reminder", "POST /api/remind", "POST /api/invoice/{id}/record-payment"]);

/** Constant-time comparison of the access code. */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Per-address brake on AI calls, so one visitor cannot use up the shared daily cap. */
async function perAddress(req: Request, env: Env): Promise<void> {
  const key = req.headers.get("cf-connecting-ip") ?? "local";
  if (env.AI_LIMIT && !(await env.AI_LIMIT.limit({ key })).success) throw new ExtractError("Too many drafts from this address. Wait a minute and try again.");
}

const DRAFT_ID = /^[A-Za-z0-9]{8,16}$/;
interface SentRecord { invoiceId: string; sent: boolean; hash: string }

/** Short content hash of the validated draft: a retry is the same invoice only if the content is the same. */
async function draftHash(draft: InvoiceDraft): Promise<string> {
  const { warnings: _w, ...content } = draft;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(digest).slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Create, check, send. The draft is validated first. The record per draft id holds the content hash: the same content
 * retried returns the same invoice; corrected content before sending replaces the unsent PayPal draft (new invoice
 * number); corrected content after sending is refused, because PayPal has already emailed the customer. PayPal's own
 * total must equal ours before sending; the QR code and the read after sending are optional (partial success).
 */
async function send(req: Request, env: Env): Promise<Response> {
  const input = await body<{ draft: unknown; draftId?: string }>(req);
  const draft = validateDraft(input.draft);
  if (!input.draftId || !DRAFT_ID.test(input.draftId)) throw new ExtractError("Missing draft id. Reload the page and try again.");
  const ours = totals(draft);
  const hash = await draftHash(draft);
  const pp = paypal(env);
  const key = `sent:${input.draftId}`;
  const prev = env.LIMITS ? (JSON.parse((await env.LIMITS.get(key)) ?? "null") as SentRecord | null) : null;
  if (prev?.sent && prev.hash !== hash) {
    return Response.json({ error: "This invoice was already sent with the earlier details. Use \"Make another\" for a corrected invoice." }, { status: 409 });
  }
  let id = prev && prev.hash === hash ? prev.invoiceId : "";
  if (prev && !prev.sent && prev.hash !== hash) await pp.deleteDraft(prev.invoiceId).catch(() => undefined); // unsent draft with old details
  if (!id) {
    id = (await pp.createDraft(draft, { businessName: env.BUSINESS_NAME ?? "Paid Tonight Demo" }, `PT-${input.draftId}-${hash.slice(0, 6)}`)).id;
    await env.LIMITS?.put(key, JSON.stringify({ invoiceId: id, sent: false, hash }), { expirationTtl: 7 * 86400 });
  }
  if (!(prev?.sent && prev.hash === hash)) {
    const amount = invoiceAmount(await pp.get(id));
    if (amount.value !== ours.total) {
      return Response.json({ error: `PayPal computed ${amount.value} ${amount.currency}, the draft shows ${ours.total}. Nothing was sent; adjust the draft and try again.`, paypalTotal: amount.value, total: ours.total }, { status: 409 });
    }
    await pp.send(id, Boolean(draft.customerEmail));
    await env.LIMITS?.put(key, JSON.stringify({ invoiceId: id, sent: true, hash }), { expirationTtl: 7 * 86400 });
  }
  const [invoice, qr] = await Promise.all([pp.get(id).catch(() => null), pp.qr(id).catch(() => null)]);
  const info = invoiceInfo(invoice);
  return Response.json({ id, number: info.number || `PT-${input.draftId}-${hash.slice(0, 6)}`, href: info.href, amount: info.amount ?? { value: ours.total, currency: draft.currency },
    qr: qr ? `data:image/png;base64,${qr}` : null, totals: ours, emailed: Boolean(draft.customerEmail), partial: !invoice || !qr });
}

function invoiceAmount(inv: unknown): { value: string; currency: string } {
  const amount = (inv as { amount?: { value?: unknown; currency_code?: unknown } } | null)?.amount ?? {};
  return { value: typeof amount.value === "string" ? amount.value : "", currency: typeof amount.currency_code === "string" ? amount.currency_code : "" };
}

function invoiceInfo(inv: unknown): { number: string; href: string | null; amount: { value: string; currency: string } | null } {
  const raw = (inv && typeof inv === "object" ? inv : {}) as Record<string, unknown>;
  const d = (raw.detail as { invoice_number?: unknown } | undefined) ?? {};
  const amount = invoiceAmount(inv);
  return {
    number: typeof d.invoice_number === "string" ? d.invoice_number : "",
    href: payUrlOf(raw, (raw.detail as Record<string, unknown> | undefined) ?? {}),
    amount: amount.value ? amount : null,
  };
}

interface WebhookRecord extends InvoiceStatus { eventId: string; at: string }

async function readJson<T>(kv: Counter | undefined, key: string): Promise<T | null> {
  if (!kv) return null;
  try { return JSON.parse((await kv.get(key)) ?? "null") as T | null; } catch { return null; }
}

async function storedStatus(env: Env, id: string): Promise<WebhookRecord | null> {
  return readJson<WebhookRecord>(env.LIMITS, `${WEBHOOK_INVOICE_PREFIX}${id}`);
}

async function paidToday(env: Env): Promise<WebhookRecord[]> {
  const list = await readJson<WebhookRecord[]>(env.LIMITS, `${PAID_TODAY_PREFIX}${today()}`);
  return Array.isArray(list) ? list.filter((r) => r && PAID_STATUSES.has(r.status)) : [];
}

async function addPaidToday(env: Env, record: WebhookRecord): Promise<void> {
  if (!env.LIMITS) return;
  const key = `${PAID_TODAY_PREFIX}${today()}`;
  const list = (await readJson<WebhookRecord[]>(env.LIMITS, key)) ?? [];
  const next = list.filter((r) => r && r.id !== record.id);
  next.push(record);
  await env.LIMITS.put(key, JSON.stringify(next), { expirationTtl: WEBHOOK_TTL });
}

function webhookHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"]) {
    out[name] = request.headers.get(name) ?? "";
  }
  return out;
}

function headerValue(request: Request, ...names: string[]): string {
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) return value;
  }
  return "";
}

/**
 * The invoice of an INVOICING.INVOICE.* event. PayPal nests it under resource.invoice on some deliveries and
 * puts it at resource directly on others, so both shapes are read.
 */
function eventStatus(event: { event_type?: unknown; resource?: unknown }): InvoiceStatus {
  const resource = event.resource;
  const inner = resource && typeof resource === "object" && !Array.isArray(resource)
    ? (resource as { invoice?: unknown }).invoice
    : null;
  const source = inner && typeof inner === "object" && !Array.isArray(inner) ? inner : resource;
  const mapped = mapStatus(source);
  if (mapped.status) return mapped;
  const type = typeof event.event_type === "string" ? event.event_type : "";
  const fallback = type.endsWith(".CANCELLED") ? "CANCELLED" : type.endsWith(".REFUNDED") ? "REFUNDED" : "PAID";
  return { ...mapped, status: fallback, paid: PAID_STATUSES.has(fallback) };
}

/** One safe line per webhook: the event type, the event id and a reason code, and never a header, body or secret. */
function webhookLog(type: string, eventId: string, reason: string): void {
  const safe = (value: string) => value.replace(/[^\x20-\x7E]/g, "").slice(0, 120);
  console.log(`paypal webhook ${safe(type)} ${safe(eventId)} ${reason}`);
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > 200_000) {
    webhookLog("", "", "ignored");
    return Response.json({ error: "The event is too large." }, { status: 400 });
  }
  let event: { id?: unknown; event_type?: unknown; resource?: unknown };
  try { event = JSON.parse(text) as typeof event; } catch {
    webhookLog("", "", "ignored");
    return Response.json({ error: "Send the webhook event as JSON." }, { status: 400 });
  }
  const type = typeof event.event_type === "string" ? event.event_type : "";
  const eventId = typeof event.id === "string" ? event.id : "";
  if (!env.PAYPAL_WEBHOOK_ID) {
    webhookLog(type, eventId, "verify_error");
    return Response.json({ error: "Webhook verification is not configured." }, { status: 503 });
  }
  let verified: boolean;
  try {
    verified = await paypal(env).verifyWebhook(event, webhookHeaders(req), env.PAYPAL_WEBHOOK_ID);
  } catch (err) {
    // PayPal answered a bad request: the webhook itself is wrong, so refuse it instead of asking for a retry.
    if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
      webhookLog(type, eventId, "verify_failure");
      return Response.json({ error: "Webhook signature did not verify." }, { status: 400 });
    }
    // Verification itself failed (network, timeout, PayPal error): ask PayPal to send the event again later.
    webhookLog(type, eventId, "verify_error");
    return Response.json({ error: "The webhook could not be verified right now. PayPal will retry this event." }, { status: 503 });
  }
  if (!verified) {
    webhookLog(type, eventId, "verify_failure");
    return Response.json({ error: "Webhook signature did not verify." }, { status: 400 });
  }
  if (!eventId) {
    webhookLog(type, eventId, "ignored");
    return Response.json({ error: "The event has no id." }, { status: 400 });
  }
  const eventKey = `${WEBHOOK_EVENT_PREFIX}${eventId}`;
  if (await env.LIMITS?.get(eventKey)) {
    webhookLog(type, eventId, "duplicate");
    return Response.json({ ok: true, duplicate: true });
  }
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(type)) {
    await env.LIMITS?.put(eventKey, "1", { expirationTtl: WEBHOOK_TTL });
    webhookLog(type, eventId, "ignored");
    return Response.json({ ok: true, ignored: true });
  }
  const status = eventStatus(event);
  if (!status.id) {
    webhookLog(type, eventId, "no_invoice_id");
    return Response.json({ error: "The event has no invoice id." }, { status: 400 });
  }
  const record: WebhookRecord = { ...status, eventId, at: new Date().toISOString() };
  await env.LIMITS?.put(`${WEBHOOK_INVOICE_PREFIX}${status.id}`, JSON.stringify(record), { expirationTtl: WEBHOOK_TTL });
  await addPaidToday(env, record);
  await env.LIMITS?.put(eventKey, "1", { expirationTtl: WEBHOOK_TTL });
  webhookLog(type, eventId, "stored");
  return Response.json({ ok: true, duplicate: false, status: record.status });
}

async function invoiceStatus(env: Env, id: string): Promise<Response> {
  const hint = await storedStatus(env, id);
  try {
    const live = await paypal(env).getStatus(id);
    return Response.json({ ...live, invoice: live, source: "paypal" });
  } catch (err) {
    if (hint) return Response.json({ ...hint, invoice: hint, source: "webhook" });
    throw err;
  }
}

async function recordPayment(req: Request, env: Env, id: string): Promise<Response> {
  await body<Record<string, unknown>>(req);
  try {
    const status = await paypal(env).recordPayment(id, today());
    return Response.json({ ...status, invoice: status, source: "paypal" });
  } catch (err) {
    if (err instanceof PaymentPendingError) return Response.json({ pending: true, message: err.message }, { status: 202 });
    throw err;
  }
}

async function registerWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_CODE) return Response.json({ error: "Webhook setup is disabled because ADMIN_CODE is not set." }, { status: 503 });
  if (!sameCode(headerValue(req, "x-admin-code", "admin-code", "admin_code"), env.ADMIN_CODE)) {
    return Response.json({ error: "This action needs the admin code." }, { status: 401 });
  }
  const url = `${new URL(req.url).origin}/api/paypal/webhook`;
  const { id } = await paypal(env).registerWebhook(url);
  if (!id) return Response.json({ error: "PayPal did not return a webhook id." }, { status: 502 });
  return Response.json({ webhookId: id, url, events: WEBHOOK_EVENTS });
}

const routes: Record<string, Handler> = {
  "POST /api/draft": async (req, env) => {
    await perAddress(req, env);
    const { text } = await body<{ text?: string }>(req);
    if (typeof text !== "string" || text.trim().length < 10) throw new ExtractError("Describe the job in a sentence or two.");
    const draft = await extractDraft(text.slice(0, 2000), aiRunner(env), today());
    const warning = discountWarning(draft);
    if (warning && !draft.warnings.includes(warning)) draft.warnings.push(warning);
    return Response.json({ draft, totals: totals(draft) });
  },
  "POST /api/totals": async (req) => {
    const { draft } = await body<{ draft: unknown }>(req);
    return Response.json({ totals: totals(validateDraft(draft)) });
  },
  "POST /api/send": async (req, env) => send(req, env),
  "GET /api/unpaid": async (_req, env) => {
    const invoices = [];
    for (const invoice of await paypal(env).listUnpaid()) {
      const hint = await storedStatus(env, invoice.id);
      if (hint && NOT_OPEN.has(hint.status)) continue;
      invoices.push(invoice);
    }
    return Response.json({ invoices, paidToday: await paidToday(env) });
  },
  "POST /api/reminder": async (req, env) => {
    await perAddress(req, env);
    const { id } = await body<{ id?: string }>(req);
    const inv = (await paypal(env).listUnpaid()).find((i) => i.id === id);
    if (!inv) throw new ExtractError("That invoice is not unpaid any more.");
    return Response.json({ reminder: await draftReminder(inv, aiRunner(env), today()) });
  },
  "POST /api/remind": async (req, env) => {
    const { id } = await body<{ id?: string }>(req);
    const pp = paypal(env);
    if (!id || !(await pp.listUnpaid()).some((i) => i.id === id)) throw new ExtractError("That invoice is not unpaid any more.");
    await pp.remind(id);
    return Response.json({ ok: true });
  },
  "POST /api/paypal/webhook": async (req, env) => handleWebhook(req, env),
  "POST /api/admin/register-webhook": async (req, env) => registerWebhook(req, env),
};

/** Match the fixed routes plus the two per-invoice routes, and keep one guard key for each. */
function matchRoute(method: string, pathname: string): { key: string; handler: Handler } | null {
  const fixed = routes[`${method} ${pathname}`];
  if (fixed) return { key: `${method} ${pathname}`, handler: fixed };
  const m = /^\/api\/invoice\/([^/]+)\/(status|record-payment)$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return null; }
  if (m[2] === "status" && method === "GET") return { key: `${method} /api/invoice/{id}/status`, handler: (_req, env) => invoiceStatus(env, id) };
  if (m[2] === "record-payment" && method === "POST") return { key: `${method} /api/invoice/{id}/record-payment`, handler: (req, env) => recordPayment(req, env, id) };
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = matchRoute(request.method, pathname);
    if (route && env.DEMO_SEND_CODE && GUARDED.has(route.key) && !sameCode(request.headers.get("x-demo-code") ?? "", env.DEMO_SEND_CODE)) {
      return Response.json({ error: "This action needs the access code.", needCode: true }, { status: 401 });
    }
    if (!route) return pathname.startsWith("/api/") ? Response.json({ error: "Not found." }, { status: 404 }) : env.ASSETS.fetch(request);
    try { return await route.handler(request, env); } catch (err) { return fail(err); }
  },
};
