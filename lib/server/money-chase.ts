/**
 * The overdue chase — the loop behind "we billed it" becoming "we got paid".
 *
 * Until now `money.ts` could *compute* what was overdue and the public pay page
 * could take the money, but nothing ever asked. This module is the asking: a
 * schedule the practice sets, one message per step per invoice, ever, with the pay
 * link in it.
 *
 * Three decisions worth keeping in mind, because they are the difference between a
 * chase and a nuisance:
 *
 *   1. **One step per invoice, fired at catch-up, is the *latest* eligible step.**
 *      If the scheduler was off for a week and the practice turns the rule on for a
 *      bill that is 30 days late, steps −3, 0, 7 and 21 are all "eligible" — and
 *      sending all four at once is how a practice gets a complaint. It sends the
 *      newest one (+21) and considers the rest spent.
 *   2. **The balance is re-read before every send.** A chase queued this morning
 *      and going out this evening carries tonight's figure, not this morning's. A
 *      part payment in between rewrites the row rather than sending a lie.
 *   3. **Paying takes back the chase.** Every path that moves an invoice's balance
 *      goes through `cancelPendingChases`, so the classic "I paid it yesterday"
 *      text cannot happen.
 *
 * It also owns the *reading* side — `chaseStateFor`, which the invoice screen
 * prints as "what we have sent them, and what is next". A practice should never
 * have to guess why a client is annoyed.
 */

import { list, type Doc } from './db';
import { audit } from './audit';
import { cancelMessage, messagesFor, messagingTimezone, queueMessage, type MessageChannel, type MessageDoc } from './messages';
import { outreachRules } from './outreach-rules';
import { dateStrIn } from './availability';
import { balanceMinorOf, formatMoney, invoiceById, refreshOverdue, type InvoiceDoc } from './money';
import { linksFor } from './payments';
import { clientById } from './clients';
import { contactFor } from './messages';
import { moneyContext, refreshChase, renderMoneyMessage } from './receipts';

/** Whole days from `dueDate` to `today`, both `YYYY-MM-DD`, in the books' own dates. */
export function daysSinceDue(dueDate: string, today: string): number {
  const a = Date.parse(`${dueDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Which step of the schedule a bill is on today.
 *
 * The latest offset that has arrived — see note 1 at the top of this file. `null`
 * when the schedule has not started yet (the bill is still ahead of its first
 * nudge), which is the honest answer rather than `undefined` or `-Infinity`.
 */
export function stepFor(offsetsDays: number[], days: number): number | null {
  const sorted = [...offsetsDays].sort((a, b) => a - b);
  const arrived = sorted.filter((offset) => days >= offset);
  return arrived.length ? arrived[arrived.length - 1] : null;
}

/**
 * The link to pay this invoice with.
 *
 * An existing open link, or nothing.
 *
 * Reusing is the point: a link is a claim on an invoice for a fixed amount, and a
 * second one for the same balance is how a client lands on a checkout page for a
 * figure that is no longer right. Nothing is *created* here — a chase must not be
 * the thing that opens a checkout session with the practice's provider behind the
 * desk's back. With no link to carry, the template's link line is dropped whole
 * and the message still reads as a sentence.
 */
export function payLinkFor(orgId: string, invoiceId: string): string | undefined {
  const open = linksFor(orgId, { invoiceId, status: 'open' }).filter((l) => Date.parse(String(l.expiresAt)) > Date.now());
  // An existing link is the right link: it is a claim on *this* invoice's balance,
  // and the pay page reads the live figure when it is opened. Nothing is created
  // here — `createPaymentLink` is async and may open a checkout session with the
  // practice's provider, and a chase must not be the thing that does that behind
  // the desk's back. With no link and no public address, the template's link line
  // is dropped whole and the message still makes sense.
  return open.length ? String(open[0].url) : undefined;
}

export type ChaseRun = {
  orgId: string;
  /** Chases queued this run. */
  queued: number;
  /** Queued chases whose wording was corrected before they went out. */
  refreshed: number;
  /** Unsent chases taken back because the bill moved. */
  withdrawn: number;
  /** Steps that had already gone out. */
  alreadySent: number;
  skipped?: string;
};

/**
 * The job. Idempotent by construction: one message per (invoice, step), ever, and
 * every pass first repairs what the last one left behind.
 */
export function queueOverdueChases(now = Date.now(), orgId?: string): ChaseRun {
  const rules = orgId ? outreachRules(orgId) : undefined;
  const orgs = orgId ? [orgId] : list<Doc & { id: string }>('orgs').map((o) => o.id); 
  const run: ChaseRun = { orgId: orgId ?? '*', queued: 0, refreshed: 0, withdrawn: 0, alreadySent: 0 };

  for (const currentOrg of orgs) {
    const orgRules = rules ?? outreachRules(currentOrg);
    // Past-due invoices are a fact about the diary of money, not about messaging:
    // mark them either way, so the desk's lists are right even with the chase off.
    refreshOverdue(currentOrg, new Date(now));
    if (!orgRules.overdue.enabled || !orgRules.overdue.offsetsDays.length) {
      if (orgId) run.skipped = 'the chase is switched off for this workspace';
      continue;
    }

    const tz = messagingTimezone(currentOrg);
    const today = dateStrIn(tz);
    const open = list<InvoiceDoc>('invoices', (i) => i.orgId === currentOrg).filter(
      (i) => i.kind === 'invoice' && ['issued', 'partly_paid', 'overdue'].includes(String(i.status)) && Boolean(i.dueDate)
    );

    for (const invoice of open) {
      const balance = balanceMinorOf(invoice);
      const existing = chaseRowsFor(currentOrg, invoice.id);

      // --- the bill is settled: take back anything we were about to say about it
      if (balance <= 0) {
        for (const row of existing.filter((m) => m.status === 'pending')) {
          cancelMessage(currentOrg, row.id, 'system', 'settled before it went out');
          run.withdrawn += 1;
        }
        continue;
      }

      const days = daysSinceDue(String(invoice.dueDate), today);
      const step = stepFor(orgRules.overdue.offsetsDays, days);
      if (step === null) continue;

      const stepRow = existing.find((m) => String(m.meta?.offsetDays) === String(step));
      const client = invoice.clientId ? clientById(currentOrg, invoice.clientId) : undefined;
      const payLink = payLinkFor(currentOrg, invoice.id);
      const context = moneyContext({
        orgId: currentOrg,
        clientName: client?.name ?? invoice.clientName,
        amountMinor: balance,
        currency: invoice.currency,
        // A chase is about one bill, and `invoice_number` reads `INV-0012` only
        // when there is one — the shared vocabulary keeps that naming in one place.
        invoices: [{ number: invoice.number, balanceMinor: balance }],
        dueDate: String(invoice.dueDate),
        payLink,
      });

      if (stepRow) {
        // The step has already gone out — unless it is still waiting, in which case
        // it must carry tonight's figure rather than this morning's.
        if (stepRow.status === 'pending') {
          const contact = contactFor(currentOrg, { clientId: invoice.clientId, number: client?.number, email: client?.email }, orgRules.overdue.channels);
          const rendered = renderMoneyMessage({
            orgId: currentOrg,
            kind: 'overdue',
            channel: (contact?.channel ?? stepRow.channel) as MessageChannel,
            context,
          });
          if (refreshChase(currentOrg, stepRow, rendered.body, rendered.subject)) run.refreshed += 1;
        } else {
          run.alreadySent += 1;
        }
        continue;
      }

      const contact = contactFor(currentOrg, { clientId: invoice.clientId, number: client?.number, email: client?.email }, orgRules.overdue.channels);
      if (!contact) {
        audit({
          orgId: currentOrg,
          actor: 'system',
          action: 'invoice.chase_skipped',
          target: invoice.id,
          detail: `${invoice.number ?? invoice.id} is ${String(invoice.status)} — no number or email to chase on`,
        });
        continue;
      }

      const rendered = renderMoneyMessage({ orgId: currentOrg, kind: 'overdue', channel: contact.channel, context });

      queueMessage({
        orgId: currentOrg,
        channel: contact.channel,
        to: contact.to,
        clientId: invoice.clientId,
        subject: rendered.subject,
        body: rendered.body,
        kind: 'overdue',
        source: 'invoice-chase',
        meta: {
          kind: 'overdue',
          invoiceId: invoice.id,
          invoiceIds: invoice.id,
          offsetDays: String(step),
          outstandingMinor: String(balance),
          templateId: rendered.templateId ?? '',
        },
      });
      audit({
        orgId: currentOrg,
        actor: 'system',
        action: 'invoice.chase_queued',
        target: invoice.id,
        detail: `${invoice.number ?? invoice.id} — step ${step >= 0 ? `+${step}` : step}d, ${formatMoney(balance, invoice.currency)} outstanding`,
      });
      run.queued += 1;
    }
  }
  return run;
}

/** Every chase row ever written for one invoice, newest first. */
export function chaseRowsFor(orgId: string, invoiceId: string): MessageDoc[] {
  return messagesFor(orgId, (m) => m.kind === 'overdue' && m.meta?.invoiceId === invoiceId).sort((a, b) =>
    String(a.meta?.offsetDays ?? '').localeCompare(String(b.meta?.offsetDays ?? ''))
  );
}

/**
 * What the invoice screen prints: the schedule, what has gone, and what is next.
 *
 * Computed from the same rule the job runs on, so the screen and the scheduler
 * cannot disagree about when the next text is due.
 */
export function chaseStateFor(orgId: string, invoiceId: string, now = Date.now()) {
  const invoice = invoiceById(orgId, invoiceId);
  if (!invoice) return undefined;
  const rules = outreachRules(orgId);
  const tz = messagingTimezone(orgId);
  const today = dateStrIn(tz, now);
  const balance = balanceMinorOf(invoice);
  const rows = chaseRowsFor(orgId, invoiceId);

  const steps = rules.overdue.offsetsDays
    .map((offset) => {
      const row = rows.find((m) => String(m.meta?.offsetDays) === String(offset));
      const at = invoice.dueDate ? new Date(Date.parse(`${invoice.dueDate}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10) : undefined;
      return {
        offsetDays: offset,
        label: offset === 0 ? 'on the due date' : offset < 0 ? `${Math.abs(offset)} days before` : `${offset} days after`,
        on: at,
        sent: row ? row.status === 'sent' || row.status === 'pending' : false,
        state: row ? (row.status === 'sent' ? 'sent' : row.status === 'pending' ? 'queued' : 'withdrawn') : 'planned',
        at: row?.sendAt ?? at,
      };
    })
    .filter((s) => s.state !== 'planned' || s.on === undefined || s.on >= today);

  const next = steps.find((s) => s.state === 'planned');
  return {
    enabled: rules.overdue.enabled,
    channels: rules.overdue.channels,
    offsetsDays: rules.overdue.offsetsDays,
    balanceMinor: balance,
    settled: balance <= 0,
    steps,
    nextAt: next?.on,
    nextLabel: next?.label,
    /** Plain words for the screen — including "nothing, because it is paid". */
    summary: !rules.overdue.enabled
      ? 'Chasing is switched off for this workspace.'
      : balance <= 0
        ? rows.length
          ? `Settled — ${rows.length} message(s) went out about this bill.`
          : 'Settled — nothing was ever sent about this bill.'
        : rows.length
          ? `${rows.filter((r) => r.status !== 'cancelled').length} of ${rules.overdue.offsetsDays.length} step(s) used${next ? ` — next ${next.on}` : ' — none left'}.`
          : `Nothing sent yet${next ? ` — the first goes ${next.on}` : ''}.`,
  };
}
