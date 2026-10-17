import { extractDraft } from "./extract.js";
import { takeAiCall, type Counter } from "./limit.js";
import { totals } from "./money.js";
import { PayPal } from "./paypal.js";
import { draftReminder } from "./reminder.js";
import { ExtractError, PayPalError, type AiRunner, type InvoiceDraft } from "./types.js";
import { DraftInvalid, validateDraft } from "./validate.js";

interface Env {
  AI: { run: (model: string, input: unknown) => Promise<{ response?: unknown }> };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  LIMITS?: Counter;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  BUSINESS_NAME?: string;
  AI_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Optional: when set, the PayPal routes (send, unpaid, reminder, remind) need this code in the x-demo-code header. */
  DEMO_SEND_CODE?: string;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const today = () => new Date().toISOString().slice(0, 10);

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
  if (err instanceof PayPalError) return Response.json({ error: `PayPal: ${err.message}`, debugId: err.debugId ?? null }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 });
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

const GUARDED = new Set(["POST /api/send", "GET /api/unpaid", "POST /api/reminder", "POST /api/remind"]);

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
  const d = (inv as { detail?: { invoice_number?: unknown; metadata?: { recipient_view_url?: unknown } } } | null)?.detail ?? {};
  const amount = invoiceAmount(inv);
  return {
    number: typeof d.invoice_number === "string" ? d.invoice_number : "",
    href: typeof d.metadata?.recipient_view_url === "string" ? d.metadata.recipient_view_url : null,
    amount: amount.value ? amount : null,
  };
}

const routes: Record<string, Handler> = {
  "POST /api/draft": async (req, env) => {
    await perAddress(req, env);
    const { text } = await body<{ text?: string }>(req);
    if (typeof text !== "string" || text.trim().length < 10) throw new ExtractError("Describe the job in a sentence or two.");
    const draft = await extractDraft(text.slice(0, 2000), aiRunner(env), today());
    return Response.json({ draft, totals: totals(draft) });
  },
  "POST /api/totals": async (req) => {
    const { draft } = await body<{ draft: unknown }>(req);
    return Response.json({ totals: totals(validateDraft(draft)) });
  },
  "POST /api/send": async (req, env) => send(req, env),
  "GET /api/unpaid": async (_req, env) => Response.json({ invoices: await paypal(env).listUnpaid() }),
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
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const routeKey = `${request.method} ${pathname}`;
    const handler = routes[routeKey];
    if (handler && env.DEMO_SEND_CODE && GUARDED.has(routeKey) && !sameCode(request.headers.get("x-demo-code") ?? "", env.DEMO_SEND_CODE)) {
      return Response.json({ error: "This action needs the access code.", needCode: true }, { status: 401 });
    }
    if (!handler) return pathname.startsWith("/api/") ? Response.json({ error: "Not found." }, { status: 404 }) : env.ASSETS.fetch(request);
    try { return await handler(request, env); } catch (err) { return fail(err); }
  },
};
