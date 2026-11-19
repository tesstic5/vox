/**
 * Money — what the practice is owed, what it has been paid, and what it spent.
 *
 * Four rules shape this entire file, and they exist because money is the one part
 * of a practice system where "close enough" is a bug report from an accountant:
 *
 *   - **Integers, never floats.** Every amount in here is a whole number of
 *     *minor units* (cents, pence, paise). Prices, discounts, tax and totals are
 *     all integers; the only division happens in `formatMoney`, and it happens
 *     once, at the edge, for display. A practice that adds up its own invoices in
 *     a spreadsheet must get the same answer to the cent.
 *   - **An issued invoice is a document.** Drafts are edited freely. Once an
 *     invoice is *issued* it has a number, a date and a due date, and the only
 *     things that may happen to it afterwards are payments, a credit note, or a
 *     void with a reason — never a quiet edit. This is the same rule the notes
 *     layer applies to a signed note, for the same reason.
 *   - **A payment is a row, not a status.** Nothing "marks an invoice paid".
 *     Money arrives as a payment (or a prepayment, or a credit, or leaves as a
 *     refund), and the invoice's paid/balance numbers are *derived* from those
 *     rows every time they change. An invoice cannot be paid by a flag.
 *   - **The statement reconciles by construction.** The client ledger is derived
 *     from the same rows as the invoices, and `statement()` asserts the two agree
 *     before returning — a disagreement is a bug, not a report.
 *
 * Money here is the *practice's* money. Voxera's own subscription billing lives
 * in `metering.ts` and is a different ledger entirely.
 */

import { get, insert, list, newId, nowIso, remove, update, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { clientById, type ClientDoc } from './clients';
import { bookingById, type BookingDoc } from './bookings';
import { practiceProfile, serviceById, type ServiceDoc } from './practice';
import { CURRENCIES, formatMoney, fromMinor, toMinor } from './money-format';
import { cancelPendingChases, queuePaymentNotice } from './receipts';

/* --------------------------------------------------------------- currencies */

/**
 * The arithmetic and the words live in `money-format.ts` — a leaf, so that the
 * parts of the product which *talk* about money (receipts, chases) can format a
 * figure without importing the ledger that record it. Re-exported here, so
 * `from './money'` still gets everything it always did.
 */
export { CURRENCIES, minorUnits, toMinor, fromMinor, formatMoney } from './money-format';
export type { Currency } from './money-format';

/* ------------------------------------------------------------------ settings */

export type MoneySettings = {
  /** The currency invoices are written in. Set once; changing it does not rewrite history. */
  currency: string;
  /** What invoice numbers start with — `INV-0001`. */
  invoicePrefix: string;
  /** Days from issue to due date. */
  termsDays: number;
  /** Tax added to a line when a service does not carry its own rate. */
  defaultTaxRatePct: number;
  /** Prices are quoted tax-exclusive unless a practice says otherwise. */
  taxMode: 'exclusive' | 'inclusive';
  /** Issue a draft invoice when an appointment is marked completed. */
  autoInvoiceOnComplete: boolean;
  /** What goes at the foot of every invoice and statement. */
  footer?: string;
};

const DEFAULT_MONEY_SETTINGS: MoneySettings = {
  currency: 'USD',
  invoicePrefix: 'INV',
  termsDays: 14,
  defaultTaxRatePct: 0,
  taxMode: 'exclusive',
  autoInvoiceOnComplete: false,
};

/**
 * What a prefix is allowed to be. Read defensively on purpose: a settings row
 * that lost its prefix — an older save, a hand-edited file, an API client that
 * sent `null` — must not be able to take invoicing down with it. The counter
 * calls `.replace` on whatever this returns, so this always returns something.
 */
function invoicePrefixOf(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || DEFAULT_MONEY_SETTINGS.invoicePrefix;
}

export function moneySettingsFor(orgId: string): MoneySettings {
  const org = get<Doc & { money?: Partial<MoneySettings> }>('orgs', orgId);
  const stored = org?.money ?? {};
  const currency = String(stored.currency ?? DEFAULT_MONEY_SETTINGS.currency).toUpperCase();
  /**
   * A stored row can be *present but empty* — a settings save from a client that
   * sent the key with nothing in it, or a hand-edited file. `setMoneySettings`
   * refuses to write that, but rows already written before this fix are still out
   * there, and one of them took `issue` down with a 500 the moment anybody tried
   * to bill. Reading heals them instead of leaving the workspace to be re-saved
   * by hand.
   */
  const prefix = invoicePrefixOf(stored.invoicePrefix);
  if (org && stored.invoicePrefix !== undefined && stored.invoicePrefix !== prefix) {
    // Heal it: a stored row that lost its prefix would otherwise 500 the moment
    // anybody tried to bill, and the workspace would have to be re-saved by hand.
    update<Doc & { money?: Partial<MoneySettings> }>('orgs', orgId, { money: { ...stored, invoicePrefix: prefix } } as never);
  }
  return {
    ...DEFAULT_MONEY_SETTINGS,
    ...stored,
    currency: (CURRENCIES as readonly string[]).includes(currency) ? currency : DEFAULT_MONEY_SETTINGS.currency,
    invoicePrefix: invoicePrefixOf(stored.invoicePrefix),
    termsDays: Number.isFinite(Number(stored.termsDays)) ? Math.max(0, Math.round(Number(stored.termsDays))) : DEFAULT_MONEY_SETTINGS.termsDays,
    defaultTaxRatePct: Number.isFinite(Number(stored.defaultTaxRatePct)) ? Math.min(100, Math.max(0, Number(stored.defaultTaxRatePct))) : 0,
  };
}

/**
 * Saves the books' settings.
 *
 * A patch only ever *adds*: a field left out of the request keeps what it had.
 * That is not politeness — it is what stops a screen that changes the payment
 * terms from blanking the invoice prefix, which used to leave the workspace
 * unable to issue a single invoice (`settings.invoicePrefix.replace` on
 * `undefined`). Undefined reaching here is the same statement as an absent key,
 * so it is dropped rather than stored.
 */
export function setMoneySettings(orgId: string, patch: Partial<MoneySettings>, actor: string): MoneySettings {
  const current = moneySettingsFor(orgId);
  // `undefined` is not a value anybody sends on purpose — it is what a client that
  // mentions every key but fills in none produces. It must never overwrite.
  const body = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<MoneySettings>;
  const next: MoneySettings = { ...current, ...body, invoicePrefix: invoicePrefixOf(body.invoicePrefix ?? current.invoicePrefix) };
  if (!(CURRENCIES as readonly string[]).includes(String(next.currency).toUpperCase())) {
    throw new Error(`Unsupported currency ${next.currency}.`);
  }
  update<Doc>('orgs', orgId, { money: next } as never);
  audit({ orgId, actor, action: 'money.settings_updated', detail: Object.keys(body).sort().join(', ') || 'no change' });
  return next;
}

/* ------------------------------------------------------------------ payment types */

export type PaymentTypeDoc = Doc & {
  orgId: string;
  name: string;
  /** How the money physically arrives — decides what the ledger calls it. */
  kind: 'cash' | 'card' | 'transfer' | 'other';
  code?: string;
  active: boolean;
  createdAt: string;
};

/** The counter's default set. A workspace edits these; the ledger never assumes them. */
export const DEFAULT_PAYMENT_TYPES: { name: string; kind: PaymentTypeDoc['kind']; code?: string }[] = [
  { name: 'Card', kind: 'card', code: 'CARD' },
  { name: 'Cash', kind: 'cash', code: 'CASH' },
  { name: 'Bank transfer', kind: 'transfer', code: 'BANK' },
  { name: 'Direct debit', kind: 'transfer', code: 'DD' },
  { name: 'Voucher', kind: 'other', code: 'VOUCHER' },
  { name: 'Account credit', kind: 'other', code: 'CREDIT' },
];

export function seedPaymentTypes(orgId: string): { seeded: number; total: number } {
  const existing = list<PaymentTypeDoc>('paymentTypes', (t) => t.orgId === orgId);
  let seeded = 0;
  for (const type of DEFAULT_PAYMENT_TYPES) {
    if (existing.some((t) => t.name.toLowerCase() === type.name.toLowerCase())) continue;
    insert<PaymentTypeDoc>('paymentTypes', {
      id: newId('ptype_'),
      orgId,
      name: type.name,
      kind: type.kind,
      code: type.code,
      active: true,
      createdAt: nowIso(),
    } as PaymentTypeDoc);
    seeded += 1;
  }
  return { seeded, total: list<PaymentTypeDoc>('paymentTypes', (t) => t.orgId === orgId).length };
}

export function paymentTypesFor(orgId: string, opts?: { includeInactive?: boolean }): PaymentTypeDoc[] {
  const all = list<PaymentTypeDoc>('paymentTypes', (t) => t.orgId === orgId);
  return (opts?.includeInactive ? all : all.filter((t) => t.active)).sort((a, b) => a.name.localeCompare(b.name));
}

export function paymentTypeByName(orgId: string, name: string): PaymentTypeDoc | undefined {
  const wanted = String(name ?? '').trim().toLowerCase();
  return list<PaymentTypeDoc>('paymentTypes', (t) => t.orgId === orgId).find(
    (t) => t.name.toLowerCase() === wanted || String(t.code ?? '').toLowerCase() === wanted
  );
}

/* --------------------------------------------------------------- RBAC (money) */

/** Everyone who works the desk can see what is owed — that is how they take money. */
export const MONEY_READ_ROLES = ['owner', 'admin', 'developer', 'practitioner', 'receptionist', 'viewer'] as const;
/** Issuing, adjusting, voiding, refunding and pricing are the practice's books. */
export const MONEY_EDIT_ROLES = ['owner', 'admin', 'developer'] as const;
/** Taking money in at the counter is a receptionist's job; it is not "editing". */
export const MONEY_TAKE_ROLES = ['owner', 'admin', 'developer', 'receptionist'] as const;

export function canReadMoney(role?: string): boolean {
  return MONEY_READ_ROLES.includes(String(role) as (typeof MONEY_READ_ROLES)[number]);
}
export function canEditMoney(role?: string): boolean {
  return MONEY_EDIT_ROLES.includes(String(role) as (typeof MONEY_EDIT_ROLES)[number]);
}
export function canTakePayment(role?: string): boolean {
  return MONEY_TAKE_ROLES.includes(String(role) as (typeof MONEY_TAKE_ROLES)[number]);
}

/* -------------------------------------------------------------------- invoices */

export type InvoiceStatus = 'draft' | 'issued' | 'partly_paid' | 'paid' | 'overdue' | 'void';

export type InvoiceLine = {
  id: string;
  description: string;
  qty: number;
  /** Price per unit, in minor units — what the practice quotes. */
  unitAmountMinor: number;
  taxRatePct: number;
  /** Derived, and stored so the document can be read without recomputing: */
  netMinor: number;
  discountMinor: number;
  taxMinor: number;
  grossMinor: number;
  code?: string;
  serviceId?: string;
  bookingId?: string;
  providerId?: string;
};

export type InvoiceDoc = Doc & {
  orgId: string;
  /** `INV-0007`, or `CR-0002` for a credit note. Assigned at issue. */
  number?: string;
  kind: 'invoice' | 'credit';
  status: InvoiceStatus;
  clientId: string;
  clientName?: string;
  bookingIds: string[];
  currency: string;
  lines: InvoiceLine[];
  discountPct?: number;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  taxMode: 'exclusive' | 'inclusive';
  issueDate?: string;
  dueDate?: string;
  issuedAt?: string;
  voidedAt?: string;
  voidReason?: string;
  /** For a credit note: the invoice it credits. */
  creditedInvoiceId?: string;
  notes?: string;
  footer?: string;
  createdBy: string;
  createdByName?: string;
  source: 'manual' | 'booking' | 'agent' | 'seed' | 'import';
  updatedAt: string;
};

export function balanceMinorOf(invoice: InvoiceDoc): number {
  return Math.max(0, Number(invoice.totalMinor ?? 0) - Number(invoice.paidMinor ?? 0) - Number(invoice.creditedMinor ?? 0));
}

export function invoiceById(orgId: string, id: string): InvoiceDoc | undefined {
  const row = get<InvoiceDoc>('invoices', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function invoiceByNumber(orgId: string, number: string): InvoiceDoc | undefined {
  const wanted = String(number ?? '').trim().toLowerCase();
  return list<InvoiceDoc>('invoices', (i) => i.orgId === orgId).find((i) => String(i.number ?? '').toLowerCase() === wanted);
}

export function invoicesFor(orgId: string, opts: { clientId?: string; bookingId?: string; status?: string; from?: string; to?: string; includeDrafts?: boolean; includeVoid?: boolean } = {}): InvoiceDoc[] {
  return list<InvoiceDoc>('invoices', (i) => {
    if (i.orgId !== orgId) return false;
    if (opts.clientId && i.clientId !== opts.clientId) return false;
    if (opts.bookingId && !(i.bookingIds ?? []).includes(opts.bookingId)) return false;
    if (opts.status && i.status !== opts.status) return false;
    if (!opts.includeDrafts && !opts.status && i.status === 'draft') return false;
    if (!opts.includeVoid && !opts.status && i.status === 'void') return false;
    if (opts.status && !['draft', 'issued', 'partly_paid', 'paid', 'overdue', 'void'].includes(opts.status)) return false;
    const when = String(i.issueDate ?? i.createdAt ?? '').slice(0, 10);
    if (opts.from && when < opts.from) return false;
    if (opts.to && when > opts.to) return false;
    return true;
  }).sort((a, b) => String(b.issueDate ?? b.createdAt).localeCompare(String(a.issueDate ?? a.createdAt)));
}

/* ------------------------------------------------------------------- numbering */

/** Monotonic per workspace, so a void invoice never frees its number for reuse. */
function nextNumber(orgId: string, kind: 'invoice' | 'credit'): string {
  const settings = moneySettingsFor(orgId);
  const id = `counter_${kind}_${orgId}`;
  const row = get<Doc & { value?: number }>('counters', id);
  const value = Number(row?.value ?? 0) + 1;
  if (row) update<Doc>('counters', id, { value } as never);
  else insert<Doc>('counters', { id, orgId, kind, value, createdAt: nowIso() } as never);
  const prefix = kind === 'credit' ? 'CR' : settings.invoicePrefix;
  return `${prefix}-${String(value).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------- arithmetic */

/**
 * Splits `total` across `weights` so the parts sum to exactly `total`.
 *
 * Largest-remainder, in integers: the classic way a discount or a rounding crumb
 * gets distributed without the last line quietly absorbing everything. A cent may
 * not disappear between the lines and the invoice.
 */
/**
 * The largest-remainder split, exported so every screen that spreads money
 * across rows splits it the same way the invoice engine does. Rounding each
 * share on its own is how a report ends up a cent away from the ledger it is
 * reporting on.
 */
export function splitExact(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const target = Math.round(total);
  const raw = weights.map((w) => (target * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = target - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const out = [...floors];
  for (const { idx } of order) {
    if (remainder <= 0) break;
    out[idx] += 1;
    remainder -= 1;
  }
  return out;
}

export type LineInput = {
  description?: string;
  qty?: number;
  unitAmount?: number | string;
  unitAmountMinor?: number;
  taxRatePct?: number;
  code?: string;
  serviceId?: string;
  bookingId?: string;
  providerId?: string;
};

function buildLines(input: LineInput[], settings: MoneySettings, discountPct: number): InvoiceLine[] {
  const drafts = input.map((line) => {
    const qty = Number.isFinite(Number(line.qty)) && Number(line.qty) > 0 ? Number(line.qty) : 1;
    const unit =
      line.unitAmountMinor !== undefined
        ? Math.round(Number(line.unitAmountMinor))
        : toMinor(line.unitAmount ?? 0, settings.currency);
    const taxRatePct = Math.min(100, Math.max(0, Number(line.taxRatePct ?? settings.defaultTaxRatePct) || 0));
    const grossBefore = Math.round(qty * unit);
    return {
      id: newId('line_'),
      description: String(line.description ?? 'Item').trim() || 'Item',
      qty,
      unitAmountMinor: unit,
      taxRatePct,
      code: line.code,
      serviceId: line.serviceId,
      bookingId: line.bookingId,
      providerId: line.providerId,
      grossBefore,
    };
  });

  // The discount is spread across lines before tax, proportionally by line value
  // and to the cent — so each line's tax is charged on what is actually being paid.
  const discountTotal = discountPct > 0 ? Math.round((drafts.reduce((a, l) => a + l.grossBefore, 0) * discountPct) / 100) : 0;
  const shares = splitExact(discountTotal, drafts.map((l) => l.grossBefore));

  return drafts.map((line, idx) => {
    const discountMinor = shares[idx];
    const grossBefore = line.grossBefore - discountMinor;
    let netMinor: number;
    let taxMinor: number;
    if (settings.taxMode === 'inclusive') {
      // The quoted price already contains the tax: take it back out.
      taxMinor = Math.round((grossBefore * line.taxRatePct) / (100 + line.taxRatePct || 1));
      netMinor = grossBefore - taxMinor;
    } else {
      netMinor = grossBefore;
      taxMinor = Math.round((grossBefore * line.taxRatePct) / 100);
    }
    return {
      id: line.id,
      description: line.description,
      qty: line.qty,
      unitAmountMinor: line.unitAmountMinor,
      taxRatePct: line.taxRatePct,
      netMinor,
      discountMinor,
      taxMinor,
      grossMinor: netMinor + taxMinor,
      code: line.code,
      serviceId: line.serviceId,
      bookingId: line.bookingId,
      providerId: line.providerId,
    };
  });
}

function totalsOf(lines: InvoiceLine[], discountPct: number, settings: MoneySettings) {
  const subtotalMinor = lines.reduce((a, l) => a + Math.round(l.qty * l.unitAmountMinor), 0);
  const discountMinor = discountPct > 0 ? lines.reduce((a, l) => a + l.discountMinor, 0) : 0;
  const taxMinor = lines.reduce((a, l) => a + l.taxMinor, 0);
  const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
  // Total = what the lines come to after discount, plus their tax. Because every
  // part is an integer, the invoice total is exactly the sum of its lines.
  const totalMinor = netMinor + taxMinor;
  return { subtotalMinor, discountMinor, taxMinor, totalMinor };
}

/* ------------------------------------------------------------------- lifecycle */

export type MoneyWrite<T> = { ok: true; value: T } | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'IMMUTABLE'; error: string; detail?: string };

export function createInvoice(input: {
  orgId: string;
  clientId: string;
  lines: LineInput[];
  bookingIds?: string[];
  discountPct?: number;
  notes?: string;
  source?: InvoiceDoc['source'];
  actor: string;
  actorName?: string;
  currency?: string;
}): MoneyWrite<InvoiceDoc> {
  const client = clientById(input.orgId, input.clientId);
  if (!client) return { ok: false, code: 'NOT_FOUND', error: 'An invoice belongs to a client record, and that client is not in this workspace.' };
  const settings = moneySettingsFor(input.orgId);
  const currency = (input.currency ?? settings.currency).toUpperCase();
  if (!input.lines?.length) return { ok: false, code: 'VALIDATION_ERROR', error: 'An invoice needs at least one line.' };
  const discountPct = Math.min(100, Math.max(0, Number(input.discountPct ?? 0) || 0));
  const lines = buildLines(input.lines, { ...settings, currency }, discountPct);
  const totals = totalsOf(lines, discountPct, settings);

  const invoice = insert<InvoiceDoc>('invoices', {
    id: newId('inv_'),
    orgId: input.orgId,
    kind: 'invoice',
    status: 'draft',
    clientId: client.id,
    clientName: client.name,
    bookingIds: input.bookingIds ?? [],
    currency,
    lines,
    discountPct: discountPct || undefined,
    ...totals,
    paidMinor: 0,
    creditedMinor: 0,
    taxMode: settings.taxMode,
    notes: input.notes,
    footer: settings.footer,
    createdBy: input.actor,
    createdByName: input.actorName,
    source: input.source ?? 'manual',
    updatedAt: nowIso(),
  } as InvoiceDoc);

  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.created', target: invoice.id, detail: `${client.name} — ${formatMoney(totals.totalMinor, currency)} draft` });
  recordAccess({
    orgId: input.orgId,
    resource: 'invoice',
    resourceId: invoice.id,
    action: 'create',
    actor: input.actor,
    actorName: input.actorName,
    detail: `draft, ${formatMoney(totals.totalMinor, currency)}`,
  });
  return { ok: true, value: invoice };
}

/** Bills an appointment: the service's price and tax rate, the visit's provider. */
export function invoiceFromBooking(input: {
  orgId: string;
  bookingId: string;
  actor: string;
  actorName?: string;
  /** Skip the duplicate check when a caller genuinely wants a second invoice. */
  allowExisting?: boolean;
}): MoneyWrite<InvoiceDoc> {
  const booking = bookingById(input.orgId, input.bookingId);
  if (!booking) return { ok: false, code: 'NOT_FOUND', error: `No appointment with id ${input.bookingId}.` };
  const clientId = String((booking as { clientId?: string }).clientId ?? '');
  if (!clientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'That appointment has no client record, so there is nobody to invoice.' };
  if (!input.allowExisting) {
    const existing = invoicesFor(input.orgId, { bookingId: booking.id, includeDrafts: true }).filter((i) => i.kind === 'invoice' && i.status !== 'void');
    if (existing.length) {
      return { ok: false, code: 'CONFLICT', error: `${booking.customer?.name ?? 'That appointment'} already has invoice ${existing[0].number ?? '(draft)'}.`, detail: existing[0].id };
    }
  }
  const service = booking.serviceId ? serviceById(input.orgId, String(booking.serviceId)) : undefined;
  const settings = moneySettingsFor(input.orgId);
  const price = Number(booking.value ?? service?.price ?? 0);
  const line: LineInput = {
    description: service?.name ? `${service.name} — ${new Date(String(booking.startsAt)).toISOString().slice(0, 10)}` : String(booking.service ?? 'Appointment'),
    qty: 1,
    unitAmountMinor: toMinor(price, settings.currency),
    taxRatePct: Number(service?.taxRatePct ?? settings.defaultTaxRatePct) || 0,
    code: service?.code,
    serviceId: service?.id,
    bookingId: booking.id,
    providerId: booking.providerId ? String(booking.providerId) : undefined,
  };
  const created = createInvoice({
    orgId: input.orgId,
    clientId,
    lines: [line],
    bookingIds: [booking.id],
    source: 'booking',
    actor: input.actor,
    actorName: input.actorName,
  });
  if (!created.ok) return created;
  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.from_booking', target: created.value.id, detail: `appointment ${booking.externalId}` });
  return created;
}

/** Drafts only. An issued invoice is corrected with a credit note, never edited. */
export function updateInvoice(input: {
  orgId: string;
  id: string;
  patch: { lines?: LineInput[]; discountPct?: number; notes?: string; bookingIds?: string[] };
  actor: string;
  actorName?: string;
}): MoneyWrite<InvoiceDoc> {
  const invoice = invoiceById(input.orgId, input.id);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  if (invoice.status === 'void') return { ok: false, code: 'IMMUTABLE', error: 'This invoice is void. Void is final — issue a new one.', detail: 'void' };
  if (invoice.status !== 'draft') {
    return {
      ok: false,
      code: 'IMMUTABLE',
      error: `Invoice ${invoice.number} has been issued. An issued invoice is a document: raise a credit note for what is wrong, or void it and reissue.`,
      detail: 'issued',
    };
  }
  const settings = moneySettingsFor(input.orgId);
  const discountPct = input.patch.discountPct !== undefined ? Math.min(100, Math.max(0, Number(input.patch.discountPct) || 0)) : Number(invoice.discountPct ?? 0);
  const lines = input.patch.lines ? buildLines(input.patch.lines, { ...settings, currency: invoice.currency }, discountPct) : (invoice.lines as InvoiceLine[]);
  const totals = totalsOf(lines, discountPct, settings);
  const next = update<InvoiceDoc>('invoices', invoice.id, {
    lines,
    discountPct: discountPct || undefined,
    ...totals,
    notes: input.patch.notes !== undefined ? input.patch.notes : invoice.notes,
    bookingIds: input.patch.bookingIds ?? invoice.bookingIds,
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.edited', target: invoice.id, detail: `${formatMoney(totals.totalMinor, invoice.currency)} draft` });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: 'draft updated' });
  return { ok: true, value: next };
}

/** Numbers it, dates it, and makes it a document. */
export function issueInvoice(input: { orgId: string; id: string; issueDate?: string; actor: string; actorName?: string }): MoneyWrite<InvoiceDoc> {
  const invoice = invoiceById(input.orgId, input.id);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  if (invoice.status === 'void') return { ok: false, code: 'IMMUTABLE', error: 'This invoice is void.', detail: 'void' };
  if (invoice.number) return { ok: false, code: 'CONFLICT', error: `Invoice ${invoice.number} is already issued.`, detail: 'issued' };
  if (!(invoice.lines as InvoiceLine[]).length) return { ok: false, code: 'VALIDATION_ERROR', error: 'An invoice with no lines cannot be issued.' };
  const settings = moneySettingsFor(input.orgId);
  const issueDate = (input.issueDate ?? nowIso()).slice(0, 10);
  const dueDate = new Date(new Date(`${issueDate}T00:00:00Z`).getTime() + settings.termsDays * 86_400_000).toISOString().slice(0, 10);
  const number = nextNumber(input.orgId, invoice.kind);
  const next = update<InvoiceDoc>('invoices', invoice.id, {
    number,
    status: 'issued',
    issueDate,
    dueDate,
    issuedAt: nowIso(),
    footer: settings.footer ?? invoice.footer,
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.issued', target: invoice.id, detail: `${number} — ${formatMoney(next.totalMinor, next.currency)} due ${dueDate}` });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `issued as ${number}` });
  return { ok: true, value: next };
}

/** Voids an unpaid invoice. Money already taken must be dealt with first. */
export function voidInvoice(input: { orgId: string; id: string; reason: string; actor: string; actorName?: string }): MoneyWrite<InvoiceDoc> {
  const invoice = invoiceById(input.orgId, input.id);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  if (invoice.status === 'void') return { ok: false, code: 'CONFLICT', error: 'This invoice is already void.' };
  const paid = Number(invoice.paidMinor ?? 0);
  if (paid > 0) {
    return {
      ok: false,
      code: 'CONFLICT',
      error: `${formatMoney(paid, invoice.currency)} has been paid against this invoice. Refund it (or credit the account) first, then void it.`,
      detail: 'has_payments',
    };
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'Voiding an invoice needs a reason — it stays on the record either way.' };
  const next = update<InvoiceDoc>('invoices', invoice.id, { status: 'void', voidedAt: nowIso(), voidReason: reason, updatedAt: nowIso() });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.voided', target: invoice.id, detail: `${invoice.number ?? 'draft'} — ${reason}` });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `voided: ${reason}` });
  // A voided document must not be chased. Whatever the reason, the practice has
  // said out loud that this bill no longer stands.
  cancelPendingChases(input.orgId, invoice.id, 'the invoice was voided');
  return { ok: true, value: next };
}

/**
 * Credits an invoice — the honest way to reduce a document that has been issued.
 *
 * A credit note is a document in its own right (`CR-0001`), allocated against the
 * invoice it corrects, and it moves the balance without pretending the original
 * was never written. The full amount or part of it.
 */
export function creditInvoice(input: {
  orgId: string;
  id: string;
  amount?: number | string;
  amountMinor?: number;
  reason: string;
  actor: string;
  actorName?: string;
}): MoneyWrite<{ invoice: InvoiceDoc; credit: InvoiceDoc }> {
  const invoice = invoiceById(input.orgId, input.id);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  if (invoice.status === 'void' || invoice.status === 'draft') {
    return { ok: false, code: 'CONFLICT', error: invoice.status === 'draft' ? 'A draft is edited, not credited. Issue it first, or change the lines.' : 'A void invoice needs no credit note.' };
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'A credit note needs a reason.' };
  const open = balanceMinorOf(invoice);
  const amountMinor =
    input.amountMinor !== undefined
      ? Math.round(Number(input.amountMinor))
      : input.amount !== undefined
        ? toMinor(input.amount, invoice.currency)
        : open;
  if (amountMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'A credit note is for a positive amount.' };
  if (amountMinor > open) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `There is only ${formatMoney(open, invoice.currency)} left on ${invoice.number} — a credit note cannot be for more than that.`,
      detail: String(open),
    };
  }

  const number = nextNumber(input.orgId, 'credit');
  const credit = insert<InvoiceDoc>('invoices', {
    id: newId('inv_'),
    orgId: input.orgId,
    kind: 'credit',
    status: 'issued',
    number,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    bookingIds: invoice.bookingIds,
    currency: invoice.currency,
    lines: [
      {
        id: newId('line_'),
        description: `Credit note against ${invoice.number} — ${reason}`,
        qty: 1,
        unitAmountMinor: -amountMinor,
        taxRatePct: 0,
        netMinor: -amountMinor,
        discountMinor: 0,
        taxMinor: 0,
        grossMinor: -amountMinor,
      },
    ],
    subtotalMinor: -amountMinor,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: -amountMinor,
    paidMinor: 0,
    creditedMinor: 0,
    taxMode: invoice.taxMode,
    issueDate: nowIso().slice(0, 10),
    dueDate: nowIso().slice(0, 10),
    issuedAt: nowIso(),
    creditedInvoiceId: invoice.id,
    notes: reason,
    createdBy: input.actor,
    createdByName: input.actorName,
    source: 'manual',
    updatedAt: nowIso(),
  } as InvoiceDoc);

  const credited = Number(invoice.creditedMinor ?? 0) + amountMinor;
  const next = update<InvoiceDoc>('invoices', invoice.id, { creditedMinor: credited, updatedAt: nowIso() });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.id}.` };
  recomputeStatus(next);
  // The bill just got smaller. A chase carrying the old figure is worse than no
  // chase at all, so an unsent one is taken back — see `queueOverdueChases`, which
  // re-queues the step with tonight's number on its next pass.
  cancelPendingChases(input.orgId, invoice.id, `a credit note of ${formatMoney(amountMinor, invoice.currency)} was applied`);
  audit({ orgId: input.orgId, actor: input.actor, action: 'invoice.credited', target: invoice.id, detail: `${number} for ${formatMoney(amountMinor, invoice.currency)} — ${reason}` });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `credited ${formatMoney(amountMinor, invoice.currency)} (${number})` });
  return { ok: true, value: { invoice: invoiceById(input.orgId, invoice.id)!, credit } };
}

/* -------------------------------------------------------------------- payments */

export type PaymentKind = 'payment' | 'prepayment' | 'refund' | 'credit';
export type PaymentMethod = 'card' | 'cash' | 'bank_transfer' | 'voucher' | 'account_credit' | 'other';

export type Allocation = { invoiceId: string; amountMinor: number; at: string };

export type PaymentDoc = Doc & {
  orgId: string;
  clientId: string;
  clientName?: string;
  kind: PaymentKind;
  method: PaymentMethod;
  /** `in` = money arrived, `out` = money left (a refund). */
  direction: 'in' | 'out';
  amountMinor: number;
  currency: string;
  at: string;
  status: 'settled' | 'void';
  allocations: Allocation[];
  unallocatedMinor: number;
  reference?: string;
  note?: string;
  providerRef?: string;
  /** For a refund: the payment it gives back. */
  refundOfPaymentId?: string;
  /**
   * The class pack this money belongs to, when it does. Pack prepayments are
   * fenced: ordinary on-account credit never touches them, and a pack place is
   * settled only from its own pack's money (`applyCredit` with `packId`).
   */
  packId?: string;
  source: 'desk' | 'online' | 'agent' | 'webhook' | 'seed' | 'api';
  recordedBy: string;
  recordedByName?: string;
  voidedAt?: string;
  voidReason?: string;
};

export function paymentById(orgId: string, id: string): PaymentDoc | undefined {
  const row = get<PaymentDoc>('payments', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function paymentsFor(orgId: string, opts: { clientId?: string; invoiceId?: string; kind?: string; from?: string; to?: string; includeVoid?: boolean } = {}): PaymentDoc[] {
  return list<PaymentDoc>('payments', (p) => {
    if (p.orgId !== orgId) return false;
    if (opts.clientId && p.clientId !== opts.clientId) return false;
    if (opts.kind && p.kind !== opts.kind) return false;
    if (opts.invoiceId && !p.allocations.some((a) => a.invoiceId === opts.invoiceId)) return false;
    if (!opts.includeVoid && p.status === 'void') return false;
    const when = String(p.at ?? '').slice(0, 10);
    if (opts.from && when < opts.from) return false;
    if (opts.to && when > opts.to) return false;
    return true;
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** The client's unallocated money-in — what they can spend on a future invoice. */
export function creditOnAccountMinor(orgId: string, clientId: string): number {
  return paymentsFor(orgId, { clientId })
    .filter((p) => p.status === 'settled' && p.direction === 'in')
    .reduce((sum, p) => sum + Number(p.unallocatedMinor ?? 0), 0);
}

function recomputeStatus(invoice: InvoiceDoc): InvoiceDoc | undefined {
  if (invoice.status === 'void' || invoice.status === 'draft') return invoice;
  const paid = Number(invoice.paidMinor ?? 0);
  const credited = Number(invoice.creditedMinor ?? 0);
  const settled = paid + credited >= Number(invoice.totalMinor ?? 0);
  const overdue = Boolean(invoice.dueDate) && Number(invoice.dueDate!.replace(/-/g, '')) < Number(nowIso().slice(0, 10).replace(/-/g, ''));
  const status: InvoiceStatus = settled ? 'paid' : paid + credited > 0 ? 'partly_paid' : overdue ? 'overdue' : 'issued';
  return update<InvoiceDoc>('invoices', invoice.id, { status, updatedAt: nowIso() });
}

/** Re-derives every touched invoice from its payments. The ledger is the truth. */
function resyncInvoice(orgId: string, invoiceId: string) {
  const invoice = invoiceById(orgId, invoiceId);
  if (!invoice || invoice.kind === 'credit') return;
  const settled = paymentsFor(orgId, { invoiceId }).filter((p) => p.status === 'settled');
  const onInvoice = (p: PaymentDoc) => p.allocations.filter((a) => a.invoiceId === invoiceId).reduce((s, a) => s + a.amountMinor, 0);
  const taken = settled.filter((p) => p.direction === 'in').reduce((sum, p) => sum + onInvoice(p), 0);
  const refunded = settled.filter((p) => p.direction === 'out').reduce((sum, p) => sum + onInvoice(p), 0);
  // Net of refunds: refunding money from an invoice puts that part of it back on
  // the invoice, which is the whole point of refunding it *from* the invoice.
  const paid = Math.max(0, taken - refunded);
  const next = update<InvoiceDoc>('invoices', invoiceId, { paidMinor: paid, updatedAt: nowIso() });
  if (next) recomputeStatus(next);
}

export function recordPayment(input: {
  orgId: string;
  clientId?: string;
  invoiceId?: string;
  kind?: PaymentKind;
  method?: PaymentMethod | string;
  amount?: number | string;
  amountMinor?: number;
  reference?: string;
  note?: string;
  at?: string;
  providerRef?: string;
  refundOfPaymentId?: string;
  /** The class pack this prepayment funds, when it does. Fences the money (see `PaymentDoc.packId`). */
  packId?: string;
  /** Explicit allocations. Omit to settle the client's oldest open invoices first. */
  allocations?: { invoiceId: string; amountMinor?: number; amount?: number | string }[];
  source?: PaymentDoc['source'];
  actor: string;
  actorName?: string;
}): MoneyWrite<PaymentDoc> {
  const kind: PaymentKind = input.kind ?? 'payment';
  const direction: 'in' | 'out' = kind === 'refund' ? 'out' : 'in';
  const explicitInvoice = input.invoiceId ? invoiceById(input.orgId, input.invoiceId) : undefined;
  if (input.invoiceId && !explicitInvoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.invoiceId}.` };
  // Money cannot settle a document that does not exist yet. A draft has no number
  // and was never sent, and a void bill has been withdrawn: taking a payment
  // against either leaves the ledger holding money no report can place, which is
  // how "collected" stops adding up to the rows underneath it. `createPaymentLink`
  // has refused both from the start; the payment path now agrees with it.
  if (explicitInvoice && (explicitInvoice.status === 'draft' || explicitInvoice.status === 'void')) {
    return {
      ok: false,
      code: 'CONFLICT',
      error:
        explicitInvoice.status === 'draft'
          ? `${explicitInvoice.number ?? 'That invoice'} is still a draft — issue it before taking money against it, or take the money on account.`
          : 'That invoice is void; nothing can be paid against it.',
      detail: explicitInvoice.status,
    };
  }
  const clientId = String(input.clientId ?? explicitInvoice?.clientId ?? '');
  if (!clientId) return { ok: false, code: 'VALIDATION_ERROR', error: 'A payment belongs to a client — send `clientId` or `invoiceId`.' };
  const client = clientById(input.orgId, clientId);
  if (!client) return { ok: false, code: 'NOT_FOUND', error: 'That client is not in this workspace.' };
  const settings = moneySettingsFor(input.orgId);
  const currency = explicitInvoice?.currency ?? settings.currency;
  let amountMinor =
    input.amountMinor !== undefined
      ? Math.round(Number(input.amountMinor))
      : input.amount !== undefined
        ? toMinor(input.amount, currency)
        : 0;
  // "Take the payment for this invoice" is what a desk actually says, so naming
  // an invoice (or allocating to one) without a figure means *settle what is
  // owed* — bounded by the open balances, never a blank cheque. A refund always
  // has to state its own amount, and an explicit figure always wins.
  if (amountMinor === 0 && kind === 'payment') {
    const stated = input.allocations?.filter((a) => a.amountMinor !== undefined || a.amount !== undefined) ?? [];
    if (input.allocations?.length && stated.length === input.allocations.length) {
      amountMinor = stated.reduce(
        (sum, a) => sum + (a.amountMinor !== undefined ? Math.round(Number(a.amountMinor)) : toMinor(a.amount as string | number, currency)),
        0
      );
    } else {
      const scope = explicitInvoice ? [explicitInvoice] : invoicesFor(input.orgId, { clientId });
      amountMinor = scope
        .filter((i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(i.status))
        .reduce((sum, i) => sum + Math.max(0, balanceMinorOf(i)), 0);
    }
  }
  if (amountMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'A payment is for a positive amount.' };

  // A refund may not give back more than was taken against this invoice (or, for a
  // client-level refund, more than the client still holds as settled credits).
  if (kind === 'refund') {
    const cap = explicitInvoice
      ? Number(explicitInvoice.paidMinor ?? 0)
      : paymentsFor(input.orgId, { clientId })
          .filter((p) => p.status === 'settled')
          .reduce((s, p) => s + (p.direction === 'in' ? p.amountMinor : -p.amountMinor), 0);
    if (amountMinor > cap) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        error: explicitInvoice
          ? `Only ${formatMoney(cap, currency)} has been paid against ${explicitInvoice.number ?? 'this invoice'} — a refund cannot exceed it.`
          : `There is only ${formatMoney(cap, currency)} of settled money on this account to refund.`,
        detail: String(cap),
      };
    }
  }

  // Where does this money land? A payment with no allocations is applied to the
  // client's open invoices oldest-first; anything left over stays on account.
  const targets: { invoiceId: string; amountMinor: number }[] = [];
  if (kind === 'refund') {
    // Money going back out of a named invoice re-opens exactly that invoice. A
    // refund of loose credit on the account (no invoice named) stays client-level,
    // because there is no document to reopen.
    const back = input.allocations?.length
      ? input.allocations.map((a) => ({
          invoiceId: String(a.invoiceId ?? ''),
          amountMinor: a.amountMinor !== undefined ? Math.round(Number(a.amountMinor)) : a.amount !== undefined ? toMinor(a.amount as string | number, currency) : amountMinor,
        }))
      : explicitInvoice
        ? [{ invoiceId: explicitInvoice.id, amountMinor }]
        : [];
    let left = amountMinor;
    for (const want of back) {
      if (left <= 0) break;
      const invoice = invoiceById(input.orgId, want.invoiceId);
      if (!invoice || invoice.clientId !== clientId) {
        return { ok: false, code: 'VALIDATION_ERROR', error: `Invoice ${want.invoiceId} is not this client's, or does not exist.`, detail: 'bad_allocation' };
      }
      const take = Math.min(left, want.amountMinor);
      if (take <= 0) continue;
      targets.push({ invoiceId: invoice.id, amountMinor: take });
      left -= take;
    }
  }
  if (direction === 'in' && kind !== 'prepayment') {
    const requested =
      input.allocations?.length
        ? input.allocations.map((a) => ({
            invoiceId: String(a.invoiceId ?? ''),
            amountMinor: a.amountMinor !== undefined ? Math.round(Number(a.amountMinor)) : a.amount !== undefined ? toMinor(a.amount, currency) : undefined,
          }))
        : explicitInvoice
          ? [{ invoiceId: explicitInvoice.id, amountMinor: undefined }]
          : invoicesFor(input.orgId, { clientId })
              .filter((i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(i.status) && balanceMinorOf(i) > 0)
              .map((i) => ({ invoiceId: i.id, amountMinor: undefined }));
    let left = amountMinor;
    for (const want of requested) {
      if (left <= 0) break;
      const invoice = invoiceById(input.orgId, want.invoiceId);
      if (!invoice || invoice.clientId !== clientId) {
        return { ok: false, code: 'VALIDATION_ERROR', error: `Invoice ${want.invoiceId} is not this client's, or does not exist.`, detail: 'bad_allocation' };
      }
      const open = balanceMinorOf(invoice);
      const take = Math.min(left, open, want.amountMinor ?? open);
      if (take <= 0) continue;
      targets.push({ invoiceId: invoice.id, amountMinor: take });
      left -= take;
    }
  }

  const allocations: Allocation[] = targets.map((t) => ({ invoiceId: t.invoiceId, amountMinor: t.amountMinor, at: nowIso() }));
  const allocated = allocations.reduce((s, a) => s + a.amountMinor, 0);
  const payment = insert<PaymentDoc>('payments', {
    id: newId('pay_'),
    orgId: input.orgId,
    clientId,
    clientName: client.name,
    kind,
    method: normaliseMethod(input.method),
    direction,
    amountMinor,
    currency,
    at: input.at ?? nowIso(),
    status: 'settled',
    allocations,
    unallocatedMinor: direction === 'in' ? amountMinor - allocated : 0,
    reference: input.reference,
    note: input.note,
    providerRef: input.providerRef,
    refundOfPaymentId: input.refundOfPaymentId,
    packId: input.packId,
    source: input.source ?? 'desk',
    recordedBy: input.actor,
    recordedByName: input.actorName,
  } as PaymentDoc);

  for (const allocation of allocations) resyncInvoice(input.orgId, allocation.invoiceId);

  const label = kind === 'refund' ? 'refunded' : kind === 'prepayment' ? 'taken as a prepayment' : kind === 'credit' ? 'credited' : 'received';
  const detail = `${formatMoney(amountMinor, currency)} ${label} for ${client.name}${allocations.length ? ` — ${allocations.length} invoice(s)` : ' — left on account'}`;
  audit({ orgId: input.orgId, actor: input.actor, action: `payment.${kind}`, target: payment.id, detail });
  // …and against each invoice it settled, so opening an invoice shows the money
  // that came in on it rather than an id nobody can follow.
  for (const allocation of allocations) {
    const invoice = invoiceById(input.orgId, allocation.invoiceId);
    audit({
      orgId: input.orgId,
      actor: input.actor,
      action: `payment.${kind}`,
      target: allocation.invoiceId,
      detail: `${formatMoney(allocation.amountMinor, currency)} ${label} on ${invoice?.number ?? allocation.invoiceId} (${payment.method}) — payment ${payment.id}`,
    });
  }
  recordAccess({
    orgId: input.orgId,
    resource: 'invoice',
    resourceId: allocations[0]?.invoiceId ?? `client:${clientId}`,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: `${formatMoney(amountMinor, currency)} ${label} (${payment.method})`,
  });

  /**
   * What the client hears, and what they stop hearing.
   *
   * This is the one place every payment arrives at — the desk, the sandbox pay
   * page, the Stripe webhook — so it is the one place a receipt can be written
   * exactly once and a queued chase taken back exactly once. Both jobs go to
   * `receipts.ts`, which owns the words and none of the arithmetic.
   *
   * A refund *does* earn a message (the client is watching their bank for it);
   * applying credit does not (that money was already acknowledged when it was
   * paid). `queuePaymentNotice` decides, so the rule is in one place.
   */
  const touched = allocations.map((a) => invoiceById(input.orgId, a.invoiceId)).filter(Boolean) as InvoiceDoc[];
  if (touched.length) {
    for (const invoice of touched) {
      const stillOwed = balanceMinorOf(invoice);
      cancelPendingChases(input.orgId, invoice.id, stillOwed > 0 ? `part paid — ${formatMoney(stillOwed, currency)} still due` : 'settled in full');
    }
  }
  queuePaymentNotice({
    orgId: input.orgId,
    clientId,
    clientName: client.name,
    paymentId: payment.id,
    kind,
    amountMinor,
    currency,
    method: String(payment.method),
    invoices: touched.map((invoice) => ({ id: invoice.id, number: invoice.number, balanceMinor: balanceMinorOf(invoice) })),
    unallocatedMinor: payment.unallocatedMinor,
  });

  return { ok: true, value: payment };
}

function normaliseMethod(input?: string): PaymentMethod {
  const wanted = String(input ?? 'cash').trim().toLowerCase().replace(/[^a-z]/g, '');
  const map: Record<string, PaymentMethod> = {
    card: 'card',
    creditcard: 'card',
    stripe: 'card',
    cash: 'cash',
    banktransfer: 'bank_transfer',
    transfer: 'bank_transfer',
    bank: 'bank_transfer',
    directdebit: 'bank_transfer',
    voucher: 'voucher',
    accountcredit: 'account_credit',
    credit: 'account_credit',
    other: 'other',
  };
  return map[wanted] ?? 'other';
}

/** Spends money already on the account against an invoice. */
export function applyCredit(input: { orgId: string; clientId: string; invoiceId: string; amount?: number | string; amountMinor?: number; actor: string; actorName?: string; packId?: string }): MoneyWrite<PaymentDoc> {
  const invoice = invoiceById(input.orgId, input.invoiceId);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.invoiceId}.` };
  if (invoice.status === 'void') return { ok: false, code: 'CONFLICT', error: 'That invoice is void.' };
  const currency = invoice.currency;
  const open = balanceMinorOf(invoice);
  const amountMinor = input.amountMinor !== undefined ? Math.round(Number(input.amountMinor)) : input.amount !== undefined ? toMinor(input.amount, currency) : Math.min(open, creditOnAccountMinor(input.orgId, input.clientId));
  if (amountMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'There is nothing on account to apply.' };

  // Take it from the oldest unallocated money-in rows first. Class-pack money
  // is fenced both ways: a pack place settles only from its own pack's
  // prepayment, and ordinary credit applications never spend pack money —
  // otherwise the desk could settle an unrelated invoice with places the
  // client already paid for as classes.
  const pool = paymentsFor(input.orgId, { clientId: input.clientId })
    .filter((p) => p.status === 'settled' && p.direction === 'in' && Number(p.unallocatedMinor ?? 0) > 0)
    .filter((p) => (input.packId ? p.packId === input.packId : !p.packId))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const available = pool.reduce((s, p) => s + p.unallocatedMinor, 0);
  if (amountMinor > available) {
    return { ok: false, code: 'VALIDATION_ERROR', error: `Only ${formatMoney(available, currency)} is on account.`, detail: String(available) };
  }
  if (amountMinor > open) {
    return { ok: false, code: 'VALIDATION_ERROR', error: `${invoice.number} only has ${formatMoney(open, currency)} left on it.`, detail: String(open) };
  }

  let left = amountMinor;
  let last: PaymentDoc | undefined;
  for (const row of pool) {
    if (left <= 0) break;
    const take = Math.min(left, row.unallocatedMinor);
    last = update<PaymentDoc>('payments', row.id, {
      allocations: [...row.allocations, { invoiceId: invoice.id, amountMinor: take, at: nowIso() }],
      unallocatedMinor: row.unallocatedMinor - take,
    });
    left -= take;
  }
  resyncInvoice(input.orgId, invoice.id);
  // Money that was already paid, moved onto this bill. The client heard about it
  // when it was taken (that is what the receipt was for) — but the *chase* for
  // this invoice, if one is waiting, now quotes a figure that is too high.
  cancelPendingChases(input.orgId, invoice.id, 'credit was applied to the invoice');
  audit({ orgId: input.orgId, actor: input.actor, action: 'payment.credit_applied', target: invoice.id, detail: `${formatMoney(amountMinor, currency)} on account applied to ${invoice.number}` });
  recordAccess({ orgId: input.orgId, resource: 'invoice', resourceId: invoice.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `credit applied ${formatMoney(amountMinor, currency)}` });
  return { ok: true, value: last! };
}

/**
 * Un-settles a pack place: the mirror of `applyCredit` with a `packId`.
 *
 * A place that was spent and then un-happens (the register mark is undone, the
 * practice cancels the class after the register ran) must give the place back
 * to the pack — which means the money has to travel back too: the allocation
 * comes off the pack's prepayment, the value returns to its unallocated pool,
 * and the seat's invoice, now unpaid, is voided with the reason. Anything less
 * and the pack's places and the pack's money would disagree.
 */
export function reversePackSettlement(input: { orgId: string; invoiceId: string; packId: string; reason: string; actor: string; actorName?: string }): MoneyWrite<InvoiceDoc> {
  const invoice = invoiceById(input.orgId, input.invoiceId);
  if (!invoice) return { ok: false, code: 'NOT_FOUND', error: `No invoice with id ${input.invoiceId}.` };
  if (invoice.status === 'void') return { ok: true, value: invoice };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'Reversing a pack settlement needs a reason.' };

  const rows = paymentsFor(input.orgId, { invoiceId: invoice.id, includeVoid: true }).filter((p) => p.packId === input.packId && p.status === 'settled');
  for (const row of rows) {
    const mine = row.allocations.filter((a) => a.invoiceId === invoice.id);
    if (!mine.length) continue;
    const back = mine.reduce((s, a) => s + a.amountMinor, 0);
    update<PaymentDoc>('payments', row.id, {
      allocations: row.allocations.filter((a) => a.invoiceId !== invoice.id),
      unallocatedMinor: Number(row.unallocatedMinor ?? 0) + back,
    });
  }
  resyncInvoice(input.orgId, invoice.id);
  const voided = voidInvoice({ orgId: input.orgId, id: invoice.id, reason, actor: input.actor, actorName: input.actorName });
  if (!voided.ok) return voided;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.settlement_reversed', target: invoice.id, detail: `${invoice.number ?? invoice.id} — ${reason}` });
  return { ok: true, value: voided.value };
}

/** Voids a payment — a mistake is reversed with a reason, never deleted. */
export function voidPayment(input: { orgId: string; id: string; reason: string; actor: string; actorName?: string }): MoneyWrite<PaymentDoc> {
  const payment = paymentById(input.orgId, input.id);
  if (!payment) return { ok: false, code: 'NOT_FOUND', error: `No payment with id ${input.id}.` };
  if (payment.status === 'void') return { ok: false, code: 'CONFLICT', error: 'That payment is already void.' };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'Voiding a payment needs a reason.' };
  const next = update<PaymentDoc>('payments', payment.id, { status: 'void', voidedAt: nowIso(), voidReason: reason, unallocatedMinor: 0 });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No payment with id ${input.id}.` };
  for (const allocation of payment.allocations ?? []) resyncInvoice(input.orgId, allocation.invoiceId);
  // Reversing a payment re-opens the bill, so a chase taken back when it looked
  // settled is no longer a lie — the next pass of the job queued it again, and the
  // desk can see both the void and the chase in the invoice's history.
  for (const allocation of payment.allocations ?? []) {
    const invoice = invoiceById(input.orgId, allocation.invoiceId);
    if (invoice && balanceMinorOf(invoice) > 0) {
      audit({
        orgId: input.orgId,
        actor: 'system',
        action: 'invoice.reopened',
        target: invoice.id,
        detail: `${invoice.number ?? invoice.id} owes ${formatMoney(balanceMinorOf(invoice), invoice.currency)} again after a payment was voided`,
      });
    }
  }
  audit({ orgId: input.orgId, actor: input.actor, action: 'payment.voided', target: payment.id, detail: `${formatMoney(payment.amountMinor, payment.currency)} — ${reason}` });
  return { ok: true, value: next };
}

/* ------------------------------------------------------------------ statements */

export type LedgerRow = {
  at: string;
  kind: 'invoice' | 'credit_note' | 'payment' | 'prepayment' | 'refund' | 'credit';
  reference: string;
  detail: string;
  chargeMinor: number;
  creditMinor: number;
  balanceMinor: number;
};

export type Statement = {
  clientId: string;
  clientName: string;
  currency: string;
  from?: string;
  to?: string;
  rows: LedgerRow[];
  openingMinor: number;
  closingMinor: number;
  totals: { charges: number; credits: number; payments: number; refunds: number };
  /** What the invoices themselves say is owed right now. Must equal `closingMinor`. */
  outstandingMinor: number;
  creditOnAccountMinor: number;
  reconciled: boolean;
};

/**
 * The client's account, in order, with a running balance.
 *
 * Reconciliation is an assertion, not a hope: `closingMinor` (what the ledger
 * rows say) is compared with `outstandingMinor` (what the invoices themselves
 * say is unpaid, less credit on account). If they disagree, `reconciled` is
 * false — and the gate fails on it rather than printing a number nobody checked.
 */
export function statement(orgId: string, clientId: string, opts: { from?: string; to?: string } = {}): Statement | undefined {
  const client = clientById(orgId, clientId);
  if (!client) return undefined;
  const settings = moneySettingsFor(orgId);
  const invoices = invoicesFor(orgId, { clientId, includeDrafts: false, includeVoid: false });
  const payments = paymentsFor(orgId, { clientId });

  type Event = { at: string; row: Omit<LedgerRow, 'balanceMinor'> };
  const events: Event[] = [];
  for (const invoice of invoices) {
    const at = String(invoice.issueDate ?? invoice.createdAt ?? '');
    if (invoice.kind === 'credit' || Number(invoice.totalMinor) < 0) {
      events.push({
        at,
        row: {
          at,
          kind: 'credit_note',
          reference: invoice.number ?? invoice.id,
          detail: invoice.notes ?? 'Credit note',
          chargeMinor: 0,
          creditMinor: Math.abs(Number(invoice.totalMinor)),
        },
      });
    } else {
      events.push({
        at,
        row: {
          at,
          kind: 'invoice',
          reference: invoice.number ?? '(draft)',
          detail: `${(invoice.lines as InvoiceLine[]).length} line(s)`,
          chargeMinor: Number(invoice.totalMinor),
          creditMinor: 0,
        },
      });
    }
  }
  for (const payment of payments) {
    const at = String(payment.at ?? '').slice(0, 10);
    const label = payment.kind === 'refund' ? 'refund' : payment.kind === 'prepayment' ? 'prepayment' : payment.kind === 'credit' ? 'credit' : 'payment';
    events.push({
      at,
      row: {
        at,
        kind: payment.kind === 'refund' ? 'refund' : (payment.kind as LedgerRow['kind']),
        reference: payment.reference ?? payment.id,
        detail: `${label} — ${payment.method.replace(/_/g, ' ')}${payment.allocations.length ? ` (${payment.allocations.length} invoice${payment.allocations.length === 1 ? '' : 's'})` : ' (on account)'}`,
        chargeMinor: payment.direction === 'out' ? payment.amountMinor : 0,
        creditMinor: payment.direction === 'in' ? payment.amountMinor : 0,
      },
    });
  }

  // Opening balance: everything that happened before the window.
  const before = (when: string) => (opts.from ? when < opts.from : false);
  const openingMinor = events
    .filter((e) => before(e.at))
    .reduce((sum, e) => sum + e.row.chargeMinor - e.row.creditMinor, 0);
  const inWindow = events
    .filter((e) => !before(e.at) && (!opts.to || e.at <= opts.to))
    .sort((a, b) => a.at.localeCompare(b.at) || a.row.reference.localeCompare(b.row.reference));

  let running = openingMinor;
  const rows: LedgerRow[] = inWindow.map((e) => {
    running += e.row.chargeMinor - e.row.creditMinor;
    return { ...e.row, balanceMinor: running };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      charges: acc.charges + (r.kind === 'invoice' ? r.chargeMinor : 0),
      credits: acc.credits + (r.kind === 'credit_note' ? r.creditMinor : 0),
      payments: acc.payments + (r.kind === 'payment' || r.kind === 'prepayment' || r.kind === 'credit' ? r.creditMinor : 0),
      refunds: acc.refunds + (r.kind === 'refund' ? r.chargeMinor : 0),
    }),
    { charges: 0, credits: 0, payments: 0, refunds: 0 }
  );

  const outstanding = invoices.reduce((sum, i) => sum + (i.kind === 'credit' ? 0 : balanceMinorOf(i)), 0);
  const credit = creditOnAccountMinor(orgId, clientId);
  const owedNow = outstanding - credit;
  const ledgerSays = (opts.from || opts.to ? running : events.reduce((sum, e) => sum + e.row.chargeMinor - e.row.creditMinor, 0));

  return {
    clientId,
    clientName: client.name,
    currency: settings.currency,
    from: opts.from,
    to: opts.to,
    rows,
    openingMinor,
    closingMinor: ledgerSays,
    totals,
    outstandingMinor: outstanding,
    creditOnAccountMinor: credit,
    reconciled: ledgerSays === owedNow,
  };
}

/** What this client owes right now, without building the whole ledger. */
export function clientBalance(orgId: string, clientId: string): { dueMinor: number; creditMinor: number; balanceMinor: number; currency: string } {
  const settings = moneySettingsFor(orgId);
  const due = invoicesFor(orgId, { clientId })
    .filter((i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(i.status))
    .reduce((sum, i) => sum + balanceMinorOf(i), 0);
  const credit = creditOnAccountMinor(orgId, clientId);
  return { dueMinor: due, creditMinor: credit, balanceMinor: due - credit, currency: settings.currency };
}

/** Invoices that are overdue by date — used by the maintenance sweep and the desk. */
export function overdueInvoices(orgId: string, now = new Date()): InvoiceDoc[] {
  const today = now.toISOString().slice(0, 10);
  return invoicesFor(orgId, { includeVoid: false }).filter(
    (i) => i.kind === 'invoice' && ['issued', 'partly_paid'].includes(i.status) && Boolean(i.dueDate) && String(i.dueDate) < today
  );
}

/** Moves them to `overdue`. Idempotent; returns how many changed. */
export function refreshOverdue(orgId?: string, now = new Date()): number {
  let changed = 0;
  const orgs = orgId ? [orgId] : Array.from(new Set(list<InvoiceDoc>('invoices', () => true).map((i) => i.orgId)));
  for (const id of orgs) {
    for (const invoice of overdueInvoices(id, now)) {
      update<InvoiceDoc>('invoices', invoice.id, { status: 'overdue', updatedAt: nowIso() });
      changed += 1;
    }
  }
  return changed;
}

/* -------------------------------------------------------------------- expenses */

export const EXPENSE_CATEGORIES = ['rent', 'equipment', 'supplies', 'wages', 'marketing', 'utilities', 'software', 'travel', 'insurance', 'other'] as const;

export type ExpenseDoc = Doc & {
  orgId: string;
  at: string;
  category: (typeof EXPENSE_CATEGORIES)[number];
  supplier?: string;
  description?: string;
  amountMinor: number;
  taxMinor: number;
  currency: string;
  providerId?: string;
  reference?: string;
  status: 'active' | 'void';
  createdBy: string;
  createdByName?: string;
  updatedAt: string;
};

export function expensesFor(orgId: string, opts: { from?: string; to?: string; category?: string; includeVoid?: boolean } = {}): ExpenseDoc[] {
  return list<ExpenseDoc>('expenses', (e) => {
    if (e.orgId !== orgId) return false;
    if (!opts.includeVoid && e.status === 'void') return false;
    if (opts.category && e.category !== opts.category) return false;
    const when = String(e.at).slice(0, 10);
    if (opts.from && when < opts.from) return false;
    if (opts.to && when > opts.to) return false;
    return true;
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function createExpense(input: {
  orgId: string;
  at?: string;
  category?: string;
  supplier?: string;
  description?: string;
  amount?: number | string;
  amountMinor?: number;
  taxMinor?: number;
  providerId?: string;
  reference?: string;
  actor: string;
  actorName?: string;
}): MoneyWrite<ExpenseDoc> {
  const settings = moneySettingsFor(input.orgId);
  const amountMinor = input.amountMinor !== undefined ? Math.round(Number(input.amountMinor)) : toMinor(input.amount ?? 0, settings.currency);
  if (amountMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'An expense is for a positive amount.' };
  const category = (EXPENSE_CATEGORIES as readonly string[]).includes(String(input.category)) ? (input.category as ExpenseDoc['category']) : 'other';
  const expense = insert<ExpenseDoc>('expenses', {
    id: newId('exp_'),
    orgId: input.orgId,
    at: (input.at ?? nowIso()).slice(0, 10),
    category,
    supplier: input.supplier,
    description: input.description,
    amountMinor,
    taxMinor: Math.max(0, Math.round(Number(input.taxMinor ?? 0))),
    currency: settings.currency,
    providerId: input.providerId,
    reference: input.reference,
    status: 'active',
    createdBy: input.actor,
    createdByName: input.actorName,
    updatedAt: nowIso(),
  } as ExpenseDoc);
  audit({ orgId: input.orgId, actor: input.actor, action: 'expense.created', target: expense.id, detail: `${category} ${formatMoney(amountMinor, settings.currency)}${input.supplier ? ` — ${input.supplier}` : ''}` });
  return { ok: true, value: expense };
}

export function updateExpense(input: { orgId: string; id: string; patch: Partial<Pick<ExpenseDoc, 'at' | 'category' | 'supplier' | 'description' | 'amountMinor' | 'taxMinor' | 'providerId' | 'reference'>>; actor: string }): MoneyWrite<ExpenseDoc> {
  const expense = get<ExpenseDoc>('expenses', input.id);
  if (!expense || expense.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: `No expense with id ${input.id}.` };
  if (expense.status === 'void') return { ok: false, code: 'IMMUTABLE', error: 'That expense is void.' };
  const next = update<ExpenseDoc>('expenses', expense.id, { ...input.patch, updatedAt: nowIso() });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No expense with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'expense.edited', target: expense.id, detail: Object.keys(input.patch).join(', ') });
  return { ok: true, value: next };
}

export function voidExpense(input: { orgId: string; id: string; reason: string; actor: string }): MoneyWrite<ExpenseDoc> {
  const expense = get<ExpenseDoc>('expenses', input.id);
  if (!expense || expense.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: `No expense with id ${input.id}.` };
  if (expense.status === 'void') return { ok: false, code: 'CONFLICT', error: 'That expense is already void.' };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'Voiding an expense needs a reason.' };
  const next = update<ExpenseDoc>('expenses', expense.id, { status: 'void', updatedAt: nowIso() });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No expense with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'expense.voided', target: expense.id, detail: reason });
  return { ok: true, value: next };
}

/* -------------------------------------------------------------------- reporting */

export type ProviderRevenue = {
  providerId: string;
  providerName: string;
  invoicedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  appointments: number;
};

/**
 * Who earned what.
 *
 * Attribution is by *line*: an invoice line carries the provider who did the
 * work (from the appointment it was raised against), so a practice with three
 * practitioners can answer "what did Priya bring in" without a second ledger.
 */
export function providerRevenue(orgId: string, opts: { from?: string; to?: string } = {}): ProviderRevenue[] {
  const invoices = invoicesFor(orgId, { from: opts.from, to: opts.to, includeDrafts: false }).filter((i) => i.kind === 'invoice');
  const byProvider = new Map<string, ProviderRevenue>();
  const nameOf = (id: string) => get<Doc & { name?: string }>('providers', id)?.name ?? 'Unassigned';
  for (const invoice of invoices) {
    for (const line of invoice.lines as InvoiceLine[]) {
      const providerId = line.providerId ?? 'unassigned';
      const row = byProvider.get(providerId) ?? { providerId, providerName: nameOf(providerId), invoicedMinor: 0, collectedMinor: 0, outstandingMinor: 0, appointments: 0 };
      row.invoicedMinor += Number(line.grossMinor ?? 0);
      row.appointments += line.bookingId ? 1 : 0;
      byProvider.set(providerId, row);
    }
    // Collected money follows the invoice's own payment ratio, so a part-paid
    // invoice does not credit a provider with money the practice never took.
    const total = Number(invoice.totalMinor ?? 0) || 1;
    const collectedRatio = Math.min(1, Number(invoice.paidMinor ?? 0) / total);
    for (const line of invoice.lines as InvoiceLine[]) {
      const providerId = line.providerId ?? 'unassigned';
      const row = byProvider.get(providerId)!;
      const share = Math.round(Number(line.grossMinor ?? 0) * collectedRatio);
      row.collectedMinor += share;
      row.outstandingMinor += Number(line.grossMinor ?? 0) - share - (allocationCredit(invoice, line));
    }
  }
  return [...byProvider.values()].sort((a, b) => b.invoicedMinor - a.invoicedMinor);
}

/** The share of a line that a credit note has written off. */
function allocationCredit(invoice: InvoiceDoc, line: InvoiceLine): number {
  const total = Number(invoice.totalMinor ?? 0) || 1;
  return Math.round((Number(line.grossMinor ?? 0) * Number(invoice.creditedMinor ?? 0)) / total);
}

export type MoneyOverview = {
  currency: string;
  from?: string;
  to?: string;
  invoicedMinor: number;
  collectedMinor: number;
  refundedMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  expensesMinor: number;
  netMinor: number;
  counts: { invoices: number; drafts: number; paid: number; overdue: number; payments: number; expenses: number };
  byProvider: ProviderRevenue[];
  byCategory: { category: string; amountMinor: number }[];
  recent: { id: string; at: string; kind: string; reference: string; clientName?: string; amountMinor: number; currency: string }[];
};

export function moneyOverview(orgId: string, opts: { from?: string; to?: string } = {}): MoneyOverview {
  const settings = moneySettingsFor(orgId);
  const invoices = invoicesFor(orgId, { from: opts.from, to: opts.to, includeDrafts: true }).filter((i) => i.kind === 'invoice');
  const live = invoices.filter((i) => i.status !== 'void' && i.status !== 'draft');
  const payments = paymentsFor(orgId, { from: opts.from, to: opts.to });
  const expenses = expensesFor(orgId, { from: opts.from, to: opts.to });

  const invoicedMinor = live.reduce((s, i) => s + Number(i.totalMinor ?? 0), 0);
  const collectedMinor = payments.filter((p) => p.direction === 'in').reduce((s, p) => s + p.amountMinor, 0);
  const refundedMinor = payments.filter((p) => p.direction === 'out').reduce((s, p) => s + p.amountMinor, 0);
  const outstandingMinor = live.reduce((s, i) => s + balanceMinorOf(i), 0) - creditOnAccountMinorTotal(orgId);
  const overdueMinor = live.filter((i) => i.status === 'overdue').reduce((s, i) => s + balanceMinorOf(i), 0);
  const expensesMinor = expenses.reduce((s, e) => s + e.amountMinor + e.taxMinor, 0);

  const byCategory = [...new Set(expenses.map((e) => e.category))].map((category) => ({
    category,
    amountMinor: expenses.filter((e) => e.category === category).reduce((s, e) => s + e.amountMinor + e.taxMinor, 0),
  })).sort((a, b) => b.amountMinor - a.amountMinor);

  const recent = [
    ...live.map((i) => ({
      id: i.id,
      at: String(i.issueDate ?? i.createdAt ?? '').slice(0, 10),
      kind: i.kind === 'credit' ? 'credit note' : 'invoice',
      reference: i.number ?? '(draft)',
      clientName: i.clientName,
      amountMinor: Number(i.totalMinor ?? 0),
      currency: i.currency,
    })),
    ...payments.map((p) => ({
      id: p.id,
      at: String(p.at ?? '').slice(0, 10),
      kind: p.kind,
      reference: p.reference ?? p.id,
      clientName: p.clientName,
      amountMinor: p.direction === 'out' ? -p.amountMinor : p.amountMinor,
      currency: p.currency,
    })),
    ...expenses.map((e) => ({
      id: e.id,
      at: String(e.at ?? '').slice(0, 10),
      kind: 'expense',
      reference: e.supplier ?? e.category,
      clientName: undefined,
      amountMinor: -(e.amountMinor + e.taxMinor),
      currency: e.currency,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);

  return {
    currency: settings.currency,
    from: opts.from,
    to: opts.to,
    invoicedMinor,
    collectedMinor,
    refundedMinor,
    outstandingMinor,
    overdueMinor,
    expensesMinor,
    netMinor: collectedMinor - refundedMinor - expensesMinor,
    counts: {
      invoices: invoices.filter((i) => i.status !== 'void').length,
      drafts: invoices.filter((i) => i.status === 'draft').length,
      paid: invoices.filter((i) => i.status === 'paid').length,
      overdue: invoices.filter((i) => i.status === 'overdue').length,
      payments: payments.length,
      expenses: expenses.length,
    },
    byProvider: providerRevenue(orgId, opts),
    byCategory,
    recent,
  };
}

function creditOnAccountMinorTotal(orgId: string): number {
  const clients = new Set(paymentsFor(orgId).filter((p) => p.unallocatedMinor > 0).map((p) => p.clientId));
  return [...clients].reduce((sum, clientId) => sum + creditOnAccountMinor(orgId, clientId), 0);
}

/* ----------------------------------------------------------------------- export */

export type XeroExport = {
  generatedAt: string;
  from?: string;
  to?: string;
  Organisation: { Name: string; BaseCurrency: string };
  Accounts: { Code: string; Name: string; Type: string; TaxType: string }[];
  Contacts: { ContactID: string; Name: string; EmailAddress?: string; Phones?: { PhoneNumber: string }[] }[];
  Invoices: Record<string, unknown>[];
  CreditNotes: Record<string, unknown>[];
  Payments: Record<string, unknown>[];
};

/**
 * A Xero-shaped export: the payload Xero's Accounting API takes, filled from this
 * workspace's own ledger. Not a sync — a file a bookkeeper can import or an
 * integrator can POST, which is what "integrate, do not own the books" means in
 * practice (see PRACTICE.md §2).
 *
 * Amounts are decimal in the payload because that is what Xero's API expects;
 * internally everything stays in integer minor units until this boundary.
 */
export function xeroExport(orgId: string, opts: { from?: string; to?: string } = {}): XeroExport {
  const settings = moneySettingsFor(orgId);
  const org = get<Doc & { name?: string }>('orgs', orgId);
  const clients = new Map<string, ClientDoc>();
  const invoices = invoicesFor(orgId, { from: opts.from, to: opts.to, includeDrafts: false }).filter((i) => i.status !== 'void');
  for (const invoice of invoices) {
    const client = clientById(orgId, invoice.clientId);
    if (client) clients.set(client.id, client);
  }
  const money = (minor: number, currency: string) => fromMinor(minor, currency);

  return {
    generatedAt: nowIso(),
    from: opts.from,
    to: opts.to,
    Organisation: { Name: org?.name ?? 'Practice', BaseCurrency: settings.currency },
    Accounts: [
      { Code: '200', Name: 'Sales', Type: 'REVENUE', TaxType: 'OUTPUT2' },
      { Code: '400', Name: 'Payments received', Type: 'CURRENT', TaxType: 'NONE' },
      { Code: '401', Name: 'Refunds paid', Type: 'CURRENT', TaxType: 'NONE' },
      { Code: '300', Name: 'Expenses', Type: 'EXPENSE', TaxType: 'INPUT2' },
    ],
    Contacts: [...clients.values()].map((client) => ({
      ContactID: client.id,
      Name: client.name,
      EmailAddress: client.email,
      ...(client.number ? { Phones: [{ PhoneNumber: client.number }] } : {}),
    })),
    Invoices: invoices
      .filter((i) => i.kind === 'invoice')
      .map((invoice) => ({
        InvoiceID: invoice.id,
        InvoiceNumber: invoice.number,
        Type: 'ACCREC',
        Contact: { ContactID: invoice.clientId },
        Date: invoice.issueDate,
        DueDate: invoice.dueDate,
        LineItems: (invoice.lines as InvoiceLine[]).map((line) => ({
          Description: line.description,
          Quantity: line.qty,
          UnitAmount: money(line.unitAmountMinor, invoice.currency),
          AccountCode: '200',
          TaxType: line.taxRatePct > 0 ? `OUTPUT${line.taxRatePct}` : 'NONE',
          LineAmount: money(line.netMinor, invoice.currency),
          TaxAmount: money(line.taxMinor, invoice.currency),
        })),
        SubTotal: money(Number(invoice.subtotalMinor) - Number(invoice.discountMinor), invoice.currency),
        TotalTax: money(invoice.taxMinor, invoice.currency),
        Total: money(invoice.totalMinor, invoice.currency),
        TotalDiscount: money(invoice.discountMinor, invoice.currency),
        AmountDue: money(balanceMinorOf(invoice), invoice.currency),
        AmountPaid: money(invoice.paidMinor, invoice.currency),
        CurrencyCode: invoice.currency,
        Status: invoice.status === 'paid' ? 'PAID' : invoice.status === 'overdue' ? 'AUTHORISED' : 'AUTHORISED',
        Reference: invoice.notes,
      })),
    CreditNotes: invoices
      .filter((i) => i.kind === 'credit')
      .map((credit) => ({
        CreditNoteID: credit.id,
        CreditNoteNumber: credit.number,
        Type: 'ACCRECCREDIT',
        Contact: { ContactID: credit.clientId },
        Date: credit.issueDate,
        LineItems: (credit.lines as InvoiceLine[]).map((line) => ({
          Description: line.description,
          Quantity: line.qty,
          UnitAmount: money(line.unitAmountMinor, credit.currency),
          AccountCode: '200',
          TaxType: 'NONE',
          LineAmount: money(line.netMinor, credit.currency),
        })),
        SubTotal: money(credit.subtotalMinor, credit.currency),
        Total: money(credit.totalMinor, credit.currency),
        RemainingCredit: money(Math.abs(Number(credit.totalMinor)), credit.currency),
        CurrencyCode: credit.currency,
        Status: 'AUTHORISED',
      })),
    Payments: paymentsFor(orgId, { from: opts.from, to: opts.to }).map((payment) => ({
      PaymentID: payment.id,
      InvoiceNumber: payment.allocations.length ? invoiceById(orgId, payment.allocations[0].invoiceId)?.number : undefined,
      Date: String(payment.at ?? '').slice(0, 10),
      Amount: money(payment.amountMinor, payment.currency),
      Account: { Code: payment.direction === 'out' ? '401' : '400' },
      Reference: payment.reference ?? payment.id,
      CurrencyCode: payment.currency,
      Status: payment.status === 'void' ? 'DELETED' : 'AUTHORISED',
    })),
  };
}

/** The export as CSV — the shape a spreadsheet and most importers want. */
export function xeroCsv(exported: XeroExport): { invoicesCsv: string; paymentsCsv: string; expensesCsv: string } {
  const csv = (rows: Record<string, unknown>[]) => {
    if (!rows.length) return '';
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const escape = (value: unknown) => {
      const text = value === undefined || value === null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [columns.join(','), ...rows.map((row) => columns.map((c) => escape(row[c])).join(','))].join('\n');
  };
  const flatInvoices = exported.Invoices.map((i) => {
    const contact = (i.Contact as { ContactID?: string } | undefined)?.ContactID ?? '';
    const lines = Array.isArray(i.LineItems) ? (i.LineItems as Record<string, unknown>[]) : [];
    return {
      InvoiceNumber: i.InvoiceNumber,
      ContactID: contact,
      Date: i.Date,
      DueDate: i.DueDate,
      Status: i.Status,
      SubTotal: i.SubTotal,
      TotalTax: i.TotalTax,
      Total: i.Total,
      AmountPaid: i.AmountPaid,
      AmountDue: i.AmountDue,
      CurrencyCode: i.CurrencyCode,
      LineSummary: lines.map((l) => `${l.Description} x${l.Quantity} @ ${l.UnitAmount}`).join(' | '),
    };
  });
  return { invoicesCsv: csv(flatInvoices), paymentsCsv: csv(exported.Payments), expensesCsv: '' };
}

/* --------------------------------------------------------------------- clean-up */

/** Unallocated credits are the one thing that can be tidied without touching a record. */
export function pruneZeroPayments(orgId: string): number {
  const empty = list<PaymentDoc>('payments', (p) => p.orgId === orgId && p.allocations.length === 0 && p.unallocatedMinor === 0 && p.status === 'void');
  for (const row of empty) remove('payments', row.id);
  return empty.length;
}
