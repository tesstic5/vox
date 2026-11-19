import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, publicOrigin, readJson, requireAuth } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import type { MoneySettings } from '@/lib/server/money';
import {
  canEditMoney,
  canReadMoney,
  canTakePayment,
  createExpense,
  createInvoice,
  creditInvoice,
  expensesFor,
  formatMoney,
  invoiceById,
  invoiceFromBooking,
  invoicesFor,
  issueInvoice,
  moneyOverview,
  moneySettingsFor,
  overdueInvoices,
  paymentById,
  paymentTypesFor,
  paymentsFor,
  recordPayment,
  refreshOverdue,
  seedPaymentTypes,
  setMoneySettings,
  updateExpense,
  updateInvoice,
  voidExpense,
  voidInvoice,
  voidPayment,
  balanceMinorOf,
  clientBalance,
  xeroCsv,
  xeroExport,
  type InvoiceDoc,
} from '@/lib/server/money';
import { createPaymentLink, linkById, linkStats, linksFor, markLinkSent, cancelLink, paymentProviderFor } from '@/lib/server/payments';
import { bookingById } from '@/lib/server/bookings';
import { clientById } from '@/lib/server/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Money — invoices, payments, credit notes, expenses, and the workspace's books.
 *
 * Three read shapes and one write door, following the pattern the rest of the API
 * uses:
 *
 *   - `GET /api/v1/invoices` — the list, with the figures a desk needs.
 *   - `GET /api/v1/invoices?view=overview` — the money screen's summary.
 *   - `GET /api/v1/invoices/{id}` — one invoice, with its payments and credit notes.
 *   - `POST /api/v1/invoices` — actions. Reading is open to every role that works
 *     the desk (a receptionist must be able to see what is owed); *issuing*,
 *     *adjusting*, *voiding* and *pricing* are the practice's books and need an
 *     owner, admin or developer. **Taking a payment** is the one write a
 *     receptionist may do — that is the job.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const allowed = ctx.auth === 'key' || canReadMoney(ctx.user?.role);
  if (!allowed) {
    return fail('FORBIDDEN', 'This role cannot read the practice books.', { requestId: ctx.requestId });
  }

  // The counter's payment types exist from first use, like the message library.
  const seeded = seedPaymentTypes(ctx.orgId);
  const settings = moneySettingsFor(ctx.orgId);
  const view = url.searchParams.get('view');
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;

  if (view === 'overview') {
    refreshOverdue(ctx.orgId);
    const overview = moneyOverview(ctx.orgId, { from, to });
    return ok(
      {
        ...overview,
        settings,
        provider: paymentProviderFor(ctx.orgId),
        links: linkStats(ctx.orgId),
        paymentTypes: paymentTypesFor(ctx.orgId),
        seededNow: seeded.seeded,
      },
      { requestId: ctx.requestId }
    );
  }

  if (view === 'payments') {
    const rows = paymentsFor(ctx.orgId, {
      clientId: url.searchParams.get('clientId') ?? undefined,
      invoiceId: url.searchParams.get('invoiceId') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      from,
      to,
      includeVoid: url.searchParams.get('include') === 'void',
    });
    return ok(
      listBody(rows, {
        stats: {
          count: rows.length,
          receivedMinor: rows.filter((p) => p.direction === 'in' && p.status === 'settled').reduce((s, p) => s + p.amountMinor, 0),
          refundedMinor: rows.filter((p) => p.direction === 'out' && p.status === 'settled').reduce((s, p) => s + p.amountMinor, 0),
          currency: settings.currency,
        },
        paymentTypes: paymentTypesFor(ctx.orgId),
      }),
      { requestId: ctx.requestId }
    );
  }

  if (view === 'expenses') {
    const rows = expensesFor(ctx.orgId, { from, to, category: url.searchParams.get('category') ?? undefined, includeVoid: url.searchParams.get('include') === 'void' });
    return ok(
      listBody(rows, {
        stats: {
          count: rows.length,
          totalMinor: rows.reduce((s, e) => s + e.amountMinor + e.taxMinor, 0),
          currency: settings.currency,
        },
      }),
      { requestId: ctx.requestId }
    );
  }

  if (view === 'links') {
    const rows = linksFor(ctx.orgId, {
      invoiceId: url.searchParams.get('invoiceId') ?? undefined,
      clientId: url.searchParams.get('clientId') ?? undefined,
      status: (url.searchParams.get('status') as never) ?? undefined,
    });
    return ok(listBody(rows, { stats: linkStats(ctx.orgId), provider: paymentProviderFor(ctx.orgId) }), { requestId: ctx.requestId });
  }

  if (view === 'export') {
    // The books, in the shape an accountant's system takes. Amounts are decimal in
    // the payload because that is what Xero's API expects; internally nothing left
    // integer minor units until this boundary.
    const exported = xeroExport(ctx.orgId, { from, to });
    return ok({ xero: exported, csv: xeroCsv(exported), generatedAt: exported.generatedAt }, { requestId: ctx.requestId });
  }

  if (view === 'payment-types') {
    return ok(listBody(paymentTypesFor(ctx.orgId, { includeInactive: url.searchParams.get('include') === 'inactive' })), { requestId: ctx.requestId });
  }

  const rows = invoicesFor(ctx.orgId, {
    clientId: url.searchParams.get('clientId') ?? undefined,
    bookingId: url.searchParams.get('bookingId') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    from,
    to,
    includeDrafts: url.searchParams.get('include') === 'drafts' || url.searchParams.get('include') === 'all',
    includeVoid: url.searchParams.get('include') === 'all' || url.searchParams.get('include') === 'void',
  });

  const open = rows.filter((i) => ['issued', 'partly_paid', 'overdue'].includes(i.status) && i.kind === 'invoice');
  return ok(
    listBody(
      rows.map((invoice) => ({ ...invoice, balanceMinor: balanceMinorOf(invoice) })),
      {
        stats: {
          count: rows.length,
          drafts: rows.filter((i) => i.status === 'draft').length,
          overdue: rows.filter((i) => i.status === 'overdue').length,
          outstandingMinor: open.reduce((s, i) => s + balanceMinorOf(i), 0),
          overdueMinor: overdueInvoices(ctx.orgId).reduce((s, i) => s + balanceMinorOf(i), 0),
          invoicedMinor: rows.filter((i) => i.kind === 'invoice' && i.status !== 'void' && i.status !== 'draft').reduce((s, i) => s + i.totalMinor, 0),
          currency: settings.currency,
        },
        canEdit: ctx.auth === 'key' || canEditMoney(ctx.user?.role),
        canTakePayment: ctx.auth === 'key' || canTakePayment(ctx.user?.role),
        paymentTypes: paymentTypesFor(ctx.orgId),
      }
    ),
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, unknown> & { action?: string; id?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const role = ctx.user?.role;
  const isKey = ctx.auth === 'key';
  const action = String(body.action ?? 'create');

  // Money that lands is the desk's business; money that is *written down* is the
  // practice's. The two are separated here, once, so every door agrees.
  const moneyArrives = ['pay', 'prepay', 'refund', 'apply-credit', 'void-payment', 'link:create', 'link:send', 'link:cancel'];
  const mayWrite = isKey || (moneyArrives.includes(action) ? canTakePayment(role) : canEditMoney(role));
  if (!mayWrite) {
    return fail('FORBIDDEN', 'Taking money is the desk\u2019s job; changing what is owed is the practice owner\u2019s.', {
      requestId: ctx.requestId,
      detail: `This account (${role ?? 'api key'}) may ${moneyArrives.includes(action) ? 'record payments' : 'read the books, not edit them'}.`,
    });
  }

  const id = body.id ? String(body.id) : undefined;
  const invoice = id ? invoiceById(ctx.orgId, id) : undefined;
  const notFound = () => fail('NOT_FOUND', `No invoice with id ${id}.`, { requestId: ctx.requestId });
  const bad = (result: { code: string; error: string; detail?: string }) =>
    fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' || result.code === 'IMMUTABLE' ? 'CONFLICT' : 'VALIDATION_ERROR', result.error, {
      requestId: ctx.requestId,
      detail: result.detail,
    });

  switch (action) {
    /* -------------------------------------------------------------- invoices */
    case 'create': {
      if (!body.clientId) return fail('VALIDATION_ERROR', 'An invoice needs `clientId`.', { param: 'clientId', requestId: ctx.requestId });
      const lines = Array.isArray(body.lines) ? (body.lines as never[]) : [];
      if (!lines.length) {
        return fail('VALIDATION_ERROR', 'An invoice needs at least one line: { description, qty, unitAmount, taxRatePct }.', { param: 'lines', requestId: ctx.requestId });
      }
      const created = createInvoice({
        orgId: ctx.orgId,
        clientId: String(body.clientId),
        lines,
        bookingIds: Array.isArray(body.bookingIds) ? (body.bookingIds as string[]) : undefined,
        discountPct: body.discountPct !== undefined ? Number(body.discountPct) : undefined,
        notes: body.notes ? String(body.notes) : undefined,
        source: 'manual',
        actor,
        actorName,
      });
      if (!created.ok) return bad(created);
      return ok({ invoice: { ...created.value, balanceMinor: balanceMinorOf(created.value) } }, { status: 201, requestId: ctx.requestId });
    }

    case 'from-booking':
    case 'from-appointment': {
      if (!body.bookingId) return fail('VALIDATION_ERROR', 'Which appointment? Send `bookingId`.', { param: 'bookingId', requestId: ctx.requestId });
      const booking = bookingById(ctx.orgId, String(body.bookingId));
      if (!booking) return fail('NOT_FOUND', `No appointment with id ${body.bookingId}.`, { requestId: ctx.requestId });
      const created = invoiceFromBooking({ orgId: ctx.orgId, bookingId: booking.id, actor, actorName, allowExisting: body.allowExisting === true });
      if (!created.ok) return bad(created);
      return ok({ invoice: { ...created.value, balanceMinor: balanceMinorOf(created.value) } }, { status: 201, requestId: ctx.requestId });
    }

    case 'update': {
      if (!invoice) return notFound();
      const updated = updateInvoice({
        orgId: ctx.orgId,
        id: String(id),
        patch: {
          lines: Array.isArray(body.lines) ? (body.lines as never[]) : undefined,
          discountPct: body.discountPct !== undefined ? Number(body.discountPct) : undefined,
          notes: body.notes !== undefined ? String(body.notes) : undefined,
          bookingIds: Array.isArray(body.bookingIds) ? (body.bookingIds as string[]) : undefined,
        },
        actor,
        actorName,
      });
      if (!updated.ok) return bad(updated);
      return ok({ invoice: { ...updated.value, balanceMinor: balanceMinorOf(updated.value) } }, { requestId: ctx.requestId });
    }

    case 'issue': {
      if (!invoice) return notFound();
      const issued = issueInvoice({ orgId: ctx.orgId, id: String(id), issueDate: body.issueDate ? String(body.issueDate) : undefined, actor, actorName });
      if (!issued.ok) return bad(issued);
      return ok({ invoice: { ...issued.value, balanceMinor: balanceMinorOf(issued.value) } }, { requestId: ctx.requestId });
    }

    case 'void': {
      if (!invoice) return notFound();
      const voided = voidInvoice({ orgId: ctx.orgId, id: String(id), reason: String(body.reason ?? ''), actor, actorName });
      if (!voided.ok) return bad(voided);
      return ok({ invoice: voided.value }, { requestId: ctx.requestId });
    }

    case 'credit': {
      if (!invoice) return notFound();
      const credited = creditInvoice({
        orgId: ctx.orgId,
        id: String(id),
        amount: body.amount as never,
        amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
        reason: String(body.reason ?? ''),
        actor,
        actorName,
      });
      if (!credited.ok) return bad(credited);
      return ok({ invoice: { ...credited.value.invoice, balanceMinor: balanceMinorOf(credited.value.invoice) }, credit: credited.value.credit }, { requestId: ctx.requestId });
    }

    /* -------------------------------------------------------------- payments */
    case 'pay':
    case 'prepay':
    case 'refund': {
      const kind = action === 'pay' ? 'payment' : action === 'prepay' ? 'prepayment' : 'refund';
      const recorded = recordPayment({
        orgId: ctx.orgId,
        clientId: body.clientId ? String(body.clientId) : undefined,
        invoiceId: invoice?.id ?? (body.invoiceId ? String(body.invoiceId) : undefined),
        kind,
        method: body.method !== undefined ? String(body.method) : undefined,
        amount: body.amount as never,
        amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
        reference: body.reference ? String(body.reference) : undefined,
        note: body.note ? String(body.note) : undefined,
        at: body.at ? String(body.at) : undefined,
        allocations: Array.isArray(body.allocations) ? (body.allocations as never[]) : undefined,
        source: 'desk',
        actor,
        actorName,
      });
      if (!recorded.ok) return bad(recorded);
      const touched = recorded.value.allocations.map((a) => invoiceById(ctx.orgId, a.invoiceId)).filter(Boolean) as InvoiceDoc[];
      const clientId = recorded.value.clientId;
      return ok(
        {
          payment: recorded.value,
          invoices: touched.map((i) => ({ ...i, balanceMinor: balanceMinorOf(i) })),
          clientBalance: clientId
            ? { ...clientBalance(ctx.orgId, clientId), currency: touched[0]?.currency ?? moneySettingsFor(ctx.orgId).currency }
            : undefined,
        },
        { status: 201, requestId: ctx.requestId }
      );
    }

    case 'apply-credit': {
      const target = invoice ?? (body.invoiceId ? invoiceById(ctx.orgId, String(body.invoiceId)) : undefined);
      if (!target) return fail('NOT_FOUND', 'Which invoice should the credit be applied to? Send `invoiceId`.', { requestId: ctx.requestId });
      const { applyCredit } = await import('@/lib/server/money');
      const applied = applyCredit({
        orgId: ctx.orgId,
        clientId: target.clientId,
        invoiceId: target.id,
        amount: body.amount as never,
        amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
        actor,
        actorName,
      });
      if (!applied.ok) return bad(applied);
      const after = invoiceById(ctx.orgId, target.id)!;
      return ok({ invoice: { ...after, balanceMinor: balanceMinorOf(after) } }, { requestId: ctx.requestId });
    }

    case 'void-payment': {
      if (!body.paymentId) return fail('VALIDATION_ERROR', 'Which payment? Send `paymentId`.', { param: 'paymentId', requestId: ctx.requestId });
      const payment = paymentById(ctx.orgId, String(body.paymentId));
      if (!payment) return fail('NOT_FOUND', `No payment with id ${body.paymentId}.`, { requestId: ctx.requestId });
      const voided = voidPayment({ orgId: ctx.orgId, id: payment.id, reason: String(body.reason ?? ''), actor, actorName });
      if (!voided.ok) return bad(voided);
      const touched = payment.allocations.map((a) => invoiceById(ctx.orgId, a.invoiceId)).filter(Boolean) as InvoiceDoc[];
      return ok({ payment: voided.value, invoices: touched.map((i) => ({ ...i, balanceMinor: balanceMinorOf(i) })) }, { requestId: ctx.requestId });
    }

    /* ---------------------------------------------------------- payment links */
    case 'link:create': {
      const target = invoice ?? (body.invoiceId ? invoiceById(ctx.orgId, String(body.invoiceId)) : undefined);
      if (!target) return fail('VALIDATION_ERROR', 'Which invoice? Send `invoiceId`.', { param: 'invoiceId', requestId: ctx.requestId });
      const created = await createPaymentLink({
        orgId: ctx.orgId,
        invoiceId: target.id,
        amount: body.amount as never,
        amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
        origin: originOf(req, body),
        actor,
        actorName,
        note: body.note ? String(body.note) : undefined,
      });
      if (!created.ok) return bad(created);
      return ok({ link: created.link, provider: paymentProviderFor(ctx.orgId) }, { status: 201, requestId: ctx.requestId });
    }

    case 'link:send': {
      const link = body.linkId ? linkById(ctx.orgId, String(body.linkId)) : linksFor(ctx.orgId, { invoiceId: String(body.invoiceId ?? '') })[0];
      if (!link) return fail('NOT_FOUND', 'No payment link to send.', { requestId: ctx.requestId });
      const via = body.via === 'email' ? 'email' : 'sms';
      const client = clientById(ctx.orgId, link.clientId);
      const to = String(body.to ?? (via === 'email' ? client?.email ?? '' : client?.number ?? ''));
      if (!to) return fail('VALIDATION_ERROR', `No ${via === 'email' ? 'email address' : 'number'} on file — send \`to\`.`, { param: 'to', requestId: ctx.requestId });
      const { queueMessage, deliverDueMessages } = await import('@/lib/server/messages');
      const message = queueMessage({
        orgId: ctx.orgId,
        clientId: link.clientId,
        channel: via,
        to,
        subject: via === 'email' ? `${link.description} — payment link` : undefined,
        body:
          via === 'email'
            ? `${formatMoney(link.amountMinor, link.currency)} is outstanding. Pay securely here: ${link.url}`
            : `${link.description}: pay ${formatMoney(link.amountMinor, link.currency)} securely here ${link.url}`,
        kind: 'payment_link',
        source: 'dashboard',
        immediate: true,
      });
      markLinkSent(ctx.orgId, link.id, via);
      await deliverDueMessages({ orgId: ctx.orgId, limit: 10 });
      const { get } = await import('@/lib/server/db');
      const after = get<{ id: string; status?: string; reason?: string }>('messages', message.id);
      return ok({ link: linkById(ctx.orgId, link.id), message: after, sent: after?.status === 'sent', reason: after?.reason }, { requestId: ctx.requestId });
    }

    case 'link:cancel': {
      const link = body.linkId ? linkById(ctx.orgId, String(body.linkId)) : undefined;
      if (!link) return fail('NOT_FOUND', 'Which link? Send `linkId`.', { requestId: ctx.requestId });
      const cancelled = cancelLink({ orgId: ctx.orgId, id: link.id, actor, reason: body.reason ? String(body.reason) : undefined });
      if (!cancelled.ok) return bad(cancelled);
      return ok({ link: cancelled.link }, { requestId: ctx.requestId });
    }

    /* -------------------------------------------------------------- expenses */
    case 'expense:create': {
      const created = createExpense({
        orgId: ctx.orgId,
        at: body.at ? String(body.at) : undefined,
        category: body.category ? String(body.category) : undefined,
        supplier: body.supplier ? String(body.supplier) : undefined,
        description: body.description ? String(body.description) : undefined,
        amount: body.amount as never,
        amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
        taxMinor: body.taxMinor !== undefined ? Number(body.taxMinor) : undefined,
        providerId: body.providerId ? String(body.providerId) : undefined,
        reference: body.reference ? String(body.reference) : undefined,
        actor,
        actorName,
      });
      if (!created.ok) return bad(created);
      return ok({ expense: created.value }, { status: 201, requestId: ctx.requestId });
    }

    case 'expense:update': {
      const updated = updateExpense({
        orgId: ctx.orgId,
        id: String(body.expenseId ?? id ?? ''),
        patch: {
          at: body.at ? String(body.at) : undefined,
          category: body.category ? (String(body.category) as never) : undefined,
          supplier: body.supplier !== undefined ? String(body.supplier) : undefined,
          description: body.description !== undefined ? String(body.description) : undefined,
          amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
          taxMinor: body.taxMinor !== undefined ? Number(body.taxMinor) : undefined,
          providerId: body.providerId !== undefined ? String(body.providerId) : undefined,
          reference: body.reference !== undefined ? String(body.reference) : undefined,
        },
        actor,
      });
      if (!updated.ok) return bad(updated);
      return ok({ expense: updated.value }, { requestId: ctx.requestId });
    }

    case 'expense:void': {
      const voided = voidExpense({ orgId: ctx.orgId, id: String(body.expenseId ?? id ?? ''), reason: String(body.reason ?? ''), actor });
      if (!voided.ok) return bad(voided);
      return ok({ expense: voided.value }, { requestId: ctx.requestId });
    }

    /* -------------------------------------------------------------- settings */
    case 'settings': {
      // Only what the caller sent goes into the patch. A screen that changes the
      // payment terms must not blank the invoice prefix on the way past: an
      // explicit `undefined` is a key that exists and holds nothing, and the
      // settings row is read back literally. This pair — here and in
      // `setMoneySettings` — is the fix for that.
      const patch: Partial<MoneySettings> = {};
      if (body.currency !== undefined) patch.currency = String(body.currency);
      if (body.invoicePrefix !== undefined) patch.invoicePrefix = String(body.invoicePrefix);
      if (body.termsDays !== undefined) patch.termsDays = Number(body.termsDays);
      if (body.defaultTaxRatePct !== undefined) patch.defaultTaxRatePct = Number(body.defaultTaxRatePct);
      if (body.taxMode === 'inclusive' || body.taxMode === 'exclusive') patch.taxMode = body.taxMode;
      if (body.autoInvoiceOnComplete !== undefined) patch.autoInvoiceOnComplete = body.autoInvoiceOnComplete === true;
      if (body.footer !== undefined) patch.footer = String(body.footer);
      const next = setMoneySettings(ctx.orgId, patch, actor);
      return ok({ settings: next }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', `Unknown action \`${action}\`. Use create, from-booking, update, issue, void, credit, pay, prepay, refund, apply-credit, void-payment, link:create, link:send, link:cancel, expense:create, expense:update, expense:void or settings.`, {
        param: 'action',
        requestId: ctx.requestId,
      });
  }
}

function originOf(req: NextRequest, body: Record<string, unknown>): string {
  const explicit = body.origin ? String(body.origin) : undefined;
  return explicit ?? publicOrigin(req);
}

