export interface BrowserTotals {
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
}

export interface BrowserInvoice {
  dueDate?: string | null;
  invoiceDate?: string | null;
  customerEmail?: string | null;
  payUrl?: string | null;
}

export function computeTotals(draft: {
  items: Array<{ quantity: string; unitAmount: string }>;
  taxPercent?: string | null;
  discount?: string | null;
  discountPercent?: string | null;
}): BrowserTotals;

export function reminderMailto(invoice: BrowserInvoice, subject: string, note: string): string;
export function overdueLabel(invoice: BrowserInvoice, today?: string): { text: string; className: string };
export function daysOverdue(invoice: BrowserInvoice, today?: string): number | null;
export function calendarDaysPastDue(invoice: BrowserInvoice, today?: string): number | null;

export function normalizeUnpaid(raw: unknown): {
  id: string;
  number: string;
  status: string;
  customerName: string;
  customerEmail: string | null;
  total: string;
  dueAmount: string | null;
  currency: string;
  dueDate: string | null;
  invoiceDate: string | null;
  payUrl: string | null;
} | null;
