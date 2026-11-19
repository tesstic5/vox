/**
 * Class packs: a bundle of class places, paid for up front, spent one at a
 * time as the client actually comes (PLAN-CLASS-PACKS.md — the money rules
 * there were signed off before this was built).
 *
 * **The accounting shape, and why.** Buying a pack is *not* a sale of classes;
 * it is money held for classes not yet delivered. So the purchase records a
 * `prepayment` — cash in, unallocated, fenced to the pack (`PaymentDoc.packId`,
 * which ordinary on-account credit can never touch). A place is spent when the
 * seat is attended (or burned by a late cancel / no-show): only then is an
 * invoice raised, at that place's share of the pack price, and settled from
 * the pack's own prepayment (`applyCredit` with `packId`). Revenue is
 * recognised when the class happens, the cash is counted exactly once, and
 * practitioner/service reporting needs no new maths because it already reads
 * invoices.
 *
 * **Places are derived, never counted.** A pack's held/spent places are read
 * off the seats themselves (`booking.packId` + `booking.packState`), the same
 * reason a seat is an ordinary booking: two records of the same fact will
 * eventually disagree, so there is only one. Holds and spends are attached in
 * `classes.ts` (join/release/cancel) and `diary.ts` (status lifecycle) through
 * the hooks at the bottom of this file.
 */

import { get, insert, list, newId, nowIso, remove, update, type Doc } from './db';
import { audit } from './audit';
import { bookingsFor, type BookingDoc } from './bookings';
import {
  applyCredit,
  createInvoice,
  formatMoney,
  issueInvoice,
  moneySettingsFor,
  paymentsFor,
  recordPayment,
  reversePackSettlement,
  splitExact,
  type PaymentDoc,
} from './money';

/**
 * Giving a place back inside this many hours of the start burns it. It is the
 * same two hours the client's own link already allows for moving or
 * cancelling, so the pack rule and the link rule are one rule.
 */
export const PACK_LATE_CANCEL_HOURS = 2;

/* ------------------------------------------------------------------- types */

export type PackProductDoc = Doc & {
  orgId: string;
  /** The class service this pack buys places in. One service per pack. */
  serviceId: string;
  name: string;
  places: number;
  priceMinor: number;
  currency: string;
  /** Places live this long from purchase. 0/absent = no expiry. */
  expiryMonths?: number;
  active: boolean;
};

export type ClientPackDoc = Doc & {
  orgId: string;
  clientId: string;
  productId: string;
  serviceId: string;
  /** Snapshot at purchase: a later price change never rewrites a held pack. */
  name: string;
  placesTotal: number;
  priceMinor: number;
  /** Each place's share of the price, largest-remainder split — sums exactly. */
  perPlaceMinor: number[];
  currency: string;
  /** The prepayment that funds this pack. */
  paymentId: string;
  purchasedAt: string;
  expiresAt?: string;
  status: 'active' | 'refunded';
  refundedMinor?: number;
  refundedAt?: string;
};

export type PackStatus = 'active' | 'exhausted' | 'expired' | 'refunded';

export type PackSummary = Omit<ClientPackDoc, 'status'> & {
  serviceName: string;
  clientName: string;
  held: number;
  spent: number;
  /** Spendable right now: not held, not spent, not expired. */
  placesLeft: number;
  status: PackStatus;
  /** Money still held for undelivered places (unspent, whatever the clock). */
  valueHeldMinor: number;
};

export type PackWrite<T> = { ok: true; value: T } | { ok: false; code: string; message: string; param?: string };

/* ------------------------------------------------------------------ helpers */

type ServiceRow = Doc & { name?: string; capacity?: number; taxRatePct?: number; price?: number };

function serviceOf(orgId: string, serviceId: string): ServiceRow | undefined {
  const svc = get<ServiceRow>('services', serviceId);
  return svc && (svc as { orgId?: string }).orgId === orgId ? svc : undefined;
}

function clientOf(orgId: string, clientId: string) {
  const client = get<Doc & { orgId?: string; name?: string }>('clients', clientId);
  return client && client.orgId === orgId ? client : undefined;
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/** The seats that make this pack's places real. */
function seatsOf(orgId: string, packId: string): BookingDoc[] {
  return bookingsFor(orgId, (b) => b.packId === packId && b.packState !== 'released');
}

/* ----------------------------------------------------------------- products */

export function packProductsFor(orgId: string, opts: { includeInactive?: boolean } = {}): PackProductDoc[] {
  return list<PackProductDoc>('packProducts', (p) => p.orgId === orgId && (opts.includeInactive || p.active))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function packProductById(orgId: string, id: string): PackProductDoc | undefined {
  const doc = get<PackProductDoc>('packProducts', id);
  return doc && doc.orgId === orgId ? doc : undefined;
}

export function createPackProduct(input: {
  orgId: string; serviceId: string; name: string; places: number; priceMinor: number; expiryMonths?: number; actor: string; actorName?: string;
}): PackWrite<PackProductDoc> {
  const service = serviceOf(input.orgId, input.serviceId);
  if (!service) return { ok: false, code: 'NOT_FOUND', message: 'No such service in this workspace.', param: 'serviceId' };
  if (Number(service.capacity ?? 1) < 2) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${service.name ?? 'That service'} is not a class service (capacity under 2) — a pack buys places in a class.`, param: 'serviceId' };
  }
  const name = String(input.name ?? '').trim();
  if (name.length < 2) return { ok: false, code: 'VALIDATION_ERROR', message: 'Give the pack a name the desk will recognise.', param: 'name' };
  const places = Math.round(Number(input.places));
  if (!Number.isFinite(places) || places < 2 || places > 200) return { ok: false, code: 'VALIDATION_ERROR', message: 'A pack holds between 2 and 200 places.', param: 'places' };
  const priceMinor = Math.round(Number(input.priceMinor));
  if (!Number.isFinite(priceMinor) || priceMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: 'A pack has a price.', param: 'priceMinor' };
  const expiryMonths = input.expiryMonths === undefined ? undefined : Math.round(Number(input.expiryMonths));
  if (expiryMonths !== undefined && (!Number.isFinite(expiryMonths) || expiryMonths < 0 || expiryMonths > 60)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Expiry is 0 (never) to 60 months.', param: 'expiryMonths' };
  }
  const settings = moneySettingsFor(input.orgId);
  const product = insert<PackProductDoc>('packProducts', {
    id: newId('packp_'),
    orgId: input.orgId,
    serviceId: input.serviceId,
    name,
    places,
    priceMinor,
    currency: settings.currency,
    expiryMonths: expiryMonths || undefined,
    active: true,
  } as PackProductDoc);
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.product_created', target: product.id, detail: `${name} — ${places} places in ${service.name ?? ''} for ${formatMoney(priceMinor, settings.currency)}` });
  return { ok: true, value: product };
}

export function updatePackProduct(input: {
  orgId: string; id: string; patch: { name?: string; places?: number; priceMinor?: number; expiryMonths?: number; active?: boolean }; actor: string;
}): PackWrite<PackProductDoc> {
  const product = packProductById(input.orgId, input.id);
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'No such pack product.' };
  const patch: Partial<PackProductDoc> = {};
  if (input.patch.name !== undefined) {
    const name = String(input.patch.name).trim();
    if (name.length < 2) return { ok: false, code: 'VALIDATION_ERROR', message: 'Give the pack a name the desk will recognise.', param: 'name' };
    patch.name = name;
  }
  if (input.patch.places !== undefined) {
    const places = Math.round(Number(input.patch.places));
    if (!Number.isFinite(places) || places < 2 || places > 200) return { ok: false, code: 'VALIDATION_ERROR', message: 'A pack holds between 2 and 200 places.', param: 'places' };
    patch.places = places;
  }
  if (input.patch.priceMinor !== undefined) {
    const priceMinor = Math.round(Number(input.patch.priceMinor));
    if (!Number.isFinite(priceMinor) || priceMinor <= 0) return { ok: false, code: 'VALIDATION_ERROR', message: 'A pack has a price.', param: 'priceMinor' };
    patch.priceMinor = priceMinor;
  }
  if (input.patch.expiryMonths !== undefined) {
    const expiryMonths = Math.round(Number(input.patch.expiryMonths));
    if (!Number.isFinite(expiryMonths) || expiryMonths < 0 || expiryMonths > 60) return { ok: false, code: 'VALIDATION_ERROR', message: 'Expiry is 0 (never) to 60 months.', param: 'expiryMonths' };
    patch.expiryMonths = expiryMonths || undefined;
  }
  if (input.patch.active !== undefined) patch.active = Boolean(input.patch.active);
  // Editing a product never rewrites packs already sold: they snapshotted
  // their name, places and per-place values at purchase.
  const next = update<PackProductDoc>('packProducts', product.id, patch) as PackProductDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.product_updated', target: product.id, detail: Object.keys(patch).join(', ') || 'no change' });
  return { ok: true, value: next };
}

/* ------------------------------------------------------------------- packs */

export function clientPacksFor(orgId: string, filter?: (p: ClientPackDoc) => boolean): ClientPackDoc[] {
  return list<ClientPackDoc>('clientPacks', (p) => p.orgId === orgId && (!filter || filter(p)))
    .sort((a, b) => String(b.purchasedAt).localeCompare(String(a.purchasedAt)));
}

export function clientPackById(orgId: string, id: string): ClientPackDoc | undefined {
  const doc = get<ClientPackDoc>('clientPacks', id);
  return doc && doc.orgId === orgId ? doc : undefined;
}

export function summarisePack(orgId: string, pack: ClientPackDoc, now = Date.now()): PackSummary {
  const seats = seatsOf(orgId, pack.id);
  const spent = seats.filter((b) => b.packState === 'spent').length;
  const held = seats.filter((b) => b.packState === 'held').length;
  const expired = Boolean(pack.expiresAt) && new Date(String(pack.expiresAt)).getTime() <= now;
  const placesLeft = Math.max(0, pack.placesTotal - spent - held);
  const spentValue = pack.perPlaceMinor.slice(0, spent).reduce((s, v) => s + v, 0);
  const status: PackStatus = pack.status === 'refunded' ? 'refunded' : expired ? 'expired' : placesLeft <= 0 && held === 0 ? 'exhausted' : 'active';
  return {
    ...pack,
    serviceName: serviceOf(orgId, pack.serviceId)?.name ?? 'Class',
    clientName: String(clientOf(orgId, pack.clientId)?.name ?? 'Client'),
    held,
    spent,
    placesLeft: status === 'expired' || status === 'refunded' ? 0 : placesLeft,
    status,
    valueHeldMinor: Math.max(0, pack.priceMinor - spentValue - (pack.refundedMinor ?? 0)),
  };
}

export function packSummariesFor(orgId: string, opts: { clientId?: string } = {}): PackSummary[] {
  return clientPacksFor(orgId, (p) => !opts.clientId || p.clientId === opts.clientId).map((p) => summarisePack(orgId, p));
}

/** Money held for places nobody has taken yet — the liability line. */
export function packLiability(orgId: string): { packs: number; placesOutstanding: number; valueHeldMinor: number; currency: string } {
  const summaries = packSummariesFor(orgId);
  const live = summaries.filter((s) => s.status === 'active' || s.status === 'exhausted' || s.status === 'expired');
  return {
    packs: live.length,
    placesOutstanding: live.reduce((s, p) => s + p.held + p.placesLeft, 0),
    valueHeldMinor: live.reduce((s, p) => s + p.valueHeldMinor, 0),
    currency: moneySettingsFor(orgId).currency,
  };
}

/**
 * Sell a pack. The purchase is a prepayment fenced to the pack — no invoice
 * yet, because no class has happened yet. The receipt the client gets is the
 * payment's own (see `receipts.ts`: a prepayment is acknowledged once, when
 * taken, and never again place by place).
 */
export function purchasePack(input: {
  orgId: string; productId: string; clientId: string; method?: string; actor: string; actorName?: string;
}): PackWrite<PackSummary> {
  const product = packProductById(input.orgId, input.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'No such pack product.', param: 'productId' };
  if (!product.active) return { ok: false, code: 'CONFLICT', message: 'That pack is no longer sold.', param: 'productId' };
  const client = clientOf(input.orgId, input.clientId);
  if (!client) return { ok: false, code: 'NOT_FOUND', message: 'No such client.', param: 'clientId' };

  const purchasedAt = nowIso();
  // The pack row has to exist before the payment can be fenced to it, and the
  // payment before the pack can point at it. Insert the pack first with the
  // payment id minted here; if taking the money fails, the pack row goes too.
  const packId = newId('pack_');
  const paymentId = newId('pay_');
  const pack = insert<ClientPackDoc>('clientPacks', {
    id: packId,
    orgId: input.orgId,
    clientId: input.clientId,
    productId: product.id,
    serviceId: product.serviceId,
    name: product.name,
    placesTotal: product.places,
    priceMinor: product.priceMinor,
    perPlaceMinor: splitExact(product.priceMinor, Array.from({ length: product.places }, () => 1)),
    currency: product.currency,
    paymentId: '',
    purchasedAt,
    expiresAt: product.expiryMonths ? addMonths(purchasedAt, product.expiryMonths) : undefined,
    status: 'active',
  } as ClientPackDoc);

  const paid = recordPayment({
    orgId: input.orgId,
    clientId: input.clientId,
    kind: 'prepayment',
    method: input.method ?? 'card',
    amountMinor: product.priceMinor,
    packId: pack.id,
    note: `${product.name} — ${product.places} places`,
    actor: input.actor,
    actorName: input.actorName,
  });
  if (!paid.ok) {
    // No money, no pack. The row only existed to fence the payment to.
    remove('clientPacks', pack.id);
    return { ok: false, code: paid.code, message: paid.error };
  }
  // recordPayment mints its own id; point the pack at the real row.
  const settled = update<ClientPackDoc>('clientPacks', pack.id, { paymentId: paid.value.id }) as ClientPackDoc;
  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'pack.purchased',
    target: pack.id,
    detail: `${product.name} for ${String(client.name ?? 'a client')} — ${product.places} places, ${formatMoney(product.priceMinor, product.currency)} prepaid`,
  });
  return { ok: true, value: summarisePack(input.orgId, settled) };
}

/* ------------------------------------------------------------ hold and spend */

/** The pack a new seat should hold against: soonest-expiring first (FEFO). */
export function usablePackFor(orgId: string, clientId: string, serviceId: string, sessionStartsAt: string): ClientPackDoc | undefined {
  const startMs = new Date(sessionStartsAt).getTime();
  return clientPacksFor(orgId, (p) => p.clientId === clientId && p.serviceId === serviceId && p.status === 'active')
    .filter((p) => {
      if (p.expiresAt && new Date(p.expiresAt).getTime() < startMs) return false; // the class must fall inside the pack's life
      return summarisePack(orgId, p).placesLeft > 0;
    })
    .sort((a, b) => String(a.expiresAt ?? '9999').localeCompare(String(b.expiresAt ?? '9999')))[0];
}

/**
 * Attach a pack hold to a fresh seat. Called when a seat is taken (desk,
 * public page, wait-list claim — all of them join through `joinClassSession`),
 * so a client with a pack never has to be asked twice. Returns the pack the
 * place is held against, when there is one.
 */
export function attachPackHold(orgId: string, booking: BookingDoc): BookingDoc {
  if (!booking.sessionId || !booking.clientId || booking.packId) return booking;
  const pack = usablePackFor(orgId, booking.clientId, String(booking.serviceId ?? ''), String(booking.startsAt));
  if (!pack) return booking;
  const next = update<BookingDoc>('bookings', booking.id, { packId: pack.id, packState: 'held' }) as BookingDoc;
  audit({
    orgId,
    actor: 'system',
    action: 'pack.place_held',
    target: booking.id,
    detail: `${summarisePack(orgId, pack).placesLeft} of ${pack.placesTotal} places left in ${pack.name} after this hold`,
  });
  return next ?? booking;
}

/**
 * Spend the place a seat holds. Idempotent: a seat already spent stays spent.
 * The invoice carries no tax line — the pack price was the price, quoted whole
 * at purchase, and splitting it per place must add back up to exactly itself.
 */
export function spendPackPlace(input: {
  orgId: string; booking: BookingDoc; actor: string; actorName?: string; burn?: boolean;
}): PackWrite<BookingDoc> {
  const booking = input.booking;
  if (!booking.packId) return { ok: true, value: booking };
  if (booking.packState === 'spent') return { ok: true, value: booking };
  if (booking.packState !== 'held') return { ok: true, value: booking };
  const pack = clientPackById(input.orgId, booking.packId);
  if (!pack) return { ok: false, code: 'NOT_FOUND', message: 'That seat holds a pack that no longer exists.' };

  const summary = summarisePack(input.orgId, pack);
  const placeIndex = Math.min(summary.spent, pack.perPlaceMinor.length - 1);
  const amountMinor = pack.perPlaceMinor[placeIndex] ?? 0;
  const service = serviceOf(input.orgId, pack.serviceId);

  const created = createInvoice({
    orgId: input.orgId,
    clientId: pack.clientId,
    lines: [{
      description: `${service?.name ?? pack.name} — pack place (${pack.name})`,
      qty: 1,
      unitAmountMinor: amountMinor,
      taxRatePct: 0,
      serviceId: pack.serviceId,
      bookingId: booking.id,
      providerId: booking.providerId ? String(booking.providerId) : undefined,
    }],
    bookingIds: [booking.id],
    source: 'booking',
    actor: input.actor,
    actorName: input.actorName,
  });
  if (!created.ok) return { ok: false, code: created.code, message: created.error };
  const issued = issueInvoice({ orgId: input.orgId, id: created.value.id, actor: input.actor, actorName: input.actorName });
  if (!issued.ok) return { ok: false, code: issued.code, message: issued.error };
  const settled = applyCredit({
    orgId: input.orgId,
    clientId: pack.clientId,
    invoiceId: issued.value.id,
    amountMinor: issued.value.totalMinor,
    packId: pack.id,
    actor: input.actor,
    actorName: input.actorName,
  });
  if (!settled.ok) return { ok: false, code: settled.code, message: settled.error };

  const next = update<BookingDoc>('bookings', booking.id, { packState: 'spent', packInvoiceId: issued.value.id }) as BookingDoc;
  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: input.burn ? 'pack.place_burned' : 'pack.place_spent',
    target: booking.id,
    detail: `${pack.name} — place ${summary.spent + 1} of ${pack.placesTotal} (${formatMoney(amountMinor, pack.currency)})${input.burn ? ' — late cancel / no-show' : ''} on ${issued.value.number ?? issued.value.id}`,
  });
  return { ok: true, value: next ?? booking };
}

/** Give a held place back without spending it. */
export function releasePackHold(input: { orgId: string; booking: BookingDoc; actor: string; reason?: string }): BookingDoc {
  const booking = input.booking;
  if (!booking.packId || booking.packState !== 'held') return booking;
  const next = update<BookingDoc>('bookings', booking.id, { packState: 'released' }) as BookingDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.place_released', target: booking.id, detail: input.reason ?? 'place given back before the late-cancel window' });
  return next ?? booking;
}

/** Un-spend a place: the money travels back and the invoice is voided. */
export function unspendPackPlace(input: { orgId: string; booking: BookingDoc; actor: string; actorName?: string; reason: string }): PackWrite<BookingDoc> {
  const booking = input.booking;
  if (!booking.packId || booking.packState !== 'spent') return { ok: true, value: booking };
  if (booking.packInvoiceId) {
    const reversed = reversePackSettlement({ orgId: input.orgId, invoiceId: booking.packInvoiceId, packId: booking.packId, reason: input.reason, actor: input.actor, actorName: input.actorName });
    if (!reversed.ok) return { ok: false, code: reversed.code, message: reversed.error };
  }
  const next = update<BookingDoc>('bookings', booking.id, { packState: 'held', packInvoiceId: undefined }) as BookingDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.place_unspent', target: booking.id, detail: input.reason });
  return { ok: true, value: next ?? booking };
}

/* ------------------------------------------------------- lifecycle hook */

/**
 * The one door every seat transition comes through with its pack
 * consequences — called from `setAppointmentStatus` (diary, register, client
 * link, SMS replies) and mirrored by `releaseSeat`/`cancelClassSession` in
 * `classes.ts`, which cancel seats by hand.
 *
 * - arrived / completed → the class happened: spend.
 * - no_show → the place was theirs and they did not come: spend (burn).
 * - cancelled → inside the late window burns; before it releases.
 * - back to an open status from a spent state (the register's Undo) → un-spend.
 * - the practice cancelling the class is *not* a client cancellation:
 *   `cancelClassSession` releases/un-spends directly, never burns.
 */
export function packOnSeatStatus(input: {
  orgId: string; booking: BookingDoc; from: string; to: string; actor: string; actorName?: string;
}): void {
  const booking = input.booking;
  if (!booking.sessionId || !booking.packId) return;
  const fail = (r: PackWrite<BookingDoc>) => {
    if (!r.ok) console.warn(`[packs] seat ${booking.id} → ${input.to}: ${r.message}`);
  };
  if (input.to === 'arrived' || input.to === 'completed') {
    fail(spendPackPlace({ orgId: input.orgId, booking, actor: input.actor, actorName: input.actorName }));
  } else if (input.to === 'no_show') {
    fail(spendPackPlace({ orgId: input.orgId, booking, actor: input.actor, actorName: input.actorName, burn: true }));
  } else if (input.to === 'cancelled') {
    const lateBy = new Date(String(booking.startsAt)).getTime() - Date.now() <= PACK_LATE_CANCEL_HOURS * 3_600_000;
    if (lateBy) fail(spendPackPlace({ orgId: input.orgId, booking, actor: input.actor, actorName: input.actorName, burn: true }));
    else releasePackHold({ orgId: input.orgId, booking, actor: input.actor });
  } else if ((input.to === 'confirmed' || input.to === 'pending') && booking.packState === 'spent') {
    fail(unspendPackPlace({ orgId: input.orgId, booking, actor: input.actor, actorName: input.actorName, reason: `attendance mark undone (${input.from} → ${input.to})` }));
  }
}

/** The practice called the class off: places go back, never burn. */
export function packOnSessionCancelled(input: { orgId: string; booking: BookingDoc; actor: string; actorName?: string }): void {
  const booking = input.booking;
  if (!booking.packId) return;
  if (booking.packState === 'spent') {
    const r = unspendPackPlace({ orgId: input.orgId, booking, actor: input.actor, actorName: input.actorName, reason: 'the class session was cancelled' });
    if (!r.ok) console.warn(`[packs] un-spend on session cancel failed for ${booking.id}: ${r.message}`);
  }
  if (booking.packState === 'held' || booking.packState === 'spent') {
    update<BookingDoc>('bookings', booking.id, { packState: 'released' });
    audit({ orgId: input.orgId, actor: input.actor, action: 'pack.place_released', target: booking.id, detail: 'the class session was cancelled by the practice' });
  }
}

/* ------------------------------------------------------------- desk actions */

/** Refund what was never spent. Held places block it — release them first. */
export function refundPackUnused(input: {
  orgId: string; packId: string; actor: string; actorName?: string;
}): PackWrite<{ pack: PackSummary; refundedMinor: number }> {
  const pack = clientPackById(input.orgId, input.packId);
  if (!pack) return { ok: false, code: 'NOT_FOUND', message: 'No such pack.' };
  const summary = summarisePack(input.orgId, pack);
  if (summary.status === 'refunded') return { ok: false, code: 'CONFLICT', message: 'That pack has already been refunded.' };
  if (summary.status === 'expired') return { ok: false, code: 'CONFLICT', message: 'That pack has expired — expired places are not refundable.' };
  if (summary.held > 0) return { ok: false, code: 'CONFLICT', message: `${summary.held} place(s) are held for upcoming classes. Give those places back first, then refund.` };
  const refundedMinor = pack.perPlaceMinor.slice(summary.spent).reduce((s, v) => s + v, 0);
  if (refundedMinor <= 0) return { ok: false, code: 'CONFLICT', message: 'There is nothing unspent to refund.' };

  const refund = recordPayment({
    orgId: input.orgId,
    clientId: pack.clientId,
    kind: 'refund',
    method: 'card',
    amountMinor: refundedMinor,
    note: `${pack.name} — refund of ${pack.placesTotal - summary.spent} unspent place(s)`,
    actor: input.actor,
    actorName: input.actorName,
  });
  if (!refund.ok) return { ok: false, code: refund.code, message: refund.error };

  // The refund above is the money out the client sees. The pack's own
  // prepayment pool must shrink by the same amount, or the places would
  // still be spendable after the client has their money back.
  let left = refundedMinor;
  const rows = paymentsFor(input.orgId, { clientId: pack.clientId })
    .filter((p: PaymentDoc) => p.packId === pack.id && p.status === 'settled' && p.direction === 'in')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const row of rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(row.unallocatedMinor ?? 0));
    if (take <= 0) continue;
    update<PaymentDoc>('payments', row.id, { unallocatedMinor: Number(row.unallocatedMinor ?? 0) - take });
    left -= take;
  }

  const next = update<ClientPackDoc>('clientPacks', pack.id, { status: 'refunded', refundedMinor, refundedAt: nowIso() }) as ClientPackDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.refunded', target: pack.id, detail: `${pack.name} — ${formatMoney(refundedMinor, pack.currency)} back for ${pack.placesTotal - summary.spent} unspent place(s)` });
  return { ok: true, value: { pack: summarisePack(input.orgId, next), refundedMinor } };
}

/** Extend a pack's life. Audited, reasoned, never silent (like a note amendment). */
export function extendPack(input: {
  orgId: string; packId: string; months: number; reason: string; actor: string;
}): PackWrite<PackSummary> {
  const pack = clientPackById(input.orgId, input.packId);
  if (!pack) return { ok: false, code: 'NOT_FOUND', message: 'No such pack.' };
  const months = Math.round(Number(input.months));
  if (!Number.isFinite(months) || months < 1 || months > 24) return { ok: false, code: 'VALIDATION_ERROR', message: 'Extend by 1 to 24 months.', param: 'months' };
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, code: 'VALIDATION_ERROR', message: 'Extending a pack needs a reason — it stays on the record.', param: 'reason' };
  const base = pack.expiresAt && new Date(pack.expiresAt).getTime() > Date.now() ? pack.expiresAt : nowIso();
  const next = update<ClientPackDoc>('clientPacks', pack.id, { expiresAt: addMonths(base, months) }) as ClientPackDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'pack.extended', target: pack.id, detail: `${pack.name} extended ${months} month(s) to ${String(next.expiresAt).slice(0, 10)} — ${reason}` });
  return { ok: true, value: summarisePack(input.orgId, next) };
}

/** Move the remaining places to another client (families share packs). */
export function transferPack(input: {
  orgId: string; packId: string; toClientId: string; reason: string; actor: string;
}): PackWrite<PackSummary> {
  const pack = clientPackById(input.orgId, input.packId);
  if (!pack) return { ok: false, code: 'NOT_FOUND', message: 'No such pack.' };
  const target = clientOf(input.orgId, input.toClientId);
  if (!target) return { ok: false, code: 'NOT_FOUND', message: 'No such client to transfer to.', param: 'toClientId' };
  if (input.toClientId === pack.clientId) return { ok: false, code: 'VALIDATION_ERROR', message: 'That pack already belongs to them.', param: 'toClientId' };
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, code: 'VALIDATION_ERROR', message: 'Transferring a pack needs a reason — both clients keep it on their record.', param: 'reason' };
  const summary = summarisePack(input.orgId, pack);
  if (summary.held > 0) return { ok: false, code: 'CONFLICT', message: 'Places from this pack are held for upcoming classes. Give those places back first, then transfer.' };
  if (summary.status === 'refunded' || summary.status === 'expired') return { ok: false, code: 'CONFLICT', message: `A ${summary.status} pack has nothing to transfer.` };

  // The money has to move with the entitlement or the new owner's first spent
  // place would try to settle from the old owner's account. Split the pack's
  // prepayment: what is unallocated (the unspent value) changes owner, tagged
  // to the same pack.
  const rows = paymentsFor(input.orgId, { clientId: pack.clientId }).filter((p: PaymentDoc) => p.packId === pack.id && p.status === 'settled' && p.direction === 'in');
  for (const row of rows) {
    const free = Number(row.unallocatedMinor ?? 0);
    if (free <= 0) continue;
    update<PaymentDoc>('payments', row.id, { unallocatedMinor: 0 });
    recordPayment({
      orgId: input.orgId,
      clientId: input.toClientId,
      kind: 'prepayment',
      method: 'account_credit',
      amountMinor: free,
      packId: pack.id,
      note: `${pack.name} — transferred from ${summary.clientName}: ${reason}`,
      actor: input.actor,
    });
  }
  const next = update<ClientPackDoc>('clientPacks', pack.id, { clientId: input.toClientId }) as ClientPackDoc;
  audit({
    orgId: input.orgId,
    actor: input.actor,
    action: 'pack.transferred',
    target: pack.id,
    detail: `${pack.name} — ${summary.placesLeft} place(s) from ${summary.clientName} to ${String(target.name ?? 'another client')} — ${reason}`,
  });
  return { ok: true, value: summarisePack(input.orgId, next) };
}
