# Paid Tonight

<img src="docs/cover.jpg" alt="Paid Tonight" width="800">

Finish the job, say what you did, and get paid before you leave. Paid Tonight turns a plain description of a job into a PayPal invoice with line items, discount, tax and a QR code the customer can scan on the spot. A second agent watches unpaid invoices: it sends PayPal's standard reminder when you tap it, and drafts a personal message you can send by email in your own words. Built by Michael Lip, [github.com/theluckystrike](https://github.com/theluckystrike), for the PayPal AI Hackathon.

> "Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT."

| Item | Qty | Price |
|---|---|---|
| Kitchen tap replacement, labour | 2 h | 45.00 |
| Kitchen tap | 1 | 89.99 |
| Tax 23% (per line, as PayPal computes it) | | 41.40 |
| Total | | 221.39 |

<img src="docs/preview.png" alt="The invoice preview: customer, items, currency, discount, tax and totals" width="700">

The preview above is the live demo with 23 percent VAT and a discount; totals follow PayPal's rule of tax on the full lines and the discount after tax.

## Who it is for

Plumbers, electricians, cleaners, tutors, dog walkers and anyone else who does the work first and the paperwork later. Most of them invoice in the evening or at the weekend, and some never do. An invoice sent before they leave the customer's door is an invoice that gets paid.

## How it works

1. You type or speak the job. The browser's speech recognition fills the text box.
2. The AI reads it and returns the customer, the email, each item with quantity and unit price, a discount, the tax rate and a short note. It never does the arithmetic. The job text is passed to the model as data inside tags, and the model is told to ignore instructions in it.
3. The server checks every field and computes the totals itself with exact integer cents, the way PayPal does, confirmed against the live sandbox: tax per line on the full line amount, each rounded half up, with an invoice discount subtracted after tax. A discount the model writes as an item is turned back into a discount, and "10 percent off" is computed from the subtotal. Currency words count only next to an amount, so a "euro cylinder lock" stays an item. A currency it cannot invoice (yen, forints) is refused instead of becoming dollars. An email that does not look valid, or does not appear in your description, is flagged; links are removed from the note; amounts above 100,000 are refused. Warnings you should check also cover a zero price and a tax or discount that is mentioned but not applied.
4. You correct anything in the preview (customer, items, currency, discount, tax) and tap "Send with PayPal". The server validates the edited draft again, creates the invoice with an invoice number tied to this draft and its content (a retry can never create or email a second invoice, and a corrected draft is never sent as the old one), reads back PayPal's own total and sends only if it equals the total you saw. You get the invoice number, the pay link and the PayPal QR code. Without an email, PayPal emails nobody and you share the QR code or link.
5. In the Unpaid tab, the reminder agent reads your open invoices from PayPal and drafts a message: friendly when the invoice is due or slightly late, firm after 14 days. PayPal's reminder endpoint ignores custom text, so the app says so: "Send PayPal reminder" sends PayPal's standard reminder with the pay button, and "Email this message" opens your own email with the drafted text.

## PayPal APIs used (sandbox)

| Call | Why |
|---|---|
| `POST /v1/oauth2/token` | Client credentials token, cached until 60 seconds before expiry |
| `POST /v2/invoicing/invoices` | Create the draft invoice with items, tax, invoice discount, the customer and a per-draft invoice number (`PayPal-Request-Id` set too) |
| `GET /v2/invoicing/invoices/{id}` | Read back PayPal's total before sending, and the pay link after |
| `POST /v2/invoicing/invoices/{id}/send` | Send it (to the customer only when there is an email) |
| `POST /v2/invoicing/invoices/{id}/generate-qr-code` | QR code for paying on the spot |
| `GET /v2/invoicing/invoices` | List open invoices for the reminder agent |
| `POST /v2/invoicing/invoices/{id}/remind` | PayPal's standard reminder, only for an invoice that is still unpaid |

## AI tools used

| Tool | How |
|---|---|
| Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Reads the job description and returns structured JSON (customer, items, tax, note). Validated with zod; one retry with the error appended; then a plain error. |
| Same model | Drafts the reminder message from the invoice data (tone from the real due date). Length and tone are checked in code. |
| Browser Web Speech API | Speech to text on the device, for the microphone button. |

The public demo has a daily cap of 60 AI calls so it stays inside the free allowance, and a Cloudflare rate limiting binding is configured at 6 AI calls a minute per address. Cloudflare applies it per location and approximately, so it is a brake rather than a hard cap. Run it yourself to remove the cap.

## Safety and money rules

- Sandbox only. No real money moves in the demo.
- The AI never computes money. Totals come from integer cents in code.
- Nothing is sent to a customer without your tap on "Send" or "Send PayPal reminder".
- The API accepts only `application/json`, so another website cannot post forms to it through your browser.
- Secrets live in Worker secrets, never in the code or the browser. Text from the server is rendered with `textContent`, never as HTML, and pages are served with a strict Content Security Policy (no inline script) and framing denied.

## Status

The AI extraction, money rules and the whole send flow are live and tested against a fake PayPal that follows the Invoicing v2 API. The live sandbox run (create, send, QR, remind) is the next step and needs a PayPal developer account sign-in.

## Run it

```bash
npm install
npx wrangler secret put PAYPAL_CLIENT_ID      # sandbox app from developer.paypal.com
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put DEMO_SEND_CODE        # optional: an access code for send, unpaid and reminders
npx wrangler dev
npx tsx --test test/*.test.ts                 # 79 tests, no network (PayPal is a fake in the tests)
```

## License

MIT. Not affiliated with PayPal.
