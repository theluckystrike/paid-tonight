import { PayPalError } from "./types";
import type { InvoiceDraft, UnpaidInvoice } from "./types";
import { toPayPalItems } from "./money";

const DEFAULT_BASE = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 8000;
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEADER_LINE = /^[A-Za-z0-9-]+:/;

export class PayPal {
  private readonly clientId: string;
  private readonly secret: string;
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private tokenValue: string | null = null;
  private tokenExpiresAt = 0;

  constructor(clientId: string, secret: string, fetchFn?: typeof fetch, base?: string) {
    this.clientId = clientId;
    this.secret = secret;
    // Looked up per call, so a long-lived client always uses the current global fetch.
    this.fetchFn = fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.base = (base ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async token(): Promise<string> {
    if (this.tokenValue && Date.now() < this.tokenExpiresAt - 60_000) return this.tokenValue;
    const auth = btoa(`${this.clientId}:${this.secret}`);
    const res = await this.rawRequest("POST", "/v1/oauth2/token", {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = await res.json();
    this.tokenValue = String(data.access_token);
    this.tokenExpiresAt = Date.now() + Number(data.expires_in) * 1000;
    return this.tokenValue;
  }

  async createDraft(draft: InvoiceDraft, invoicer: { businessName: string }, invoiceNumber?: string): Promise<{ id: string; href: string }> {
    const detail: Record<string, unknown> = {
      currency_code: draft.currency,
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    };
    // A fixed invoice number per draft: PayPal refuses a second invoice with the same number, so a retry cannot duplicate.
    if (invoiceNumber) detail.invoice_number = invoiceNumber;
    if (draft.note != null) detail.note = draft.note;
    // The sandbox keeps given_name and surname but drops a lone full_name, so send both forms.
    const parts = draft.customerName.trim().split(/\s+/);
    const name: Record<string, string> = { full_name: draft.customerName, given_name: parts[0] ?? "" };
    if (parts.length > 1) name.surname = parts.slice(1).join(" ");
    const billing: Record<string, unknown> = { name };
    if (draft.customerEmail != null) billing.email_address = draft.customerEmail;
    const payload: Record<string, unknown> = {
      detail,
      invoicer: { business_name: invoicer.businessName },
      primary_recipients: [{ billing_info: billing }],
      items: toPayPalItems(draft),
    };
    if (draft.discount && draft.discount !== "0.00") {
      payload.amount = { breakdown: { discount: { invoice_discount: { amount: { currency_code: draft.currency, value: draft.discount } } } } };
    }
    const res = await this.request("POST", "/v2/invoicing/invoices", {
      body: JSON.stringify(payload),
      contentType: "application/json",
      requestId: invoiceNumber,
    });
    return idAndHref(await res.json());
  }

  async send(id: string, sendToRecipient = true): Promise<void> {
    const body = sendToRecipient
      ? { send_to_invoicer: false, send_to_recipient: true }
      : { send_to_recipient: false };
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
      body: JSON.stringify(body),
      contentType: "application/json",
    });
  }

  async qr(id: string): Promise<string> {
    const res = await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/generate-qr-code`, {
      body: JSON.stringify({ width: 400, height: 400 }),
      contentType: "application/json",
    });
    return extractQrBase64(await res.text());
  }

  /** Delete an invoice that is still a draft (never sent). */
  async deleteDraft(id: string): Promise<void> {
    await this.request("DELETE", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  async get(id: string): Promise<unknown> {
    const res = await this.request("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    return res.json();
  }

  async listUnpaid(): Promise<UnpaidInvoice[]> {
    const res = await this.request("GET", "/v2/invoicing/invoices?page=1&page_size=50&total_required=true");
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const keep = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
    const out: UnpaidInvoice[] = [];
    for (const raw of items) {
      const mapped = mapInvoice(raw);
      if (mapped && keep.has(mapped.status)) out.push(mapped);
    }
    return out;
  }

  /** PayPal sends its own reminder text (it ignores custom subject and note on /remind); the AI message is shared separately. */
  async remind(id: string): Promise<void> {
    await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
      body: JSON.stringify({ send_to_invoicer: false }),
      contentType: "application/json",
    });
  }

  private async request(method: string, path: string, opts: { body?: string; contentType?: string; requestId?: string } = {}): Promise<Response> {
    const build = async () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
      return headers;
    };
    try {
      return await this.rawRequest(method, path, { headers: await build(), body: opts.body });
    } catch (err) {
      // An expired or revoked token: drop it and retry once with a fresh one.
      if (!(err instanceof PayPalError) || err.status !== 401) throw err;
      this.tokenValue = null;
      return this.rawRequest(method, path, { headers: await build(), body: opts.body });
    }
  }

  private async rawRequest(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PayPalError(0, err instanceof Error ? err.message : "PayPal request failed");
    }
    if (!res.ok) throw await this.toPayPalError(res);
    return res;
  }

  private async toPayPalError(res: Response): Promise<PayPalError> {
    const body = await res.json().catch(() => null);
    let debugId: string | undefined;
    let message = "";
    if (body && typeof body === "object") {
      const b = body as { debug_id?: unknown; message?: unknown; name?: unknown; details?: unknown };
      if (typeof b.debug_id === "string") debugId = b.debug_id;
      // Every detail, with a readable field name: "Customer email: Invalid email address; Item 2 price: ..."
      const details = Array.isArray(b.details) ? b.details : [];
      message = details
        .map((d) => (d && typeof d === "object" ? d as { field?: unknown; description?: unknown } : {}))
        .filter((d) => typeof d.description === "string")
        .map((d) => (typeof d.field === "string" && d.field ? `${fieldLabel(d.field)}: ` : "") + String(d.description))
        .join("; ");
      if (!message && typeof b.message === "string") message = b.message;
      if (!message && typeof b.name === "string") message = b.name;
    }
    if (!message) message = `PayPal request failed (${res.status})`;
    return new PayPalError(res.status, message, debugId);
  }
}

function idAndHref(data: unknown): { id: string; href: string } {
  const d = (data && typeof data === "object" ? data : {}) as { id?: unknown; href?: unknown };
  const href = typeof d.href === "string" ? d.href : "";
  let id = typeof d.id === "string" ? d.id : "";
  if (!id && href) {
    const parts = href.split("/").filter((s) => s.length > 0);
    id = parts[parts.length - 1] ?? "";
  }
  return { id, href };
}

function extractQrBase64(body: string): string {
  const chunks: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("--") || HEADER_LINE.test(line)) continue;
    if (BASE64_LINE.test(line)) chunks.push(line);
  }
  const base64 = chunks.join("");
  if (base64.length === 0) throw new Error("no base64 PNG payload in QR response");
  return base64;
}

export function mapInvoice(raw: unknown): UnpaidInvoice | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;
  const detail = isObject(raw.detail) ? raw.detail : {};
  const amount = isObject(raw.amount) ? raw.amount : {};
  const recipients = Array.isArray(raw.primary_recipients) ? raw.primary_recipients : [];
  const first = recipients[0];
  let customerName = "";
  let customerEmail: string | null = null;
  if (isObject(first)) {
    const billing = isObject(first.billing_info) ? first.billing_info : {};
    const name = isObject(billing.name) ? billing.name : {};
    // PayPal stores the full_name we send as given_name and surname, so read either form.
    if (typeof name.full_name === "string" && name.full_name.trim()) customerName = name.full_name.trim();
    else customerName = [name.given_name, name.surname].filter((v) => typeof v === "string" && v.trim()).join(" ");
    if (!customerName && typeof billing.business_name === "string") customerName = billing.business_name;
    if (typeof billing.email_address === "string" && billing.email_address !== "") customerEmail = billing.email_address;
  }
  return {
    id,
    number: typeof detail.invoice_number === "string" ? detail.invoice_number : "",
    status: typeof raw.status === "string" ? raw.status : "",
    customerName,
    customerEmail,
    total: typeof amount.value === "string" ? amount.value : "0.00",
    currency: typeof amount.currency_code === "string" ? amount.currency_code : "",
    dueDate: dueDateOf(detail),
    invoiceDate: typeof detail.invoice_date === "string" ? detail.invoice_date : null,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** PayPal keeps the due date in detail.payment_term.due_date; due-on-receipt invoices fall back to the invoice date. */
function dueDateOf(detail: Record<string, unknown>): string | null {
  const term = isObject(detail.payment_term) ? detail.payment_term : {};
  if (typeof term.due_date === "string") return term.due_date;
  if (typeof detail.due_date === "string") return detail.due_date;
  return typeof detail.invoice_date === "string" ? detail.invoice_date : null;
}

function fieldLabel(pointer: string): string {
  const p = pointer.replace(/^\//, "");
  if (/billing_info\/email_address/.test(p)) return "Customer email";
  if (/billing_info\/name/.test(p)) return "Customer name";
  const item = /^items\/(\d+)\/(\w+)/.exec(p);
  if (item) return `Item ${Number(item[1]) + 1} ${item[2] === "unit_amount" ? "price" : item[2]}`;
  if (/invoice_number/.test(p)) return "Invoice number";
  return p.replace(/\//g, " ").replace(/_/g, " ");
}
