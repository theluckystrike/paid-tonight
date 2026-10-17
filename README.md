# Paid Tonight

Finish the job, say what you did, and get paid before you leave. Paid Tonight turns a plain description of a job into a PayPal invoice with line items, tax and a QR code the customer can scan on the spot. A second agent watches unpaid invoices and drafts a polite reminder for each one, which you approve before PayPal sends it. Built by Michael Lip, [github.com/theluckystrike](https://github.com/theluckystrike), for the PayPal AI Hackathon.

> "Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT."

| Item | Qty | Price |
|---|---|---|
| Kitchen tap replacement, labour | 2 h | 45.00 |
| Kitchen tap | 1 | 89.99 |
| Tax 23% | | 41.40 |
| Total | | 221.39 |

## Who it is for

Plumbers, electricians, cleaners, tutors, dog walkers and anyone else who does the work first and the paperwork later. Most of them invoice in the evening or at the weekend, and some never do. An invoice sent before they leave the customer's door is an invoice that gets paid.

## How it works

1. You type or speak the job. The browser's speech recognition fills the text box.
2. The AI reads it and returns the customer, the email, each item with quantity and unit price, the tax rate and a short note. It never does the arithmetic.
3. The server checks every field and computes the totals itself with exact integer cents, rounding tax half up once per invoice. It adds warnings you should check: no email, a zero price, a total above 10,000, or a tax that is mentioned but not given.
4. You correct anything in the preview and tap "Send with PayPal". The server creates the invoice through the PayPal Invoicing API, sends it, and shows the PayPal QR code.
5. In the Unpaid tab, the reminder agent reads your open invoices from PayPal and drafts a reminder: friendly when the invoice is due or slightly late, firm after 14 days. You edit it and approve it, and PayPal sends it.

## PayPal APIs used (sandbox)

| Call | Why |
|---|---|
| `POST /v1/oauth2/token` | Client credentials token, cached until 60 seconds before expiry |
| `POST /v2/invoicing/invoices` | Create the draft invoice with items, tax and the customer |
| `POST /v2/invoicing/invoices/{id}/send` | Send it to the customer |
| `POST /v2/invoicing/invoices/{id}/generate-qr-code` | QR code for paying on the spot |
| `GET /v2/invoicing/invoices` | List open invoices for the reminder agent |
| `POST /v2/invoicing/invoices/{id}/remind` | Send the approved reminder |

## AI tools used

| Tool | How |
|---|---|
| Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Reads the job description and returns structured JSON (customer, items, tax, note). Validated with zod; one retry with the error appended; then a plain error. |
| Same model | Drafts the reminder subject and note from the invoice data. Length and tone are checked in code. |
| Browser Web Speech API | Speech to text on the device, for the microphone button. |

The public demo has a daily cap of 60 AI calls so it stays inside the free allowance. Run it yourself to remove the cap.

## Safety and money rules

- Sandbox only. No real money moves in the demo.
- The AI never computes money. Totals come from integer cents in code.
- Nothing is sent to a customer without your tap on "Send" or "Send reminder".
- Secrets live in Worker secrets, never in the code or the browser.
- Text from the server is rendered with `textContent`, never as HTML.

## Run it

```bash
npm install
npx wrangler secret put PAYPAL_CLIENT_ID      # sandbox app from developer.paypal.com
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler dev
npx tsx --test test/*.test.ts                 # 60 tests, no network
```

## License

MIT. Not affiliated with PayPal.
