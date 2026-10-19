import type { InvoiceDraft } from "../src/types";

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

export function computeWarnings(draft: {
  items: Array<{ name?: string; quantity?: string; unitAmount?: string }>;
  customerEmail?: string | null;
  customerName?: string;
  taxPercent?: string | null;
  discount?: string | null;
  discountPercent?: string | null;
}): string[];

export function discountChoice(draft: InvoiceDraft): { draft: InvoiceDraft; amount: string; locked: boolean };

export function localDay(date: Date | string | number): string | null;

export function paidTodayFor<T extends { at?: string | null }>(records: T[], now?: Date | string | number): T[];

export function resolveSpeechLang(browserLang?: string | null, saved?: string | null): string;
export function loadSavedSpeechLang(): string | null;
export function saveSpeechLang(lang: string): void;

export const POLL_INTERVAL_MS: number;
export const POLL_MAX_MS: number;
export const POLL_ENDED_MESSAGE: string;

export function shouldStopPolling(status: unknown): boolean;
export function statusHeadline(status: unknown): string;

export function createInvoicePoller(options: {
  fetchStatus: () => Promise<unknown>;
  onStatus: (status: unknown) => void;
  onError?: (err: unknown) => void;
  onEnd?: () => void;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}): { stop: () => void; tick: () => Promise<void> };

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

export function normalizeStatus(raw: unknown): {
  id: string;
  number: string;
  status: string;
  customerName: string;
  total: string;
  paidAmount: string;
  dueAmount: string | null;
  currency: string;
  paid: boolean;
  at: string | null;
} | null;

export function invoiceStatusRequest(id: string, fetchFn?: typeof fetch): Promise<ReturnType<typeof normalizeStatus>>;
export function recordPaymentRequest(id: string, fetchFn?: typeof fetch): Promise<{
  pending: boolean;
  message: string;
  status: ReturnType<typeof normalizeStatus>;
}>;
