// Shared contract for Paid Tonight. Owned by the orchestrator; workers import, never edit.
export interface LineItem { name: string; quantity: string; unitAmount: string; unit?: "HOURS" | "AMOUNT" | "QUANTITY" }

export interface InvoiceDraft {
  customerName: string;
  customerEmail: string | null;
  currency: string;
  items: LineItem[];
  taxPercent: string | null;
  /** Invoice discount, a positive amount spread across the lines before tax. */
  discount?: string | null;
  /** Discount as a percentage of the subtotal, 0 to 100 with up to 2 decimals. */
  discountPercent?: string | null;
  note: string | null;
  warnings: string[];
}

export interface Totals { subtotal: string; discount: string; tax: string; total: string }

export interface UnpaidInvoice {
  id: string; number: string; status: string; customerName: string; customerEmail: string | null;
  total: string; dueAmount: string | null; currency: string; dueDate: string | null; invoiceDate: string | null;
  payUrl: string | null;
}

export class PayPalError extends Error {
  constructor(public status: number, message: string, public debugId?: string) { super(message); this.name = "PayPalError"; }
}

export class ExtractError extends Error {
  constructor(message: string) { super(message); this.name = "ExtractError"; }
}

export type AiRunner = (messages: { role: string; content: string }[]) => Promise<string>;
