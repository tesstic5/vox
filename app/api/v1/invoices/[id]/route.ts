import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { accessLogFor, actorLabel, recordView } from '@/lib/server/access-log';
import { list } from '@/lib/server/db';
import {
  balanceMinorOf,
  canEditMoney,
  canReadMoney,
  creditOnAccountMinor,
  formatMoney,
  invoiceById,
  moneySettingsFor,
  paymentsFor,
  clientBalance,
} from '@/lib/server/money';
import { linksFor, paymentProviderFor, publicLinkView, type PaymentLinkDoc } from '@/lib/server/payments';
import { clientById } from '@/lib/server/clients';
import { bookingById } from '@/lib/server/bookings';
import { chaseRowsFor, chaseStateFor } from '@/lib/server/money-chase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One invoice, as a document: its lines, what has been paid against it, the credit
 * notes that reduced it, the links that asked for the money, and the record's own
 * access log — who has looked at it, who has changed it.
 *
 * A read is logged against the invoice (the same rule the client record and the
 * note follow). Roles that may not read the books are refused outright rather
 * than shown a redacted one: there is no useful redaction of an invoice.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!(ctx.auth === 'key' || canReadMoney(ctx.user?.role))) {
    return fail('FORBIDDEN', 'This role cannot read the practice books.', { requestId: ctx.requestId });
  }
  const invoice = invoiceById(ctx.orgId, id);
  if (!invoice) return fail('NOT_FOUND', `No invoice with id ${id}.`, { requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  // Opening an invoice is a read of a financial record, and it is written down.
  recordView({ orgId: ctx.orgId, resource: 'invoice', resourceId: invoice.id, actor, actorName });
  const payments = paymentsFor(ctx.orgId, { invoiceId: invoice.id });
  const credits = (await import('@/lib/server/money')).invoicesFor(ctx.orgId, { includeVoid: true }).filter((i) => i.creditedInvoiceId === invoice.id);
  const links = linksFor(ctx.orgId, { invoiceId: invoice.id });
  const client = clientById(ctx.orgId, invoice.clientId);

  return ok(
    {
      invoice: {
        ...invoice,
        balanceMinor: balanceMinorOf(invoice),
        totalFormatted: formatMoney(invoice.totalMinor, invoice.currency),
        balanceFormatted: formatMoney(balanceMinorOf(invoice), invoice.currency),
      },
      client: client ? { id: client.id, name: client.name, email: client.email, number: client.number } : undefined,
      appointments: invoice.bookingIds.map((bookingId) => {
        const booking = bookingById(ctx.orgId, bookingId);
        return booking ? { id: booking.id, startsAt: booking.startsAt, service: booking.service, status: booking.status } : { id: bookingId, missing: true };
      }),
      payments,
      creditNotes: credits,
      links: links.map((link) => ({ ...link, view: publicLinkView(link.token) })),
      /**
       * What the client has been told about this bill, and what is next.
       *
       * A practice chasing money should be able to see, on the bill itself, the
       * texts and emails that have gone out about it — and the schedule that will
       * send the rest. Without this the only honest answer to "why are they
       * annoyed?" is a guess.
       */
      notices: chaseRowsFor(ctx.orgId, invoice.id).map((row) => ({
        id: row.id,
        kind: row.kind,
        channel: row.channel,
        to: row.to,
        status: row.status,
        reason: row.reason,
        body: row.body,
        subject: row.subject,
        at: row.status === 'sent' ? row.updatedAt ?? row.createdAt : row.sendAt,
        sentAt: row.status === 'sent' ? row.updatedAt : undefined,
        step: row.meta?.offsetDays !== undefined ? Number(row.meta.offsetDays) : undefined,
      })),
      chase: chaseStateFor(ctx.orgId, invoice.id),
      account: { ...clientBalance(ctx.orgId, invoice.clientId), creditOnAccountMinor: creditOnAccountMinor(ctx.orgId, invoice.clientId) },
      access: accessLogFor(ctx.orgId, 'invoice', invoice.id, 50),
      // The workspace trail rows that concern this invoice, newest first. Audit
      // rows carry `at`, not `createdAt` — a mapping that forgets that sorts nothing.
      audit: list<{ id: string; action: string; actor: string; detail?: string; at?: string; createdAt?: string }>('audit', (row) => {
        const target = String((row as { target?: string }).target ?? '');
        return String((row as { orgId?: string }).orgId) === ctx.orgId && (target === invoice.id || invoice.bookingIds.includes(target));
      })
        .map((row) => ({ id: row.id, action: row.action, actor: row.actor, detail: row.detail, at: row.at ?? row.createdAt }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 25),
      permissions: {
        canEdit: ctx.auth === 'key' || canEditMoney(ctx.user?.role),
        canIssue: invoice.status === 'draft',
        canCredit: invoice.status === 'issued' || invoice.status === 'partly_paid' || invoice.status === 'overdue' || invoice.status === 'paid',
        canVoid: invoice.status !== 'void' && invoice.status !== 'draft' && Number(invoice.paidMinor ?? 0) === 0,
        canRefund: payments.some((p) => p.direction === 'in' && p.status === 'settled'),
      },
      currency: moneySettingsFor(ctx.orgId).currency,
      provider: paymentProviderFor(ctx.orgId),
      actor: { actor, actorName },
      /** Links the checkout page can be opened from, straight from the payload. */
      openLinks: links.filter((l) => l.status === 'open').map((l: PaymentLinkDoc) => ({ id: l.id, url: l.url, amountMinor: l.amountMinor })),
    },
    { requestId: ctx.requestId }
  );
}
