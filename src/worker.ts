import { extractDraft } from "./extract.js";
import { takeAiCall, type Counter } from "./limit.js";
import { totals } from "./money.js";
import { PayPal } from "./paypal.js";
import { draftReminder } from "./reminder.js";
import { ExtractError, PayPalError, type AiRunner, type InvoiceDraft } from "./types.js";

interface Env {
  AI: { run: (model: string, input: unknown) => Promise<{ response?: unknown }> };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  LIMITS?: Counter;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  BUSINESS_NAME?: string;
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

function paypal(env: Env): PayPal {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new PayPalError(503, "PayPal sandbox credentials are not configured on this server.");
  return new PayPal(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
}

function fail(err: unknown): Response {
  if (err instanceof ExtractError) return Response.json({ error: err.message }, { status: 422 });
  if (err instanceof PayPalError) return Response.json({ error: `PayPal: ${err.message}`, debugId: err.debugId ?? null }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 });
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > 20_000) throw new ExtractError("The request is too large.");
  try { return JSON.parse(text) as T; } catch { throw new ExtractError("Send JSON."); }
}

type Handler = (request: Request, env: Env) => Promise<Response>;

const routes: Record<string, Handler> = {
  "POST /api/draft": async (req, env) => {
    const { text } = await body<{ text?: string }>(req);
    if (typeof text !== "string" || text.trim().length < 10) throw new ExtractError("Describe the job in a sentence or two.");
    const draft = await extractDraft(text.slice(0, 2000), aiRunner(env), today());
    return Response.json({ draft, totals: totals(draft) });
  },
  "POST /api/totals": async (req) => {
    const { draft } = await body<{ draft: InvoiceDraft }>(req);
    return Response.json({ totals: totals(draft) });
  },
  "POST /api/send": async (req, env) => {
    const { draft } = await body<{ draft: InvoiceDraft }>(req);
    const pp = paypal(env);
    const created = await pp.createDraft(draft, { businessName: env.BUSINESS_NAME ?? "Paid Tonight Demo" });
    await pp.send(created.id);
    const [qr, invoice] = await Promise.all([pp.qr(created.id), pp.get(created.id)]);
    return Response.json({ id: created.id, invoice, qr: `data:image/png;base64,${qr}`, totals: totals(draft) });
  },
  "GET /api/unpaid": async (_req, env) => Response.json({ invoices: await paypal(env).listUnpaid() }),
  "POST /api/reminder": async (req, env) => {
    const { id } = await body<{ id?: string }>(req);
    const inv = (await paypal(env).listUnpaid()).find((i) => i.id === id);
    if (!inv) throw new ExtractError("That invoice is not unpaid any more.");
    return Response.json({ reminder: await draftReminder(inv, aiRunner(env), today()) });
  },
  "POST /api/remind": async (req, env) => {
    const { id, subject, note } = await body<{ id?: string; subject?: string; note?: string }>(req);
    if (!id || !subject || !note) throw new ExtractError("Subject and note are required.");
    await paypal(env).remind(id, subject.slice(0, 200), note.slice(0, 400));
    return Response.json({ ok: true });
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const handler = routes[`${request.method} ${pathname}`];
    if (!handler) return pathname.startsWith("/api/") ? Response.json({ error: "Not found." }, { status: 404 }) : env.ASSETS.fetch(request);
    try { return await handler(request, env); } catch (err) { return fail(err); }
  },
};
