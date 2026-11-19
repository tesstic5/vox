/**
 * Receipts, refunds, and taking back a chase that is no longer true.
 *
 * **Why this file is separate from `money.ts`.** `recordPayment` is the single
 * funnel every pound, dollar and rupee goes through — the desk, the sandbox pay
 * page, the Stripe webhook — and it is the only place that can be sure a receipt
 * is written once. So `money.ts` calls in here. It cannot be the other way round:
 * `payments.ts` and `money-chase.ts` both import `money.ts`, and a module that
 * `money.ts` imported back would close a cycle. Everything here therefore takes
 * **plain values** — an amount in minor units, a currency, invoice numbers, a
 * balance — and none of it imports `money.ts`.
 *
 * What it is for:
 *
 *   · **A receipt.** Somebody pays and hears nothing; that is the defect this
 *     closes. The message carries what was received, what is left owing, and —
 *     when a payment link is already open for the invoice — the way to pay it.
 *   · **A refund notice.** Money going back is money the client is watching for.
 *   · **`cancelPendingChases`.** A chase that says "you still owe $240" must not
 *     go out an hour after the bill was paid. Cancelling is the same job as
 *     queueing, from the other end.
 */

import { get, list, update, type Doc } from './db';
import { audit } from './audit';
import { consentFor, type ClientDoc } from './clients';
import { formatMoney } from './money-format';
import {
  contactFor,
  messagesFor,
  cancelMessage,
  messagingSettings,
  queueMessage,
  type MessageChannel,
  type MessageDoc,
} from './messages';
import { houseDefaultTemplate, renderFor, type MergeContext } from './templates';

/** What `recordPayment` tells us. Deliberately primitives-only — see the note above. */
export type PaymentNotice = {
  orgId: string;
  clientId: string;
  clientName: string;
  paymentId: string;
  /** `payment`, `prepayment`, `credit` or `refund` — the money kind, as the ledger calls it. */
  kind: string;
  amountMinor: number;
  currency: string;
  method: string;
  /** Every invoice this money touched, in the order it was applied. */
  invoices: { id: string; number?: string; balanceMinor: number }[];
  /** Money left on the account after this (a prepayment, or a payment of more than was owed). */
  unallocatedMinor?: number;
  at?: string;
};

/* ------------------------------------------------------------------- contact */

type Contact = { channel: MessageChannel; to: string; blockedReason?: string };

/* -------------------------------------------------------------- money words */

/**
 * What is left owing, as a whole sentence.
 *
 * Written here rather than in a template field so that every branch is true:
 * a settled invoice says so, a part-paid one names the figure, and money left on
 * account is described as money on account rather than as a debt. A template gets
 * `{{balance_line}}` and can put it anywhere.
 */
export function balanceLine(input: {
  currency: string;
  invoices: { number?: string; balanceMinor: number }[];
  unallocatedMinor?: number;
}): string {
  const names = input.invoices.map((i) => i.number).filter(Boolean).join(', ');
  const owing = input.invoices.reduce((sum, i) => sum + Math.max(0, i.balanceMinor), 0);
  const onAccount = Math.max(0, Number(input.unallocatedMinor ?? 0));
  // One bill is "INV-0012 is settled"; two are "INV-0012, INV-0013 are settled".
  const verb = input.invoices.filter((i) => i.number).length > 1 ? 'are' : 'is';

  if (owing > 0) {
    return `${formatMoney(owing, input.currency)} is still due${names ? ` on ${names}` : ''}.`;
  }
  if (onAccount > 0) {
    return `${formatMoney(onAccount, input.currency)} now sits on your account.`;
  }
  if (names) return `${names} ${verb} settled.`;
  return 'Your account is settled.';
}

/** `INV-0012`, or `INV-0012, INV-0013` — what the message calls the bill. */
function invoiceNames(invoices: { number?: string }[]): string {
  const names = invoices.map((i) => String(i.number ?? '')).filter(Boolean);
  if (!names.length) return 'your account';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** An invoice's due date is a calendar date in the books; format it as one. */
export function dueDateWords(dueDate: string): string {
  const at = Date.parse(`${dueDate}T12:00:00Z`);
  if (!Number.isFinite(at)) return dueDate;
  // UTC on purpose: a due date is the day it says on the page, and rendering it
  // in a site's timezone can knock it back a day for anybody west of it.
  return new Date(at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/* ---------------------------------------------------------------- rendering */

type MoneyMessage = {
  orgId: string;
  kind: 'receipt' | 'refund' | 'overdue';
  channel: MessageChannel;
  context: MergeContext;
};

/**
 * Renders one money message through the workspace's own templates.
 *
 * A workspace with no stored wording for the job still gets the house sentence —
 * the same one `seedTemplatesForOrg` would have written — because it is the
 * merge fields that make a receipt a receipt ("$120.00 for INV-0012, $80.00 still
 * due"), and a bare "thank you" taught the client nothing. One copy of that
 * wording, in `templates.ts`, so the two can never disagree.
 */
export function renderMoneyMessage(input: MoneyMessage) {
  const house = houseDefaultTemplate(input.kind, input.channel, input.orgId);
  const rendered = renderFor({
    orgId: input.orgId,
    kind: input.kind,
    channel: input.channel,
    context: input.context,
    fallback: house?.body,
    fallbackSubject: house?.subject,
  });
  return { body: rendered.body, subject: rendered.subject, templateId: rendered.templateId, houseWording: rendered.usedFallback };
}

/** The merge values every money message shares — receipts, refunds and chases. */
export function moneyContext(input: {
  orgId: string;
  clientName?: string;
  amountMinor: number;
  currency: string;
  invoices: { number?: string; balanceMinor: number }[];
  unallocatedMinor?: number;
  dueDate?: string;
  payLink?: string;
}): MergeContext {
  const org = get<Doc & { name?: string }>('orgs', input.orgId);
  const first = String(input.clientName ?? '').split(/\s+/)[0] || 'there';
  return {
    client_first_name: first,
    client_name: input.clientName ?? '',
    business: String(org?.name ?? 'the practice'),
    amount: formatMoney(input.amountMinor, input.currency),
    invoice_number: invoiceNames(input.invoices),
    due_date: input.dueDate ? dueDateWords(input.dueDate) : '',
    balance_line: balanceLine({
      currency: input.currency,
      invoices: input.invoices.map((i) => ({ number: i.number, balanceMinor: i.balanceMinor })),
      unallocatedMinor: input.unallocatedMinor,
    }),
    pay_link: input.payLink ?? '',
  };
}

/* ------------------------------------------------------------------ receipts */

/**
 * The message a payment earns, or `null` when this kind of money does not get one.
 *
 * `credit` gets nothing: applying credit to an invoice moves money the client
 * already paid and already heard about. A second "we have received it" would be a
 * lie about when it arrived.
 */
export type ReceiptResult = { queued: boolean; kind?: 'receipt' | 'refund'; messageId?: string; blocked?: string; reason?: string };

export function queuePaymentNotice(input: PaymentNotice): ReceiptResult {
  if (input.kind === 'credit') return { queued: false, reason: 'credit is not new money — no receipt' };
  const kind: 'receipt' | 'refund' = input.kind === 'refund' ? 'refund' : 'receipt';

  const client = get<ClientDoc>('clients', input.clientId);
  const contact = contactFor(input.orgId, { clientId: input.clientId, number: client?.number, email: client?.email });
  if (!contact) {
    // Not a failure: a practice can take cash from somebody it has no address for,
    // and the desk can see there was nowhere to send the receipt.
    audit({
      orgId: input.orgId,
      actor: 'system',
      action: 'receipt.no_contact',
      target: input.paymentId,
      detail: `${formatMoney(input.amountMinor, input.currency)} — no number or email on file for ${input.clientName}`,
    });
    return { queued: false, reason: 'no number or email on file' };
  }

  // A payment link we already made for this invoice is the link the receipt
  // carries. Nothing is created here: a receipt must not be the thing that
  // silently opens a checkout session with the practice's provider.
  const { linkForInvoice } = openLinkLookup(input.orgId, input.invoices.map((i) => i.id));
  const owing = input.invoices.some((i) => i.balanceMinor > 0);
  const context = moneyContext({
    orgId: input.orgId,
    clientName: input.clientName,
    amountMinor: input.amountMinor,
    currency: input.currency,
    invoices: input.invoices,
    unallocatedMinor: input.unallocatedMinor,
    payLink: owing ? linkForInvoice : undefined,
  });

  const rendered = renderMoneyMessage({ orgId: input.orgId, kind, channel: contact.channel, context });

  const message = queueMessage({
    orgId: input.orgId,
    channel: contact.channel,
    to: contact.to,
    clientId: input.clientId,
    subject: rendered.subject,
    body: rendered.body,
    kind,
    source: kind === 'refund' ? 'refund' : 'payment',
    // A receipt acknowledges something that has already happened, so it is due
    // immediately — the next delivery tick sends it. It still respects the
    // workspace's quiet hours: a receipt at 3am is still a text at 3am.
    meta: {
      kind,
      paymentId: input.paymentId,
      invoiceIds: input.invoices.map((i) => i.id).join(','),
      invoiceId: input.invoices[0]?.id ?? '',
      amountMinor: String(input.amountMinor),
      templateId: rendered.templateId ?? '',
    },
  });

  return { queued: true, kind, messageId: message.id, blocked: message.status === 'blocked' ? message.reason : undefined };
}

/**
 * The newest link already open for one of these invoices, if there is one.
 *
 * `payments.ts` owns links, and importing it here would be the cycle this file
 * exists to avoid — so this reads the rows it needs. The contract is a value, not
 * a module: an open link, for an invoice we just touched, not expired.
 */
function openLinkLookup(orgId: string, invoiceIds: string[]): { linkForInvoice?: string } {
  const wanted = new Set(invoiceIds);
  type LinkRow = Doc & { orgId?: string; invoiceId?: string; status?: string; url?: string; expiresAt?: string; createdAt?: string };
  const open = list<LinkRow>('paymentLinks', (l) => l.orgId === orgId && wanted.has(String(l.invoiceId)))
    .filter((l) => l.status === 'open' && Date.parse(String(l.expiresAt)) > Date.now())
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { linkForInvoice: open[0]?.url ? String(open[0].url) : undefined };
}

/* --------------------------------------------------------------- the chase */

/** Chase rows still waiting to go out for one invoice. */
export function pendingChasesFor(orgId: string, invoiceId: string): MessageDoc[] {
  return messagesFor(
    orgId,
    (m) => m.kind === 'overdue' && m.status === 'pending' && String(m.meta?.invoiceIds ?? '').split(',').includes(invoiceId)
  );
}

/**
 * Takes back a chase that is no longer true.
 *
 * Called from every path that moves an invoice's balance — a payment, a credit
 * note, a void — because the alternative is a text that says "you still owe $240"
 * arriving an hour after the client paid it. Cancelled, never deleted: the record
 * of what was about to be sent is exactly what a practice needs when somebody
 * rings up annoyed.
 */
export function cancelPendingChases(orgId: string, invoiceId: string, why: string): number {
  let cancelled = 0;
  for (const message of pendingChasesFor(orgId, invoiceId)) {
    const done = cancelMessage(orgId, message.id, 'system', why);
    if (done) cancelled += 1;
  }
  if (cancelled) {
    audit({
      orgId,
      actor: 'system',
      action: 'invoice.chase_withdrawn',
      target: invoiceId,
      detail: `${cancelled} unsent chase(s) taken back — ${why}`,
    });
  }
  return cancelled;
}

/** Refresh a queued chase's wording in place when the balance behind it moved. */
export function refreshChase(orgId: string, message: MessageDoc, body: string, subject?: string): boolean {
  if (message.body === body && (message.subject ?? undefined) === (subject ?? undefined)) return false;
  update<MessageDoc>('messages', message.id, { body, subject, updatedAt: new Date().toISOString() } as never);
  audit({ orgId, actor: 'system', action: 'invoice.chase_updated', target: message.id, detail: 'the balance changed before it went out' });
  return true;
}
