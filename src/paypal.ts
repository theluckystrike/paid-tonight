import { PayPalError } from "./types";
import type { InvoiceDraft, InvoiceStatus, UnpaidInvoice } from "./types";
import { invoiceDiscount, toPayPalItems } from "./money";
import { splitCustomerName } from "./names";

const DEFAULT_BASE = "https://api-m.sandbox.paypal.com";
/** Default per-call timeout: every call but a record payment uses this. */
export const TIMEOUT_MS = 8000;
/** Recording a payment is the one call that may take longer, so it gets its own timeout. */
export const PAYMENT_TIMEOUT_MS = 30000;
/** Verifying a webhook must give PayPal's answer time to arrive before we call it a failure. */
export const VERIFY_TIMEOUT_MS = 20000;
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEADER_LINE = /^[A-Za-z0-9-]+:/;
export const WEBHOOK_EVENTS = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED", "INVOICING.INVOICE.REFUNDED"] as const;
export const PAID_STATUSES = new Set(["PAID", "MARKED_AS_PAID"]);
export const PENDING_PAYMENT_MESSAGE = "PayPal is still recording the payment. Tap Refresh in a minute.";

/** A record payment call did not return and a fresh read cannot confirm the money is in yet. */
export class PaymentPendingError extends Error {
  constructor(message: string = PENDING_PAYMENT_MESSAGE) { super(message); this.name = "PaymentPendingError"; }
}

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
    const parts = splitCustomerName(draft.customerName);
    const name: Record<string, string> = { full_name: parts.fullName, given_name: parts.givenName };
    if (parts.surname) name.surname = parts.surname;
    const billing: Record<string, unknown> = { name };
    if (draft.customerEmail != null) billing.email_address = draft.customerEmail;
    const payload: Record<string, unknown> = {
      detail,
      invoicer: { business_name: invoicer.businessName },
      primary_recipients: [{ billing_info: billing }],
      items: toPayPalItems(draft),
    };
    // Only a fixed discount that will not divide exactly by each quantity is sent at invoice level, after tax.
    const invDiscount = invoiceDiscount(draft);
    if (invDiscount) payload.amount = { currency_code: draft.currency, breakdown: { discount: { invoice_discount: invDiscount } } };
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

  /** Read one invoice's status, paid amount and due amount from PayPal. */
  async getStatus(id: string): Promise<InvoiceStatus> {
    return mapStatus(await this.get(id), id);
  }

  /**
   * Record money handed over at the door as CASH for the full amount still due. PayPal owns the resulting status,
   * so the answer comes from a fresh read, never from the app.
   */
  async recordPayment(id: string, paymentDate: string): Promise<InvoiceStatus> {
    const current = await this.getStatus(id);
    if (current.paid || current.dueAmount === "0.00") throw new PayPalError(409, "PayPal reports nothing due on this invoice.");
    const amount = current.dueAmount;
    try {
      await this.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
        body: JSON.stringify({ method: "CASH", payment_date: paymentDate, amount: { currency_code: current.currency, value: amount } }),
        contentType: "application/json",
        // A fresh id per tap: PayPal treats each as its own request, while the read above stops a second one when nothing is due.
        requestId: `cash-${id}-${paymentDate}-${crypto.randomUUID()}`,
        timeoutMs: PAYMENT_TIMEOUT_MS,
      });
    } catch (err) {
      if (!(err instanceof PayPalError) || err.status !== 0) throw err;
      // The request timed out or the connection dropped: PayPal may still have recorded it, so read once before deciding.
      const after = await this.getStatus(id).catch(() => null);
      if (after && paymentCovered(after)) return after;
      throw new PaymentPendingError();
    }
    return this.getStatus(id);
  }

  /**
   * Ask PayPal whether a webhook really came from it, using every transmission header.
   * Only an explicit FAILURE answer returns false. A transport error, a timeout or an answer without a
   * verification status throws, so the caller can tell "PayPal said no" apart from "we could not ask".
   */
  async verifyWebhook(event: unknown, headers: Record<string, string>, webhookId: string): Promise<boolean> {
    const res = await this.request("POST", "/v1/notifications/verify-webhook-signature", {
      body: JSON.stringify({
        auth_algo: headers["paypal-auth-algo"] ?? "",
        cert_url: headers["paypal-cert-url"] ?? "",
        transmission_id: headers["paypal-transmission-id"] ?? "",
        transmission_sig: headers["paypal-transmission-sig"] ?? "",
        transmission_time: headers["paypal-transmission-time"] ?? "",
        webhook_id: webhookId,
        webhook_event: event,
      }),
      contentType: "application/json",
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    const data = (await res.json().catch(() => null)) as { verification_status?: unknown } | null;
    const status = data?.verification_status;
    if (status === "SUCCESS") return true;
    if (status === "FAILURE") return false;
    throw new PayPalError(0, "PayPal did not answer whether the webhook signature is valid.");
  }

  /** Register this worker's webhook URL for the three invoice events and return PayPal's webhook id. */
  async registerWebhook(url: string): Promise<{ id: string }> {
    const res = await this.request("POST", "/v1/notifications/webhooks", {
      body: JSON.stringify({
        url,
        event_types: WEBHOOK_EVENTS.map((name) => ({ name })),
      }),
      contentType: "application/json",
    });
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return { id: typeof data?.id === "string" ? data.id : "" };
  }

  async listUnpaid(): Promise<UnpaidInvoice[]> {
    const keep = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
    const out: UnpaidInvoice[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.request("GET", `/v2/invoicing/invoices?page=${page}&page_size=50&total_required=true`);
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      for (const raw of items) {
        const mapped = mapInvoice(raw);
        if (mapped && keep.has(mapped.status)) out.push(mapped);
      }
      const totalPages = Number(data.total_pages);
      if (Number.isFinite(totalPages) && totalPages > 0 ? page >= totalPages : items.length < 50) break;
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

  private async request(method: string, path: string, opts: { body?: string; contentType?: string; requestId?: string; timeoutMs?: number } = {}): Promise<Response> {
    const build = async () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
      return headers;
    };
    try {
      return await this.rawRequest(method, path, { headers: await build(), body: opts.body, timeoutMs: opts.timeoutMs });
    } catch (err) {
      // An expired or revoked token: drop it and retry once with a fresh one.
      if (!(err instanceof PayPalError) || err.status !== 401) throw err;
      this.tokenValue = null;
      return this.rawRequest(method, path, { headers: await build(), body: opts.body, timeoutMs: opts.timeoutMs });
    }
  }

  private async rawRequest(method: string, path: string, opts: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
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
  const status = typeof raw.status === "string" ? raw.status : "";
  const total = typeof amount.value === "string" ? amount.value : "0.00";
  return {
    id,
    number: typeof detail.invoice_number === "string" ? detail.invoice_number : "",
    status,
    customerName,
    customerEmail,
    total,
    dueAmount: dueAmountOf(raw, status, total),
    currency: typeof amount.currency_code === "string" ? amount.currency_code : "",
    dueDate: dueDateOf(detail),
    invoiceDate: typeof detail.invoice_date === "string" ? detail.invoice_date : null,
    payUrl: payUrlOf(raw, detail),
  };
}

/** Map a PayPal invoice (or a webhook resource) to the small status shape the app shows. */
export function mapStatus(raw: unknown, fallbackId = ""): InvoiceStatus {
  const data = isObject(raw) ? raw : {};
  const invoice = mapInvoice(raw);
  const id = invoice?.id ?? fallbackId;
  const status = invoice?.status ?? "";
  const total = invoice?.total ?? "0.00";
  const due = dueForStatus(data, status, total);
  const paid = paidForStatus(data, status, total, due);
  return {
    id,
    number: invoice?.number ?? "",
    status,
    customerName: invoice?.customerName ?? "",
    total,
    paidAmount: paid,
    dueAmount: due,
    currency: invoice?.currency ?? "",
    paid: PAID_STATUSES.has(status),
  };
}

/** PayPal says the invoice is settled: a PAID status, or a paid amount that already covers the total. */
function paymentCovered(status: InvoiceStatus): boolean {
  if (status.paid) return true;
  const paid = centsOf(status.paidAmount);
  const total = centsOf(status.total);
  return paid != null && total != null && total > 0n && paid >= total;
}

function amountValue(v: unknown): string | null {
  const amount = isObject(v) ? v : {};
  return typeof amount.value === "string" ? amount.value : null;
}

function dueForStatus(raw: Record<string, unknown>, status: string, total: string): string {
  const fromDue = amountValue(raw.due_amount);
  if (fromDue) return fromDue;
  const amount = isObject(raw.amount) ? raw.amount : {};
  const nested = amountValue(amount.due_amount);
  if (nested) return nested;
  if (PAID_STATUSES.has(status) || status === "CANCELLED" || status === "REFUNDED") return "0.00";
  return total;
}

function paidForStatus(raw: Record<string, unknown>, status: string, total: string, due: string): string {
  const explicit = amountValue(raw.paid_amount);
  if (explicit) return explicit;
  const payments = isObject(raw.payments) ? raw.payments : {};
  const fromPayments = amountValue(payments.paid_amount);
  if (fromPayments) return fromPayments;
  if (PAID_STATUSES.has(status)) return total;
  if (status === "CANCELLED" || status === "REFUNDED" || status === "DRAFT" || status === "SENT" || status === "UNPAID") return "0.00";
  const t = centsOf(total);
  const d = centsOf(due);
  if (t == null || d == null) return "0.00";
  return fromCents(t > d ? t - d : 0n);
}

function centsOf(value: string): bigint | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
}

function fromCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The balance outstanding after payments. PayPal returns it at the top level for partially paid invoices. */
function dueAmountOf(raw: Record<string, unknown>, status: string, total: string): string | null {
  const due = isObject(raw.due_amount) ? raw.due_amount : {};
  if (typeof due.value === "string") return due.value;
  return status === "PARTIALLY_PAID" ? null : total;
}

function payUrlOf(raw: Record<string, unknown>, detail: Record<string, unknown>): string | null {
  const metadata = isObject(detail.metadata) ? detail.metadata : {};
  for (const key of ["recipient_view_url", "payer_view_url"]) {
    const value = metadata[key];
    if (typeof value === "string" && value) return value;
  }
  const links = Array.isArray(raw.links) ? raw.links : [];
  for (const rel of ["payer-view", "view"]) {
    for (const link of links) {
      if (isObject(link) && link.rel === rel && typeof link.href === "string" && link.href) return link.href;
    }
  }
  for (const link of links) {
    if (isObject(link) && typeof link.href === "string" && /\/invoicing\/invoices\//.test(link.href)) return link.href;
  }
  return null;
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
