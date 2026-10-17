# Paid Tonight: specification (PayPal AI Hackathon)

A tradesperson (plumber, electrician, cleaner, tutor) finishes a job and says or types what they did:
"Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT."
Paid Tonight's agent turns this into a PayPal invoice draft (line items, tax, customer), shows it for one-tap approval,
sends it through PayPal, and shows a QR code the customer can scan to pay on the spot. A second agent watches unpaid
invoices and drafts a polite, specific reminder for each, which the user approves before PayPal sends it.

Runtime: Cloudflare Workers (TypeScript, ESM). PayPal REST sandbox: https://api-m.sandbox.paypal.com. AI: Workers AI
binding `AI` (model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON output). No other paid service. Node 24 toolchain.
Tests: `PATH=$HOME/paybox-hackathon-2026-10-17/.node/node-v24.21.0-darwin-arm64/bin:$PATH npx tsx --test test/<file>.test.ts`;
type check `npx tsc --noEmit`. Tests never hit the network: inject fake fetch / fake AI.

## Shared contract (src/types.ts, orchestrator owns it, do not edit)

```ts
export interface LineItem { name: string; quantity: string; unitAmount: string; unit?: "HOURS" | "AMOUNT" | "QUANTITY" } // decimal strings, 2 dp for money, up to 3 dp quantity
export interface InvoiceDraft {
  customerName: string; customerEmail: string | null; currency: string; // ISO 4217, default "USD"
  items: LineItem[]; taxPercent: string | null;                         // "23" or null
  note: string | null;                                                  // short job note shown on the invoice
  warnings: string[];                                                   // things the user must check (e.g. "No customer email")
}
export interface Totals { subtotal: string; tax: string; total: string } // exact, computed in code, never by the AI
export class PayPalError extends Error { constructor(public status: number, message: string, public debugId?: string) { super(message); } }
export class ExtractError extends Error {}
```

## Modules and owners

| File | Owner | Exports |
|---|---|---|
| src/paypal.ts + test/paypal.test.ts | W1 | `class PayPal { constructor(clientId, secret, fetchFn?, base?) ; token(); createDraft(draft: InvoiceDraft, invoicer: {businessName: string}): Promise<{id, href}>; send(id); qr(id): Promise<string /* base64 PNG */>; get(id); listUnpaid(): Promise<Array<{id, number, status, customerName, customerEmail, total, currency, dueDate, invoiceDate}>>; remind(id, subject, note) }` |
| src/money.ts + test/money.test.ts | W1 | `totals(draft): Totals` (exact decimal math with bigint cents, tax rounded half-up per invoice), `toPayPalItems(draft)` |
| src/extract.ts + test/extract.test.ts | W2 | `extractDraft(text: string, ai: AiRunner, today: string): Promise<InvoiceDraft>`; `type AiRunner = (messages: {role: string; content: string}[]) => Promise<string>` |
| src/reminder.ts + test/reminder.test.ts | W2 | `draftReminder(inv: UnpaidInvoice, ai: AiRunner, today: string): Promise<{subject: string; note: string; tone: "friendly"|"firm"}>` |
| web/index.html, web/app.js, web/styles.css | W3 | the app UI |
| src/types.ts, src/worker.ts, src/limit.ts | orchestrator | routing, secrets, daily AI cap |

### PayPal (W1): exact REST calls

- Token: POST `/v1/oauth2/token`, Basic auth base64(clientId:secret), body `grant_type=client_credentials`, form encoded. Cache the token in memory until 60 s before `expires_in`.
- Create draft: POST `/v2/invoicing/invoices` JSON:
  `{detail:{currency_code, note, payment_term:{term_type:"DUE_ON_RECEIPT"}}, invoicer:{business_name}, primary_recipients:[{billing_info:{name:{full_name}, email_address}}], items:[{name, quantity, unit_amount:{currency_code, value}, unit_of_measure, tax:{name:"Tax", percent}}]}`.
  Omit `email_address` when null. Response 201 `{href}` or `{id,...}`: return the id (last path segment of href when only href).
- Send: POST `/v2/invoicing/invoices/{id}/send` JSON `{send_to_invoicer:false, send_to_recipient: true}` (when no email: `{send_to_recipient:false}` and the user shares the QR). Accept 200, 202 or 204.
- QR: POST `/v2/invoicing/invoices/{id}/generate-qr-code` JSON `{width:400,height:400}`; response is a multipart or plain base64 body: extract the base64 PNG payload (strip any MIME headers/boundaries), return clean base64.
- List unpaid: GET `/v2/invoicing/invoices?page=1&page_size=50&total_required=true`, keep status in SENT, UNPAID, PARTIALLY_PAID, MARKED_AS... no: keep SENT, UNPAID, PARTIALLY_PAID; map to the listed shape.
- Remind: POST `/v2/invoicing/invoices/{id}/remind` JSON `{subject, note, send_to_invoicer:false}`.
- Errors: non-2xx -> throw PayPalError(status, message from `details[0].description || message || name`, debug_id). Timeouts 8 s (AbortSignal.timeout). Never log secrets.

### Extraction (W2)

The AI returns JSON only; `extractDraft` parses and VALIDATES it with zod, then normalises: money to 2 dp strings, quantity to max 3 dp,
currency default "USD" (accept EUR, GBP, PLN, USD, CAD, AUD only), tax percent 0..30, items 1..20, names max 120 chars.
Prompt: system message explains the JSON shape with 2 worked examples (hours x rate, materials, VAT). The AI must not compute totals.
If the AI output is invalid JSON or fails validation: one retry with the validation error appended; then throw ExtractError with a plain message.
Warnings (computed in code, not by the AI): missing customer email, missing customer name ("Customer"), an item priced 0, total above 10000,
tax missing when the text says VAT/tax. Tests: 15+ with a fake AiRunner (valid JSON, JSON in a code fence, bad JSON then good, bad twice, wrong types, negative price, huge quantity).
Reminder: tone "friendly" when 1-14 days overdue or not due, "firm" when more than 14 days overdue; the subject names the invoice number;
the note is 2-4 sentences, names the job and amount, offers the pay link, no threats, no emojis, max 400 characters. Validate and cap in code.

### UI (W3)

Mobile-first single page, PWA-feeling, calm and trustworthy (think a well-made banking app). Two tabs: "New invoice" and "Unpaid".
New invoice: big text area with a microphone button (webkitSpeechRecognition, en-US; text works without it), example chips (3 trades),
"Make invoice" -> POST /api/draft {text} -> editable preview card (customer, email, items with qty x unit price, tax, exact totals from the
server, warnings in amber) -> "Send with PayPal" -> POST /api/send {draft} -> success screen with invoice number, QR image (data URL) and
"Customer can scan to pay now" + link. Unpaid: GET /api/unpaid list (customer, amount, days overdue) -> "Draft reminder" -> POST /api/reminder {id}
-> editable subject and note -> "Send reminder" -> POST /api/remind {id, subject, note}. A footer: "Sandbox demo. No real money moves.
Paid Tonight by Michael Lip, github.com/theluckystrike." Errors shown inline in plain words. No frameworks, no external assets, no emojis.
Accessible labels, works at 375 px and 1280 px. Never render server text with innerHTML (use textContent).

## Hard rules

Sandbox only. No secrets in code or logs (secrets come from env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET). Exact money math in code.
Functions under 60 lines, no while(true), no empty catch. Edit only files you own. No emojis. Plain English.
