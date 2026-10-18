# Paid Tonight

<img src="docs/cover.jpg" alt="Paid Tonight" width="800">

Finish the job, say what you did, and get paid before you leave. Paid Tonight turns a plain description of a job into a PayPal invoice with line items, discount, tax and a QR code the customer can scan on the spot. The Unpaid tab reads your open invoices from PayPal. It sends PayPal's standard reminder when you tap it, and a second AI step drafts a personal message you can send by email in your own words. Built by Michael Lip, [github.com/theluckystrike](https://github.com/theluckystrike), for the PayPal AI Hackathon.

> "Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT."

| Item | Qty | Price |
|---|---|---|
| Kitchen tap replacement, labour | 2 h | 45.00 |
| Kitchen tap | 1 | 89.99 |
| Tax 23% (per line, as PayPal computes it) | | 41.40 |
| Total | | 221.39 |

<img src="docs/preview.png" alt="The invoice preview with customer, items, currency, discount, tax and totals" width="700">

The preview above is the live demo with 23 percent VAT and a discount. PayPal charges item tax on the line before an item-level discount, so the app bakes the discount into the unit prices instead and PayPal then taxes the discounted amount. A percentage discount always bakes in. A fixed discount bakes in when each line's share divides exactly by its quantity. When it cannot, PayPal takes the discount at invoice level, after tax, and the app warns that VAT is charged on the full price.

## Who it is for

Plumbers, electricians, cleaners, tutors, dog walkers and anyone else who does the work first and the paperwork later. Most of them invoice in the evening or at the weekend, and some never do. An invoice sent before they leave the customer's door is an invoice that gets paid.

## How it works

1. You type or speak the job. The browser's speech recognition fills the text box.
2. The AI reads it and returns the customer, the email, each item with quantity and unit price, a discount amount or percentage in any language, the tax rate and a short note. It never does the arithmetic. The job text is passed to the model as data inside tags, and the model is told to ignore instructions in it.
3. The server checks every field and computes the totals itself with exact integer cents, the way PayPal does, confirmed against the live sandbox. A percentage discount is baked into the unit prices and tax is computed per line on the discounted line amount, each rounded half up. A fixed discount is split across the lines in exact cents with the remainder on the largest line and baked into the unit prices the same way when each line's share divides exactly by its quantity; when it cannot, PayPal takes the discount at invoice level, after tax, and the draft carries a warning that VAT is charged on the full price. A discount the model writes as an item is turned back into a discount, and a percentage discount such as "10 percent off", "10 % Rabatt" or "descuento del 15 %" is computed from the subtotal. Tax rates may have up to 3 decimals. Customer honorifics are removed before the name is split, and a Polish name after u, dla or od gets a warning to check it. Currency words count only next to an amount, so a "euro cylinder lock" stays an item. A currency it cannot invoice (yen, forints) is refused instead of becoming dollars. An email that does not look valid, or does not appear in your description, is flagged, links are removed from the note, and amounts above 100,000 are refused. Warnings you should check also cover a zero price, a zero total after a 100 percent discount, and a tax or discount that is mentioned but not applied.
4. You correct anything in the preview (customer, items, currency, discount, tax) and tap "Send with PayPal". The server validates the edited draft again, creates the invoice with an invoice number tied to this draft and its content (a retry can never create or email a second invoice, and a corrected draft is never sent as the old one), reads back PayPal's own total and sends only if it equals the total you saw. You get the invoice number, the pay link and the PayPal QR code. Without an email, PayPal emails nobody and you share the QR code or link.
5. In the Unpaid tab, the reminder agent reads your open invoices from PayPal and drafts a message, friendly when the invoice is due or slightly late and firm after 14 days. PayPal's reminder endpoint ignores custom text, so the app says so. "Send PayPal reminder" sends PayPal's standard reminder with the pay button, and "Email this message" opens your own email with the drafted text.

## PayPal APIs used (sandbox)

| Call | Why |
|---|---|
| `POST /v1/oauth2/token` | Client credentials token, cached until 60 seconds before expiry |
| `POST /v2/invoicing/invoices` | Create the draft invoice with items, a discount baked into the unit prices (or an invoice-level discount when it cannot be baked), tax, the customer and a per-draft invoice number (`PayPal-Request-Id` set too) |
| `GET /v2/invoicing/invoices/{id}` | Read back PayPal's total before sending, and the pay link after |
| `POST /v2/invoicing/invoices/{id}/send` | Send it (to the customer only when there is an email) |
| `POST /v2/invoicing/invoices/{id}/generate-qr-code` | QR code for paying on the spot |
| `GET /v2/invoicing/invoices` | List open invoices for the reminder agent |
| `POST /v2/invoicing/invoices/{id}/remind` | PayPal's standard reminder, only for an invoice that is still unpaid |

## AI tools used

| Tool | How |
|---|---|
| Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Reads the job description and returns structured JSON (customer, items, tax, note). Validated with zod, with one retry that appends the error, then a plain error. |
| Same model | Drafts the reminder message from the invoice data (tone from the real due date). Length and tone are checked in code. |
| Browser Web Speech API | Speech to text on the device, for the microphone button. |

The public demo has a daily cap of 60 AI calls so it stays inside the free allowance, and a Cloudflare rate limiting binding is configured at 6 AI calls a minute per address. Cloudflare applies it per location and approximately, so it is a brake rather than a hard cap. Run it yourself to remove the cap.

## Safety and money rules

- Sandbox only, so no real money moves in the demo. The AI never computes money, and totals come from integer cents in code.
- A discount is baked into the unit prices so PayPal charges tax after the discount. A fixed discount that cannot divide exactly by each quantity falls back to PayPal's invoice-level discount, which is applied after tax, and the draft carries a warning.
- Nothing is sent to a customer without your tap on "Send" or "Send PayPal reminder".
- The API accepts only `application/json`, so another website cannot post forms to it through your browser.
- Secrets live in Worker secrets, never in the code or the browser. Text from the server is rendered with `textContent`, never as HTML, and pages are served with a strict Content Security Policy (no inline script) and framing denied.

## Status

The AI extraction, money rules and the whole send flow are live and connected to the PayPal sandbox. A live sandbox run created and sent an invoice for 146.90 EUR, returned the QR code and pay link, returned the same invoice on a retry, listed it as unpaid and sent a PayPal reminder. The tests use a fake PayPal that follows the Invoicing v2 API.

## Run it

```bash
npm install
npx wrangler secret put PAYPAL_CLIENT_ID      # sandbox app from developer.paypal.com
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put DEMO_SEND_CODE        # optional, an access code for send, unpaid and reminders
npx wrangler dev
npx tsx --test test/*.test.ts                 # 127 tests, no network (PayPal is a fake in the tests)
```

## License

MIT. Not affiliated with PayPal.
