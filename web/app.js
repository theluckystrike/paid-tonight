const CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "\u20ac",
  GBP: "\u00a3",
  PLN: "z\u0142",
  CAD: "CA$",
  AUD: "A$",
};

const EXAMPLES = {
  plumber: "Replaced the kitchen tap for Anna Kowalski, anna@example.com, 2 hours labour at 45 an hour, tap was 89.99, plus 23 percent VAT.",
  electrician: "Fixed a tripping breaker for Ben Carter, 1.5 hours at 60 an hour, parts 24.50, no VAT.",
  cleaner: "Deep cleaned a three-bedroom flat for Priya Shah, priya@example.com, 4 hours at 35 an hour, plus 20 percent VAT.",
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function parseDecimal(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return { coeff: 0n, scale: 0 };
  const parts = text.split(".");
  const whole = parts[0] || "0";
  const frac = parts[1] || "";
  return { coeff: BigInt(whole + frac), scale: frac.length };
}

function roundHalfUp(num, den) {
  return (num * 2n + den) / (den * 2n);
}

function lineTotalCents(item) {
  const q = parseDecimal(item.quantity);
  const u = parseDecimal(item.unitAmount);
  const num = q.coeff * u.coeff * 100n;
  const den = 10n ** BigInt(q.scale + u.scale);
  return roundHalfUp(num, den);
}

// Same rule as the server (src/money.ts) and PayPal: a percentage discount (and a fixed one that divides exactly by
// each quantity) is baked into the unit prices, so tax is charged per line on the discounted amount, rounded half-up.
// A fixed discount that cannot be baked is taken by PayPal at invoice level, after tax, with a warning. The server
// re-checks PayPal's own total.
function scaledDecimal(raw, scale) {
  const p = parseDecimal(raw);
  return roundHalfUp(p.coeff * (10n ** BigInt(scale)), 10n ** BigInt(p.scale));
}

function percentThousandths(value) {
  return scaledDecimal(value, 3); // "8.875" -> 8875: percent scaled by 1000, rounded half-up like the server
}

function lineCentsFor(qScaled, unitCents) {
  return (qScaled * unitCents + 500n) / 1000n;
}

const INVOICE_DISCOUNT_WARNING = "PayPal applies this discount after tax, so VAT is charged on the full price";
const BOTH_DISCOUNTS_WARNING = "Give either a discount amount or a discount percent, not both";

function gcd(a, b) {
  while (b > 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function shareStep(qScaled) {
  if (qScaled <= 0n) return 0n;
  return qScaled / gcd(qScaled, 1000n);
}

// Same rule as the server: split a fixed discount so each share divides by its quantity, leftover cents on a
// quantity 1 line when one exists, and never more than the line can give. Null when it cannot bake, at invoice level.
function allocateBakeable(lines, qScaled, unitCents, discount) {
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  if (discount <= 0n) return lines.map(() => 0n);
  if (subtotal <= 0n) return null;
  const steps = qScaled.map((q) => shareStep(q));
  const caps = qScaled.map((q, i) => (q > 0n ? (unitCents[i] * q) / 1000n : 0n));
  const shares = lines.map((line, i) => {
    const step = steps[i];
    if (step <= 0n) return 0n;
    let base = (line * discount) / subtotal;
    const cap = caps[i];
    if (base > cap) base = cap;
    return (base / step) * step;
  });
  let remainder = discount - shares.reduce((a, b) => a + b, 0n);
  const order = lines
    .map((_, i) => i)
    .sort((a, b) => {
      const sa = steps[a] === 1n ? 0 : 1;
      const sb = steps[b] === 1n ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (lines[a] > lines[b]) return -1;
      if (lines[a] < lines[b]) return 1;
      return a - b;
    });
  for (const i of order) {
    if (remainder <= 0n) break;
    const step = steps[i];
    if (step <= 0n) continue;
    const room = caps[i] - shares[i];
    if (room < step) continue;
    const units = room / step;
    const wanted = remainder / step;
    const k = units < wanted ? units : wanted;
    shares[i] += k * step;
    remainder -= k * step;
  }
  if (remainder !== 0n) return null;
  return shares;
}

function effectiveHundredths(discount, subtotal) {
  if (subtotal <= 0n) return 0n;
  return (discount * 10000n + subtotal / 2n) / subtotal;
}

function offByMoreThanHalfPoint(discount, subtotal, pct) {
  if (subtotal <= 0n) return false;
  const effective = effectiveHundredths(discount, subtotal);
  const diff = effective > pct ? effective - pct : pct - effective;
  return diff > 50n;
}

function largestSingleLine(lines, qScaled) {
  let best = -1;
  for (let i = 0; i < qScaled.length; i += 1) {
    if (qScaled[i] !== 1000n) continue;
    if (best < 0 || lines[i] > lines[best]) best = i;
  }
  return best;
}

function discountPlan(draft) {
  const qScaled = draft.items.map((item) => scaledDecimal(item.quantity, 3));
  const unitCents = draft.items.map((item) => scaledDecimal(item.unitAmount, 2));
  const lines = draft.items.map((item, i) => lineCentsFor(qScaled[i], unitCents[i]));
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  const percent = draft.discountPercent != null && String(draft.discountPercent).trim() !== "" ? String(draft.discountPercent).trim() : null;
  const fixed = draft.discount != null && String(draft.discount).trim() !== "" ? String(draft.discount).trim() : null;
  if (percent != null && fixed != null) {
    const pct = scaledDecimal(percent, 2);
    const share = (subtotal * pct + 5000n) / 10000n;
    if (scaledDecimal(fixed, 2) !== share) {
      return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: 0n, baked: false, percent: null, warning: BOTH_DISCOUNTS_WARNING };
    }
  }
  if (percent != null) {
    const pct = scaledDecimal(percent, 2);
    const factor = 10000n - pct;
    const reduced = unitCents.map((cents) => (cents * factor + 5000n) / 10000n);
    const reducedLines = reduced.map((cents, i) => lineCentsFor(qScaled[i], cents));
    const lineDiscount = reducedLines.map((rl, i) => lines[i] - rl);
    const totalDiscount = lineDiscount.reduce((a, b) => a + b, 0n);
    if (offByMoreThanHalfPoint(totalDiscount, subtotal, pct)) {
      const target = (subtotal * pct + 5000n) / 10000n;
      const single = largestSingleLine(lines, qScaled);
      if (single >= 0) {
        const others = totalDiscount - lineDiscount[single];
        let share = target - others;
        if (share < 0n) share = 0n;
        if (share > lines[single]) share = lines[single];
        const adjusted = lineDiscount.slice();
        const adjustedUnits = reduced.slice();
        adjusted[single] = share;
        adjustedUnits[single] = unitCents[single] - share;
        const adjustedTotal = adjusted.reduce((a, b) => a + b, 0n);
        if (!offByMoreThanHalfPoint(adjustedTotal, subtotal, pct)) {
          return { lines, unitCents: adjustedUnits, lineDiscount: adjusted, totalDiscount: adjustedTotal, baked: true, percent, warning: null };
        }
      }
      return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: target, baked: false, percent, warning: INVOICE_DISCOUNT_WARNING };
    }
    return { lines, unitCents: reduced, lineDiscount, totalDiscount, baked: true, percent, warning: null };
  }
  if (fixed != null) {
    let discount = scaledDecimal(fixed, 2);
    if (discount > subtotal) discount = subtotal;
    const allocated = allocateBakeable(lines, qScaled, unitCents, discount);
    if (allocated) {
      const reduced = allocated.map((cents, i) => unitCents[i] - (qScaled[i] > 0n ? (cents * 1000n) / qScaled[i] : 0n));
      return { lines, unitCents: reduced, lineDiscount: allocated, totalDiscount: discount, baked: true, percent: null, warning: null };
    }
    return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: discount, baked: false, percent: null, warning: INVOICE_DISCOUNT_WARNING };
  }
  return { lines, unitCents, lineDiscount: lines.map(() => 0n), totalDiscount: 0n, baked: false, percent: null, warning: null };
}

function computeTotals(draft) {
  const plan = discountPlan(draft);
  const subtotal = plan.lines.reduce((a, b) => a + b, 0n);
  const thousandths = draft.taxPercent == null ? 0n : percentThousandths(draft.taxPercent);
  let tax = 0n;
  for (let i = 0; i < plan.lines.length; i += 1) {
    const base = plan.baked ? plan.lines[i] - plan.lineDiscount[i] : plan.lines[i];
    tax += roundHalfUp(base * thousandths, 100000n);
  }
  return { subtotal: centsToStr(subtotal), discount: centsToStr(plan.totalDiscount), tax: centsToStr(tax), total: centsToStr(subtotal - plan.totalDiscount + tax) };
}

function newDraftId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(bytes, (b) => abc[b % abc.length]).join("") + Date.now().toString(36).slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function centsToStr(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
}

// String decimals, rounded half up like the server: no float rounding (1.005 is 1.01) and no exponent notation.
function roundDecimal(value, places) {
  const text = String(value == null ? "" : value).trim();
  if (!/^\d{1,9}(\.\d+)?$/.test(text)) return null;
  const p = parseDecimal(text);
  const scaled = roundHalfUp(p.coeff * (10n ** BigInt(places)), 10n ** BigInt(p.scale));
  const s = scaled.toString().padStart(places + 1, "0");
  return places ? s.slice(0, -places) + "." + s.slice(-places) : s;
}

function decimalText(value, fallback) {
  const r = roundDecimal(value, 3);
  return r == null ? fallback : r.replace(/0+$/, "").replace(/\.$/, "");
}

function moneyText(value) {
  return roundDecimal(value, 2) ?? "0.00";
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  const code = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(safe);
  } catch {
    return `${CURRENCY_SYMBOLS[code] || code}${safe.toFixed(2)}`;
  }
}

function calendarDaysPastDue(invoice, today) {
  const dateStr = invoice && (invoice.dueDate || invoice.invoiceDate);
  if (!dateStr) return null;
  const due = Date.parse(String(dateStr));
  if (Number.isNaN(due)) return null;
  const ref = today ? Date.parse(String(today)) : Date.now();
  const base = Number.isNaN(ref) ? Date.now() : ref;
  return Math.floor((base - due) / 86400000);
}

function daysOverdue(invoice, today) {
  const past = calendarDaysPastDue(invoice, today);
  if (past == null) return null;
  // Same rule as the server: one day of grace, because PayPal sets the due date in the seller's time zone.
  return Math.max(0, past - 1);
}

function qrDataUrl(qr) {
  if (!qr) return "";
  if (/^data:image\//i.test(qr)) return qr;
  return `data:image/png;base64,${qr}`;
}

function safeHref(value) {
  const text = String(value || "");
  return /^https?:\/\//i.test(text) ? text : "";
}

function reminderMailto(invoice, subject, note) {
  if (!invoice || !invoice.customerEmail) return "";
  const payUrl = safeHref(invoice.payUrl);
  const body = [String(note || "").trim(), payUrl ? `Pay online at ${payUrl}` : ""].filter(Boolean).join("\n\n");
  return "mailto:" + encodeURIComponent(invoice.customerEmail) + "?subject=" + encodeURIComponent(String(subject || "").trim()) + "&body=" + encodeURIComponent(body);
}

function asText(value, fallback) {
  return value == null ? fallback : String(value);
}

function currencyOf(value) {
  const code = asText(value, "");
  return ["USD", "EUR", "GBP", "PLN", "CAD", "AUD"].includes(code) ? code : "USD";
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = asText(raw.name, "").slice(0, 120);
  if (!name) return null;
  return {
    name,
    quantity: decimalText(raw.quantity, "1"),
    unitAmount: moneyText(raw.unitAmount),
    unit: raw.unit === "HOURS" || raw.unit === "AMOUNT" || raw.unit === "QUANTITY" ? raw.unit : undefined,
  };
}

function normalizeTotals(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.subtotal == null || raw.tax == null || raw.total == null) return null;
  return { subtotal: moneyText(raw.subtotal), discount: moneyText(raw.discount == null ? "0" : raw.discount), tax: moneyText(raw.tax), total: moneyText(raw.total) };
}

function normalizeDraft(data) {
  const raw = data && data.draft ? data.draft : data;
  if (!raw || typeof raw !== "object") throw new ApiError(0, "The server returned an unexpected response.");
  const draft = {
    customerName: asText(raw.customerName, "Customer"),
    customerEmail: raw.customerEmail ? asText(raw.customerEmail, "") || null : null,
    currency: currencyOf(raw.currency),
    items: Array.isArray(raw.items) ? raw.items.map(normalizeItem).filter(Boolean) : [],
    taxPercent: raw.taxPercent == null || raw.taxPercent === "" ? null : String(raw.taxPercent),
    discount: raw.discount == null || raw.discount === "" ? null : moneyText(raw.discount),
    discountPercent: raw.discountPercent == null || raw.discountPercent === "" ? null : decimalText(raw.discountPercent, "0"),
    note: raw.note == null || raw.note === "" ? null : String(raw.note),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 20) : [],
  };
  const totals = normalizeTotals(data && data.totals) || computeTotals(draft);
  return { draft, totals };
}

function normalizeUnpaid(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: asText(raw.id, ""),
    number: asText(raw.number, asText(raw.id, "")),
    status: asText(raw.status, ""),
    customerName: asText(raw.customerName, "Customer"),
    customerEmail: raw.customerEmail ? asText(raw.customerEmail, "") : null,
    total: moneyText(raw.total),
    dueAmount: raw.dueAmount == null || raw.dueAmount === "" ? null : moneyText(raw.dueAmount),
    currency: currencyOf(raw.currency),
    dueDate: raw.dueDate ? asText(raw.dueDate, "") : null,
    invoiceDate: raw.invoiceDate ? asText(raw.invoiceDate, "") : null,
    payUrl: safeHref(raw.payUrl) || null,
  };
}

function normalizeStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  const status = asText(raw.status, "");
  return {
    id: asText(raw.id, ""),
    number: asText(raw.number, ""),
    status,
    customerName: asText(raw.customerName, "Customer"),
    total: moneyText(raw.total),
    paidAmount: moneyText(raw.paidAmount),
    dueAmount: raw.dueAmount == null || raw.dueAmount === "" ? null : moneyText(raw.dueAmount),
    currency: currencyOf(raw.currency),
    paid: raw.paid === true || status === "PAID" || status === "MARKED_AS_PAID",
  };
}

// Optional access code for the PayPal actions, asked once and kept for this browser tab only.
function accessCode() {
  try { return sessionStorage.getItem("pt-code") || ""; } catch (err) { return ""; }
}

async function request(path, options, fetchFn, retried) {
  const fn = typeof fetchFn === "function" ? fetchFn : globalThis.fetch;
  const opts = Object.assign({}, options || {});
  const code = accessCode();
  if (code) opts.headers = Object.assign({}, opts.headers || {}, { "x-demo-code": code });
  const res = await fn(path, opts);
  if (res.status === 401 && !retried && typeof window !== "undefined" && typeof window.prompt === "function") {
    const entered = window.prompt("This demo asks for an access code before it talks to PayPal.");
    if (entered) {
      try { sessionStorage.setItem("pt-code", entered.trim()); } catch (err) { /* private mode: the code is used for this request only */ }
      return request(path, Object.assign({}, options, { headers: Object.assign({}, (options || {}).headers || {}, { "x-demo-code": entered.trim() }) }), fetchFn, true);
    }
  }
  const body = await res.text();
  let data = null;
  if (body) {
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `Request failed (${res.status}).`;
    throw new ApiError(res.status, String(message));
  }
  return data;
}

async function createDraftRequest(text, fetchFn) {
  const data = await request("/api/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }, fetchFn);
  return normalizeDraft(data);
}

async function sendDraftRequest(draft, fetchFn) {
  const data = await request("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, draftId: state.draftId }),
  }, fetchFn);
  if (!data || typeof data !== "object") throw new ApiError(0, "The server returned an unexpected response.");
  return {
    id: asText(data.id, ""),
    number: asText(data.number, asText(data.id, "")),
    qr: asText(data.qr, ""),
    href: asText(data.href, ""),
    amount: data.amount && data.amount.value ? `${data.amount.value} ${asText(data.amount.currency, "")}` : "",
    emailed: Boolean(data.emailed),
    partial: Boolean(data.partial),
  };
}

async function listUnpaidRequest(fetchFn) {
  const data = await request("/api/unpaid", { method: "GET" }, fetchFn);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.invoices) ? data.invoices : []);
  const paid = data && Array.isArray(data.paidToday) ? data.paidToday : [];
  return {
    invoices: list.map(normalizeUnpaid).filter(Boolean),
    paidToday: paid.map(normalizeStatus).filter(Boolean),
  };
}

async function invoiceStatusRequest(id, fetchFn) {
  const data = await request(`/api/invoice/${encodeURIComponent(id)}/status`, { method: "GET" }, fetchFn);
  const status = normalizeStatus(data && data.invoice ? data.invoice : data);
  if (!status) throw new ApiError(0, "The server returned an unexpected response.");
  return status;
}

async function recordPaymentRequest(id, fetchFn) {
  const data = await request(`/api/invoice/${encodeURIComponent(id)}/record-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, fetchFn);
  if (data && data.pending === true) {
    return { pending: true, message: asText(data.message, "PayPal is still recording the payment. Tap Refresh in a minute."), status: null };
  }
  const status = normalizeStatus(data && data.invoice ? data.invoice : data);
  if (!status) throw new ApiError(0, "The server returned an unexpected response.");
  return { pending: false, message: "", status };
}

async function draftReminderRequest(id, fetchFn) {
  const data = await request("/api/reminder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }, fetchFn);
  if (!data || typeof data !== "object") throw new ApiError(0, "The server returned an unexpected response.");
  const r = data.reminder && typeof data.reminder === "object" ? data.reminder : data;
  return {
    subject: asText(r.subject, ""),
    note: asText(r.note, ""),
    tone: asText(r.tone, "friendly"),
  };
}

async function sendReminderRequest(id, fetchFn) {
  await request("/api/remind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }, fetchFn);
  return true;
}

function friendlyMessage(err) {
  if (err && err instanceof ApiError) return err.message;
  if (err && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

function computeWarnings(draft) {
  const warnings = [];
  const plan = discountPlan(draft);
  if (plan.warning) warnings.push(plan.warning);
  if (!draft.customerEmail) warnings.push("No customer email. The customer can pay by scanning the QR code.");
  if (!draft.customerName || !draft.customerName.trim()) warnings.push("No customer name.");
  for (const item of draft.items) {
    if (!item.name || !item.name.trim()) { warnings.push("An item has no name."); break; }
    if (Number(item.unitAmount) <= 0) { warnings.push("An item is priced at zero."); break; }
  }
  return warnings;
}

function dedupeWarnings(serverWarnings, localWarnings) {
  const seen = new Set();
  const out = [];
  for (const w of serverWarnings.concat(localWarnings)) {
    const text = String(w).trim();
    const key = text.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function overdueLabel(invoice, today) {
  const past = calendarDaysPastDue(invoice, today);
  if (past == null) return { text: "No due date", className: "muted" };
  if (past === 0) return { text: "Due today", className: "muted" };
  if (past < 0) return { text: `Due in ${-past} day${past === -1 ? "" : "s"}`, className: "muted" };
  return { text: `Overdue ${past} day${past === 1 ? "" : "s"}`, className: "danger" };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function makeInput(type, value, label) {
  const input = el("input", "input");
  input.type = type;
  input.value = value == null ? "" : String(value);
  input.setAttribute("aria-label", label);
  return input;
}

function actionsEl(buttons, className) {
  const wrap = el("div", className || "actions");
  for (const b of buttons) wrap.append(b);
  return wrap;
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

function clearError(node) {
  node.textContent = "";
  node.hidden = true;
}

// A recording PayPal has not confirmed yet: show the message and a Refresh button, never an error.
function pendingNotice(message, onRefresh) {
  const wrap = el("div", "pending-notice");
  const text = el("p", "pending-notice__text", message);
  const refreshBtn = el("button", "btn btn--small", "Refresh");
  refreshBtn.type = "button";
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
    try {
      await onRefresh();
      wrap.remove();
    } catch (err) {
      text.textContent = friendlyMessage(err);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  });
  wrap.append(text, refreshBtn);
  return wrap;
}

function totalsLine(label, amount, strong) {
  const row = el("div", strong ? "totals__row totals__row--strong" : "totals__row");
  row.append(el("span", "totals__label", label), el("span", "totals__value", formatMoney(amount, state.draft.currency)));
  return row;
}

function renderTotals(box, warningsBox) {
  const totals = state.totals || computeTotals(state.draft);
  box.replaceChildren();
  box.append(totalsLine("Subtotal", totals.subtotal, false));
  if (totals.discount && totals.discount !== "0.00") box.append(totalsLine("Discount", "-" + totals.discount, false));
  box.append(totalsLine("Tax", totals.tax, false));
  box.append(totalsLine("Total", totals.total, true));
  const warnings = dedupeWarnings(state.draft.warnings || [], computeWarnings(state.draft));
  renderWarnings(warningsBox, warnings);
}

function renderWarnings(box, warnings) {
  box.replaceChildren();
  if (!warnings.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.append(el("h3", "warnings__title", "Please check"));
  for (const w of warnings) box.append(el("p", "warnings__item", w));
}

function itemRow(item, onChange, onRemove) {
  const rowEl = el("div", "item-row");
  const nameInput = el("input", "input item-row__name");
  nameInput.type = "text";
  nameInput.placeholder = "Description";
  nameInput.value = item.name;
  nameInput.setAttribute("aria-label", "Item description");
  const qtyInput = el("input", "input item-row__qty");
  qtyInput.type = "number";
  qtyInput.min = "0";
  qtyInput.step = "any";
  qtyInput.value = item.quantity;
  qtyInput.setAttribute("aria-label", "Quantity");
  const unitInput = el("input", "input item-row__unit");
  unitInput.type = "number";
  unitInput.min = "0";
  unitInput.step = "0.01";
  unitInput.value = item.unitAmount;
  unitInput.setAttribute("aria-label", "Unit price");
  const removeBtn = el("button", "icon-btn item-row__remove", "Remove");
  removeBtn.type = "button";
  removeBtn.setAttribute("aria-label", "Remove item");

  const sync = () => {
    item.name = nameInput.value;
    item.quantity = decimalText(qtyInput.value, "0");
    item.unitAmount = moneyText(unitInput.value);
    onChange();
  };
  nameInput.addEventListener("input", sync);
  qtyInput.addEventListener("input", sync);
  unitInput.addEventListener("input", sync);
  removeBtn.addEventListener("click", () => onRemove(rowEl));

  rowEl.append(nameInput, qtyInput, el("span", "item-row__times", "\u00d7"), unitInput, removeBtn);
  return rowEl;
}

function buildPreview(ui) {
  const card = el("div", "card");
  card.append(el("h2", "card__title", "Check the invoice"));

  const nameInput = makeInput("text", state.draft.customerName, "Customer name");
  const emailInput = makeInput("email", state.draft.customerEmail || "", "Email");
  emailInput.placeholder = "Email (optional)";
  const itemsWrap = el("div", "items");
  const addBtn = el("button", "btn btn--ghost", "Add item");
  addBtn.type = "button";
  const taxInput = makeInput("number", state.draft.taxPercent || "", "Tax percent");
  taxInput.min = "0";
  taxInput.max = "30";
  taxInput.step = "any";
  taxInput.placeholder = "e.g. 23";
  const currencySelect = document.createElement("select");
  currencySelect.className = "input";
  currencySelect.setAttribute("aria-label", "Currency");
  for (const code of ["USD", "EUR", "GBP", "PLN", "CAD", "AUD"]) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = code;
    if (code === state.draft.currency) opt.selected = true;
    currencySelect.append(opt);
  }
  const discountInput = makeInput("number", state.draft.discount || "", "Discount amount");
  discountInput.min = "0";
  discountInput.step = "0.01";
  discountInput.placeholder = "Amount off the whole invoice (optional)";
  const discountPercentInput = makeInput("number", state.draft.discountPercent || "", "Discount percent");
  discountPercentInput.min = "0";
  discountPercentInput.max = "100";
  discountPercentInput.step = "any";
  discountPercentInput.placeholder = "Percent off (optional)";
  const discountRow = el("div", "discount-row");
  const amountField = el("div", "field");
  amountField.append(el("label", "field-label", "Discount"), discountInput);
  const percentField = el("div", "field");
  percentField.append(el("label", "field-label", "Discount (percent)"), discountPercentInput);
  discountRow.append(amountField, percentField);
  const noteInput = el("textarea", "input input--note");
  noteInput.value = state.draft.note || "";
  noteInput.rows = 3;
  noteInput.setAttribute("aria-label", "Note");
  const totalsBox = el("div", "totals");
  const warningsBox = el("div", "warnings");
  const backBtn = el("button", "btn btn--ghost", "Back");
  backBtn.type = "button";
  const sendBtn = el("button", "btn btn--primary", "Send with PayPal");
  sendBtn.type = "button";

  card.append(
    el("label", "field-label", "Customer name"), nameInput,
    el("label", "field-label", "Email"), emailInput,
    el("h3", "card__sub", "Items"), itemsWrap, addBtn,
    el("label", "field-label", "Currency"), currencySelect,
    discountRow,
    el("label", "field-label", "Tax (percent)"), taxInput,
    el("label", "field-label", "Note"), noteInput,
    totalsBox, warningsBox,
    actionsEl([backBtn, sendBtn]),
  );

  const sync = () => {
    state.totals = computeTotals(state.draft);
    renderTotals(totalsBox, warningsBox);
  };

  state.draft.items.forEach((item) => addItem(itemsWrap, item, sync));

  addBtn.addEventListener("click", () => {
    const item = { name: "", quantity: "1", unitAmount: "0.00" };
    state.draft.items.push(item);
    addItem(itemsWrap, item, sync);
    sync();
  });
  if (!state.draftId) state.draftId = newDraftId();
  currencySelect.addEventListener("change", () => { state.draft.currency = currencySelect.value; sync(); });
  discountInput.addEventListener("input", () => { state.draft.discount = discountInput.value.trim() || null; sync(); });
  discountPercentInput.addEventListener("input", () => { state.draft.discountPercent = discountPercentInput.value.trim() || null; sync(); });
  wirePreviewControls(ui, { nameInput, emailInput, taxInput, noteInput, backBtn, sendBtn }, sync);

  renderTotals(totalsBox, warningsBox);
  ui.preview.replaceChildren(card);
  ui.preview.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addItem(itemsWrap, item, sync) {
  const row = itemRow(item, sync, (rowEl) => {
    state.draft.items = state.draft.items.filter((x) => x !== item);
    rowEl.remove();
    sync();
  });
  itemsWrap.append(row);
}

function wirePreviewControls(ui, refs, sync) {
  refs.nameInput.addEventListener("input", () => { state.draft.customerName = refs.nameInput.value; sync(); });
  refs.emailInput.addEventListener("input", () => { state.draft.customerEmail = refs.emailInput.value.trim() || null; sync(); });
  refs.taxInput.addEventListener("input", () => { state.draft.taxPercent = refs.taxInput.value.trim() || null; sync(); });
  refs.noteInput.addEventListener("input", () => { state.draft.note = refs.noteInput.value.trim() || null; sync(); });
  refs.backBtn.addEventListener("click", () => { ui.preview.hidden = true; ui.preview.replaceChildren(); });
  refs.sendBtn.addEventListener("click", () => handleSend(ui, refs.sendBtn));
}

async function handleMake(ui) {
  const text = ui.jobText.value.trim();
  if (!text) {
    showError(ui.newError, "Describe the job first.");
    return;
  }
  ui.makeBtn.disabled = true;
  ui.makeBtn.textContent = "Working...";
  clearError(ui.newError);
  try {
    const { draft, totals } = await createDraftRequest(text);
    state.draftId = newDraftId(); // one id per draft: a retry of the same send can never create a second invoice
    state.draft = draft;
    state.totals = totals;
    buildPreview(ui);
  } catch (err) {
    showError(ui.newError, friendlyMessage(err));
  } finally {
    ui.makeBtn.disabled = false;
    ui.makeBtn.textContent = "Make invoice";
  }
}

async function handleSend(ui, sendBtn) {
  sendBtn.disabled = true;
  clearError(ui.newError);
  try {
    const result = await sendDraftRequest(state.draft);
    showSuccess(ui, result);
  } catch (err) {
    showError(ui.newError, friendlyMessage(err));
  } finally {
    sendBtn.disabled = false;
  }
}

function buildStatusBox(invoiceId, initial, onPaid) {
  const box = el("div", "status-box");
  const line = el("p", "status-box__line");
  const detail = el("p", "muted status-box__detail");
  const errorBox = el("p", "error");
  errorBox.hidden = true;
  errorBox.setAttribute("role", "alert");
  const refreshBtn = el("button", "btn btn--ghost", "Refresh");
  refreshBtn.type = "button";
  const cashBtn = el("button", "btn btn--small", "Paid in cash");
  cashBtn.type = "button";
  const actions = el("div", "status-box__actions");
  actions.append(refreshBtn, cashBtn);

  let last = initial;

  const apply = (status) => {
    last = status;
    const paid = Boolean(status && status.paid);
    box.classList.toggle("status-box--paid", paid);
    line.textContent = paid ? "Paid" : `Status ${status.status || "unknown"}`;
    const bits = [];
    if (status.total && Number(status.total) > 0) bits.push(`Total ${formatMoney(status.total, status.currency)}`);
    if (paid) bits.push(`Paid ${formatMoney(status.paidAmount, status.currency)}`);
    else if (status.dueAmount != null) bits.push(`Due ${formatMoney(status.dueAmount, status.currency)}`);
    detail.textContent = bits.join(" \u00b7 ");
    cashBtn.hidden = paid;
    if (paid && typeof onPaid === "function") onPaid(status);
  };

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
    clearError(errorBox);
    try {
      apply(await invoiceStatusRequest(invoiceId));
    } catch (err) {
      showError(errorBox, friendlyMessage(err));
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  });

  cashBtn.addEventListener("click", async () => {
    const due = last && last.dueAmount != null ? last.dueAmount : last && last.total;
    const amount = due ? formatMoney(due, last.currency) : "";
    const question = amount ? `Record ${amount} as paid in cash? PayPal will mark it paid.` : "Record this invoice as paid in cash? PayPal will mark it paid.";
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(question)) return;
    cashBtn.disabled = true;
    clearError(errorBox);
    try {
      const result = await recordPaymentRequest(invoiceId);
      if (result.pending) {
        line.textContent = result.message;
        detail.textContent = "";
        cashBtn.hidden = true;
      } else {
        apply(result.status);
      }
    } catch (err) {
      showError(errorBox, friendlyMessage(err));
    } finally {
      cashBtn.disabled = false;
    }
  });

  apply(initial);
  box.append(line, detail, errorBox, actions);
  return box;
}

function showSuccess(ui, result) {
  ui.preview.hidden = true;
  const card = el("div", "card card--success");
  card.append(el("h2", "card__title", result.emailed ? "Invoice sent" : "Invoice ready"));
  card.append(el("p", "muted", result.emailed ? "PayPal emailed it to your customer. They can also scan to pay now." : "No email on the invoice: show the QR code or share the pay link."));
  card.append(el("p", "success__number", `Invoice ${result.number || result.id || ""}${result.amount ? " \u00b7 " + result.amount : ""}`));
  if (result.partial) card.append(el("p", "muted", "The invoice is sent. PayPal did not return every detail just now; open it from the Unpaid tab."));
  if (result.id) card.append(buildStatusBox(result.id, { status: "SENT", total: "", paidAmount: "0.00", dueAmount: null, currency: "", paid: false }, null));

  if (result.qr) {
    const img = document.createElement("img");
    img.className = "qr";
    img.alt = "QR code to pay this invoice";
    img.src = qrDataUrl(result.qr);
    card.append(img);
  }

  const href = safeHref(result.href);
  if (href) {
    const link = document.createElement("a");
    link.className = "link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open invoice";
    card.append(link);
    const copyBtn = el("button", "btn btn--ghost", "Copy pay link");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(href); copyBtn.textContent = "Copied"; } catch (err) { copyBtn.textContent = "Copy failed"; }
    });
    card.append(copyBtn);
  }

  const againBtn = el("button", "btn btn--primary", "Make another");
  againBtn.type = "button";
  againBtn.addEventListener("click", () => { ui.success.replaceChildren(); ui.success.hidden = true; state.draftId = null; ui.jobText.value = ""; ui.jobText.focus(); });
  card.append(againBtn);

  ui.success.replaceChildren(card);
  ui.success.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function unpaidRow(ui, invoice) {
  const row = el("div", "unpaid-row");
  const top = el("div", "unpaid-row__top");
  top.append(el("span", "unpaid-row__name", invoice.customerName || invoice.customerEmail || "Customer"));
  top.append(el("span", "unpaid-row__amount", formatMoney(invoice.total, invoice.currency)));
  const bottom = el("div", "unpaid-row__bottom");
  const lbl = overdueLabel(invoice);
  bottom.append(el("span", `unpaid-row__status unpaid-row__status--${lbl.className}`, lbl.text));
  const payUrl = safeHref(invoice.payUrl);
  if (payUrl) {
    const link = document.createElement("a");
    link.className = "link unpaid-row__pay";
    link.href = payUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Pay link";
    bottom.append(link);
  }
  const btn = el("button", "btn btn--small", "Draft reminder");
  btn.type = "button";
  btn.addEventListener("click", () => handleDraftReminder(ui, invoice, btn));
  bottom.append(btn);
  const cashBtn = el("button", "btn btn--small", "Paid in cash");
  cashBtn.type = "button";
  cashBtn.addEventListener("click", () => handleRecordPayment(ui, invoice, cashBtn));
  bottom.append(cashBtn);
  row.append(top, bottom);
  if (invoice.status === "PARTIALLY_PAID" && invoice.dueAmount) {
    row.append(el("p", "unpaid-row__due", `Still due ${formatMoney(invoice.dueAmount, invoice.currency)} of ${formatMoney(invoice.total, invoice.currency)}`));
  }
  return row;
}

function renderUnpaidList(ui, list) {
  ui.unpaidList.replaceChildren();
  if (!list.length) {
    ui.unpaidList.append(el("p", "muted", "No unpaid invoices yet."));
    return;
  }
  for (const invoice of list) ui.unpaidList.append(unpaidRow(ui, invoice));
}

function renderPaidToday(ui, list) {
  if (!ui.paidToday) return;
  ui.paidToday.replaceChildren();
  if (!list.length) {
    ui.paidToday.hidden = true;
    return;
  }
  ui.paidToday.hidden = false;
  ui.paidToday.append(el("h3", "paid-today__title", "Paid today"));
  for (const invoice of list) {
    const row = el("div", "paid-today__row");
    row.append(el("span", "paid-today__name", invoice.customerName || invoice.number || invoice.id || "Customer"));
    row.append(el("span", "paid-today__amount", formatMoney(invoice.paidAmount || invoice.total, invoice.currency)));
    row.append(el("span", "paid-today__status", invoice.status === "MARKED_AS_PAID" ? "Marked as paid" : "Paid"));
    ui.paidToday.append(row);
  }
}

async function loadUnpaid(ui) {
  ui.unpaidList.replaceChildren(el("p", "muted", "Loading..."));
  clearError(ui.unpaidError);
  try {
    const data = await listUnpaidRequest();
    renderUnpaidList(ui, data.invoices);
    renderPaidToday(ui, data.paidToday);
  } catch (err) {
    ui.unpaidList.replaceChildren();
    if (ui.paidToday) ui.paidToday.hidden = true;
    showError(ui.unpaidError, friendlyMessage(err));
  }
}

async function handleRecordPayment(ui, invoice, btn) {
  const due = invoice.dueAmount || invoice.total;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Record ${formatMoney(due, invoice.currency)} as paid in cash? PayPal will mark it paid.`)) return;
  btn.disabled = true;
  clearError(ui.unpaidError);
  try {
    const result = await recordPaymentRequest(invoice.id);
    if (result.pending) {
      const row = btn.closest ? btn.closest(".unpaid-row") : null;
      if (row) row.append(pendingNotice(result.message, () => loadUnpaid(ui)));
    } else {
      await loadUnpaid(ui);
    }
  } catch (err) {
    showError(ui.unpaidError, friendlyMessage(err));
  } finally {
    btn.disabled = false;
  }
}

async function handleDraftReminder(ui, invoice, btn) {
  btn.disabled = true;
  clearError(ui.unpaidError);
  try {
    const reminder = await draftReminderRequest(invoice.id);
    buildReminderEditor(ui, invoice, reminder);
  } catch (err) {
    showError(ui.unpaidError, friendlyMessage(err));
  } finally {
    btn.disabled = false;
  }
}

function buildReminderEditor(ui, invoice, reminder) {
  const card = el("div", "card");
  card.append(el("h2", "card__title", `Reminder for ${invoice.customerName || invoice.customerEmail || "Customer"}`));

  const subject = el("input", "input");
  subject.type = "text";
  subject.value = reminder.subject;
  subject.setAttribute("aria-label", "Reminder subject");
  const note = el("textarea", "input input--note");
  note.value = reminder.note;
  note.rows = 5;
  note.setAttribute("aria-label", "Reminder message");
  const errorBox = el("p", "error");
  errorBox.hidden = true;
  errorBox.setAttribute("role", "alert");
  const sendBtn = el("button", "btn btn--primary", "Send reminder");
  sendBtn.type = "button";
  const backBtn = el("button", "btn btn--ghost", "Back");
  backBtn.type = "button";

  const emailBtn = el("button", "btn btn--ghost", "Email this message");
  emailBtn.type = "button";
  const copyBtn = el("button", "btn btn--ghost", "Copy message");
  copyBtn.type = "button";
  sendBtn.textContent = "Send PayPal reminder";

  card.append(
    el("p", "muted", "PayPal sends its own standard reminder with the pay button. It does not use custom text, so the message below is yours to send by email or text, in your own words."),
    el("label", "field-label", "Subject"), subject,
    el("label", "field-label", "Message"), note,
    errorBox,
    actionsEl([backBtn, copyBtn, emailBtn, sendBtn], "actions actions--reminder"),
  );

  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(note.value.trim()); copyBtn.textContent = "Copied"; } catch (err) { showError(errorBox, "Copy failed: select the message and copy it."); }
  });
  emailBtn.addEventListener("click", () => {
    if (!invoice.customerEmail) { showError(errorBox, "This invoice has no customer email."); return; }
    window.location.href = reminderMailto(invoice, subject.value, note.value);
  });
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    backBtn.disabled = true;
    try {
      await sendReminderRequest(invoice.id);
      sendBtn.textContent = "PayPal reminder sent";
    } catch (err) {
      sendBtn.disabled = false;
      showError(errorBox, friendlyMessage(err));
    } finally {
      backBtn.disabled = false;
    }
  });

  backBtn.addEventListener("click", () => ui.reminderEditor.replaceChildren());
  ui.reminderEditor.replaceChildren(card);
  ui.reminderEditor.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function wireChips(ui) {
  for (const chip of ui.chipButtons) {
    chip.addEventListener("click", () => {
      ui.jobText.value = EXAMPLES[chip.dataset.example] || "";
      ui.jobText.focus();
    });
  }
}

function wireSpeech(ui) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    ui.micBtn.disabled = true;
    ui.micBtn.setAttribute("aria-label", "Voice input is not supported in this browser");
    ui.micBtn.title = "Voice input is not supported in this browser";
    return;
  }
  let recognition = null;
  ui.micBtn.addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
      const current = ui.jobText.value.trim();
      ui.jobText.value = (current ? `${current} ` : "") + transcript.trim();
    };
    recognition.onerror = () => showError(ui.newError, "Voice input was not available. Type the job instead.");
    recognition.onend = () => {
      ui.micBtn.classList.remove("mic-btn--recording");
      ui.micBtn.setAttribute("aria-label", "Speak the job description");
      recognition = null;
    };
    ui.micBtn.classList.add("mic-btn--recording");
    ui.micBtn.setAttribute("aria-label", "Listening");
    recognition.start();
  });
}

function wireTabs(ui) {
  const tabs = [ui.tabNew, ui.tabUnpaid];
  const panels = [ui.panelNew, ui.panelUnpaid];
  function activate(index) {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    if (index === 1) loadUnpaid(ui);
  }
  ui.tabNew.addEventListener("click", () => activate(0));
  ui.tabUnpaid.addEventListener("click", () => activate(1));
  tabs.forEach((tab, i) => {
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      activate(next);
      tabs[next].focus();
      e.preventDefault();
    });
  });
}

function grabElements() {
  const byId = (id) => document.getElementById(id);
  return {
    tabNew: byId("tab-new"),
    tabUnpaid: byId("tab-unpaid"),
    panelNew: byId("panel-new"),
    panelUnpaid: byId("panel-unpaid"),
    jobText: byId("job-text"),
    micBtn: byId("mic-btn"),
    makeBtn: byId("make-btn"),
    newError: byId("new-error"),
    preview: byId("preview"),
    success: byId("success"),
    unpaidError: byId("unpaid-error"),
    unpaidList: byId("unpaid-list"),
    paidToday: byId("paid-today"),
    reminderEditor: byId("reminder-editor"),
    chipButtons: Array.from(document.querySelectorAll(".chip")),
  };
}

const state = { draft: null, totals: null };

function init() {
  const ui = grabElements();
  wireTabs(ui);
  wireChips(ui);
  wireSpeech(ui);
  ui.makeBtn.addEventListener("click", () => handleMake(ui));
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

export {
  ApiError,
  parseDecimal,
  roundHalfUp,
  lineTotalCents,
  computeTotals,
  centsToStr,
  decimalText,
  moneyText,
  formatMoney,
  daysOverdue,
  calendarDaysPastDue,
  qrDataUrl,
  safeHref,
  reminderMailto,
  asText,
  currencyOf,
  normalizeItem,
  normalizeTotals,
  normalizeDraft,
  normalizeUnpaid,
  normalizeStatus,
  createDraftRequest,
  sendDraftRequest,
  listUnpaidRequest,
  invoiceStatusRequest,
  recordPaymentRequest,
  draftReminderRequest,
  sendReminderRequest,
  friendlyMessage,
  computeWarnings,
  dedupeWarnings,
  overdueLabel,
};
