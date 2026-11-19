'use client';

/**
 * Money.
 *
 * Three questions, three tabs, and — this is the part that matters — nothing on
 * screen that a desk cannot act on:
 *
 *   - **Overview** — what has been billed, what has been collected, what is still
 *     owed (split out into "overdue"), what the practice spent, and who earned
 *     what. Every figure is derived from the ledger rows below it.
 *   - **Invoices** — the documents themselves. A draft is edited and issued; an
 *     invoice is a document, so from there it can be paid, credited or voided, and
 *     a payment link can be sent. Take-money is open to the desk; adjusting what
 *     is owed is the practice owner's.
 *   - **Expenses** — the other half of the books, because a practice that cannot
 *     see its costs cannot see its profit.
 *
 * Amounts arrive from the API in integer minor units and are formatted with the
 * workspace's own currency — never re-derived in the browser, which is how a cent
 * goes missing between screens.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { cn, fmtDate } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '@/components/icons';
import { Button, CopyButton, EmptyState, Modal, Pill, Tabs, useToast } from '@/components/ui';
import { DataTable, StatCard } from '@/components/dash/bits';
import { PageHeader } from '@/components/dash/Shell';

type InvoiceLine = { id: string; description: string; qty: number; unitAmountMinor: number; taxRatePct: number; netMinor: number; discountMinor: number; taxMinor: number; grossMinor: number };
type Invoice = {
  id: string;
  kind: 'invoice' | 'credit';
  number?: string;
  status: 'draft' | 'issued' | 'partly_paid' | 'paid' | 'overdue' | 'void';
  clientId: string;
  clientName?: string;
  currency: string;
  lines: InvoiceLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
  issueDate?: string;
  dueDate?: string;
  voidReason?: string;
  creditedInvoiceId?: string;
  notes?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

type Payment = {
  id: string;
  clientId: string;
  clientName?: string;
  kind: 'payment' | 'prepayment' | 'refund' | 'credit';
  method: string;
  direction: 'in' | 'out';
  amountMinor: number;
  currency: string;
  at: string;
  status: 'settled' | 'void';
  allocations: { invoiceId: string; amountMinor: number }[];
  unallocatedMinor: number;
  reference?: string;
  voidReason?: string;
};

type Expense = {
  id: string;
  at: string;
  category: string;
  supplier?: string;
  description?: string;
  amountMinor: number;
  taxMinor: number;
  currency: string;
  status: 'active' | 'void';
  reference?: string;
};

type LinkRow = {
  id: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  provider: 'stripe' | 'sandbox';
  url: string;
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  createdAt: string;
  expiresAt: string;
  sentAt?: string;
  sentVia?: string;
  paidAt?: string;
  description: string;
};

type Overview = {
  currency: string;
  invoicedMinor: number;
  collectedMinor: number;
  refundedMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  expensesMinor: number;
  netMinor: number;
  counts: { invoices: number; drafts: number; paid: number; overdue: number; payments: number; expenses: number };
  byProvider: { providerId: string; providerName: string; invoicedMinor: number; collectedMinor: number; outstandingMinor: number; appointments: number }[];
  byCategory: { category: string; amountMinor: number }[];
  recent: { id: string; at: string; kind: string; reference: string; clientName?: string; amountMinor: number; currency: string }[];
  settings: { currency: string; invoicePrefix: string; termsDays: number; defaultTaxRatePct: number; taxMode: string; autoInvoiceOnComplete: boolean; footer?: string };
  provider: { driver: 'stripe' | 'sandbox'; reason: string; mode?: string };
  links: { open: number; paid: number; expired: number; openValueMinor: number; sent: number };
  paymentTypes: { id: string; name: string; kind: string; code?: string }[];
};

type InvoiceDetail = {
  invoice: Invoice & { totalFormatted: string; balanceFormatted: string };
  client?: { id: string; name: string; email?: string; number?: string };
  appointments: { id: string; startsAt?: string; service?: string; status?: string; missing?: boolean }[];
  payments: Payment[];
  creditNotes: Invoice[];
  links: LinkRow[];
  account: { dueMinor: number; creditMinor: number; balanceMinor: number; currency: string };
  access: { id: string; action: string; actor: string; actorName?: string; detail?: string; at: string }[];
  audit: { id: string; action: string; actor: string; detail?: string; at?: string }[];
  /** The texts and emails that have gone out about this bill, newest first. */
  notices: {
    id: string;
    kind: string;
    channel: string;
    to: string;
    status: string;
    reason?: string;
    body: string;
    subject?: string;
    at: string;
    sentAt?: string;
    step?: number;
  }[];
  /** The chase schedule: what has gone, what is next, or why nothing is. */
  chase?: {
    enabled: boolean;
    offsetsDays: number[];
    settled: boolean;
    summary: string;
    nextAt?: string;
    nextLabel?: string;
    steps: { offsetDays: number; label: string; on?: string; state: string; at?: string }[];
  };
  permissions: { canEdit: boolean; canIssue: boolean; canCredit: boolean; canVoid: boolean; canRefund: boolean };
  provider: { driver: 'stripe' | 'sandbox'; reason: string };
  actor: { actor: string };
};

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format((minor ?? 0) / 100);
  } catch {
    return `${currency} ${((minor ?? 0) / 100).toFixed(2)}`;
  }
};

/**
 * What each state is called on screen.
 *
 * "partly paid" is fine in a database and clumsy on a screen a receptionist
 * reads forty times a day, so the words here are the ones a practice actually
 * uses — with the meaning spelled out on hover, because "issued" is exactly the
 * kind of word that makes somebody ask what they are supposed to do next.
 */
const STATUS_WORDS: Record<string, { label: string; hint: string }> = {
  draft: { label: 'Draft', hint: 'Not sent yet — edit it freely, then issue it to give it a number.' },
  issued: { label: 'Awaiting payment', hint: 'Sent to the client, with the number on it. Nothing more to do until it is paid.' },
  partly_paid: { label: 'Part paid', hint: 'Some money has come in. The balance is what is still owed.' },
  paid: { label: 'Paid in full', hint: 'Settled. Corrections happen with a credit note, not by editing this.' },
  overdue: { label: 'Overdue', hint: 'Past its due date and still unpaid — the list worth chasing.' },
  void: { label: 'Cancelled', hint: 'Voided with a reason. Kept for the record, counted nowhere.' },
};

const STATUS_TONE: Record<string, 'default' | 'brand' | 'warn' | 'danger' | 'info'> = {
  draft: 'default',
  issued: 'info',
  partly_paid: 'warn',
  overdue: 'danger',
  paid: 'brand',
  void: 'default',
};

export default function MoneyPage() {
  const toast = useToast();
  const [tab, setTab] = React.useState<'overview' | 'invoices' | 'payments' | 'expenses'>('overview');
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [invoices, setInvoices] = React.useState<Invoice[]>([]);
  const [stats, setStats] = React.useState<{ currency: string; outstandingMinor: number; overdueMinor: number; drafts: number; invoicedMinor: number } | null>(null);
  const [payments, setPayments] = React.useState<Payment[]>([]);
  const [links, setLinks] = React.useState<LinkRow[]>([]);
  const [expenses, setExpenses] = React.useState<Expense[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState<'open' | 'all' | 'overdue' | 'paid' | 'drafts'>('open');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<InvoiceDetail | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [expenseOpen, setExpenseOpen] = React.useState(false);
  const [packLiability, setPackLiability] = React.useState<{ packs: number; placesOutstanding: number; valueHeldMinor: number; currency: string } | null>(null);

  const fail = (error: unknown) => toast(error instanceof ApiError ? error.message : 'Something went wrong', 'error');

  const load = React.useCallback(async () => {
    try {
      const [o, list, pay, link, exp] = await Promise.all([
        request<Overview>('GET', '/api/v1/invoices?view=overview'),
        request<{ data: Invoice[]; stats: { currency: string; outstandingMinor: number; overdueMinor: number; drafts: number; invoicedMinor: number } }>('GET', '/api/v1/invoices?include=all'),
        request<{ data: Payment[] }>('GET', '/api/v1/invoices?view=payments'),
        request<{ data: LinkRow[] }>('GET', '/api/v1/invoices?view=links'),
        request<{ data: Expense[] }>('GET', '/api/v1/invoices?view=expenses'),
      ]);
      setOverview(o);
      void request<{ liability: { packs: number; placesOutstanding: number; valueHeldMinor: number; currency: string } }>('GET', '/api/v1/packs')
        .then((r) => setPackLiability(r.liability))
        .catch(() => undefined);
      setInvoices(list.data);
      setStats(list.stats);
      setPayments(pay.data);
      setLinks(link.data);
      setExpenses(exp.data);
    } catch (error) {
      fail(error);
    }
  }, [toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openInvoice = React.useCallback(
    async (id: string) => {
      setOpenId(id);
      setDetail(null);
      try {
        setDetail(await request<InvoiceDetail>('GET', `/api/v1/invoices/${id}`));
      } catch (error) {
        fail(error);
      }
    },
    [toast]
  );

  const act = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      await request('POST', '/api/v1/invoices', body);
      toast(success, 'success');
      await load();
      if (openId) await openInvoice(openId);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const currency = stats?.currency ?? overview?.currency ?? 'USD';
  const shown = invoices.filter((i) => {
    if (filter === 'open') return ['issued', 'partly_paid', 'overdue'].includes(i.status);
    if (filter === 'overdue') return i.status === 'overdue';
    if (filter === 'paid') return i.status === 'paid';
    if (filter === 'drafts') return i.status === 'draft';
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Money"
        desc="Invoices from visits, what has been paid, what is still owed, and what the practice spent."
        actions={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setExpenseOpen(true)}>
              <Icons.plus size={14} /> Expense
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setNewOpen(true)}>
              <Icons.plus size={14} /> New invoice
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'invoices', label: 'Invoices' },
          { id: 'payments', label: 'Payments' },
          { id: 'expenses', label: 'Expenses' },
        ]}
        active={tab}
        onChange={(next) => setTab(next as typeof tab)}
      />

      {tab === 'overview' && overview && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Billed" value={money(overview.invoicedMinor, currency)} sub={`${overview.counts.invoices} invoice(s) · ${overview.counts.drafts} draft`} />
            <StatCard label="Collected" value={money(overview.collectedMinor, currency)} sub={`${overview.counts.payments} payment(s)${overview.refundedMinor ? ` · ${money(overview.refundedMinor, currency)} refunded` : ''}`} />
            <StatCard label="Outstanding" value={money(overview.outstandingMinor, currency)} sub={overview.overdueMinor ? `${money(overview.overdueMinor, currency)} overdue` : 'nothing overdue'} />
            <StatCard label="Net after costs" value={money(overview.netMinor, currency)} sub={`${money(overview.expensesMinor, currency)} of expenses`} />
          </div>

          {packLiability && packLiability.packs > 0 ? (
            <p className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 px-4 py-3 text-[13px] text-slateink-300">
              <span className="text-slate-900">Class packs:</span> holding {money(packLiability.valueHeldMinor, packLiability.currency)} for{' '}
              {packLiability.placesOutstanding} undelivered place(s) across {packLiability.packs} pack(s) — money taken for classes that have
              not happened yet. It becomes revenue place by place, as each class is attended.
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
              <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Who earned it</h3>
              {overview.byProvider.length === 0 ? (
                <p className="mt-3 text-[12.5px] text-slateink-400">Nothing billed yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.byProvider.map((row) => (
                    <li key={row.providerId} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate text-slate-900">{row.providerName}</span>
                      <span className="shrink-0 text-slateink-300">
                        {money(row.invoicedMinor, currency)} billed · {money(row.collectedMinor, currency)} in
                        {row.outstandingMinor > 0 && <span className="text-amber-800"> · {money(row.outstandingMinor, currency)} owed</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
              <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Where it went</h3>
              {overview.byCategory.length === 0 ? (
                <p className="mt-3 text-[12.5px] text-slateink-400">No expenses recorded.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {overview.byCategory.map((row) => (
                    <li key={row.category} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="capitalize text-slate-900">{row.category}</span>
                      <span className="text-slateink-300">{money(row.amountMinor, currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Getting paid</h3>
              <Pill tone={overview.provider.driver === 'stripe' ? 'brand' : 'info'}>
                {overview.provider.driver === 'stripe' ? `Stripe${overview.provider.mode ? ` (${overview.provider.mode})` : ''}` : 'sandbox — no keys configured'}
              </Pill>
            </div>
            <p className="mt-2 text-[12.5px] text-slateink-300">
              Payment links are taken through {overview.provider.driver === 'stripe' ? 'the practice\u2019s Stripe account' : 'the sandbox'}, because {overview.provider.reason}.
            </p>
            <div className="mt-3 grid gap-2 text-[12.5px] text-slateink-300 sm:grid-cols-3">
              <p>
                <span className="text-slate-900">{overview.links.open}</span> open link(s) · {money(overview.links.openValueMinor, currency)}
              </p>
              <p>
                <span className="text-slate-900">{overview.links.paid}</span> paid · <span className="text-slate-900">{overview.links.expired}</span> expired
              </p>
              <p>
                <span className="text-slate-900">{overview.links.sent}</span> sent to a patient
              </p>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/40 p-4">
            <h3 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Latest movement</h3>
            <ul className="mt-3 divide-y divide-slate-900/[0.03]">
              {overview.recent.map((row) => (
                <li key={`${row.kind}-${row.id}`} className="flex items-center justify-between gap-3 py-2 text-[12.5px]">
                  <span className="min-w-0 truncate">
                    <span className="text-slate-900">{row.reference}</span>
                    <span className="text-slateink-400"> · {row.kind}{row.clientName ? ` · ${row.clientName}` : ''}</span>
                  </span>
                  <span className={cn('shrink-0', row.amountMinor < 0 ? 'text-rose-700' : 'text-emerald-700')}>
                    {row.amountMinor < 0 ? '−' : '+'}
                    {money(Math.abs(row.amountMinor), row.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {tab === 'invoices' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(['open', 'overdue', 'drafts', 'paid', 'all'] as const).map((key) => (
              <Button key={key} size="sm" variant={filter === key ? 'primary' : 'ghost'} onClick={() => setFilter(key)}>
                {key === 'open' ? 'Open' : key === 'overdue' ? 'Overdue' : key === 'drafts' ? 'Drafts' : key === 'paid' ? 'Paid' : 'Everything'}
              </Button>
            ))}
            {stats && (
              <span className="ml-auto text-[12px] text-slateink-400">
                {money(stats.outstandingMinor, currency)} outstanding{stats.overdueMinor ? ` · ${money(stats.overdueMinor, currency)} overdue` : ''}
              </span>
            )}
          </div>

          {shown.length === 0 ? (
            <EmptyState icon="download" title="Nothing here yet" desc="Bill an appointment and it will appear — draft, then issued, then paid." />
          ) : (
            <DataTable
              columns={[
                { key: 'number', label: 'Invoice' },
                { key: 'client', label: 'Client' },
                { key: 'dates', label: 'Issued / due' },
                { key: 'total', label: 'Total', align: 'right' },
                { key: 'balance', label: 'Balance', align: 'right' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: '', align: 'right' },
              ]}
            >
              {shown.map((invoice) => (
                <tr key={invoice.id} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 font-mono text-[12px] text-slate-900">{invoice.number ?? 'draft'}</td>
                  <td className="px-4 py-3 text-[12.5px] text-slate-900">
                    {invoice.clientName ?? invoice.clientId}
                    {invoice.kind === 'credit' && <span className="ml-2 text-slateink-400">credit note</span>}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-slateink-400">
                    {invoice.issueDate ?? <Ago at={invoice.createdAt} />}
                    {invoice.dueDate ? ` → ${invoice.dueDate}` : ''}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{money(invoice.totalMinor, invoice.currency)}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slateink-200">{money(invoice.balanceMinor, invoice.currency)}</td>
                  <td className="px-4 py-3">
                    <Pill tone={STATUS_TONE[invoice.status] ?? 'default'} title={STATUS_WORDS[invoice.status]?.hint}>
                      {STATUS_WORDS[invoice.status]?.label ?? invoice.status.replace('_', ' ')}
                    </Pill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => void openInvoice(invoice.id)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}

      {tab === 'payments' && (
        <div className="space-y-4">
          {payments.length === 0 ? (
            <EmptyState icon="download" title="No payments yet" desc="Take a payment against an invoice and it lands here with how it arrived." />
          ) : (
            <DataTable
              columns={[
                { key: 'at', label: 'When' },
                { key: 'client', label: 'Client' },
                { key: 'kind', label: 'Kind' },
                { key: 'method', label: 'Method' },
                { key: 'allocated', label: 'Applied to', align: 'right' },
                { key: 'amount', label: 'Amount', align: 'right' },
                { key: 'status', label: 'Status' },
              ]}
            >
              {payments.map((payment) => (
                <tr key={payment.id} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 text-[12px] text-slateink-300">{fmtDate(payment.at)}</td>
                  <td className="px-4 py-3 text-[12.5px] text-slate-900">{payment.clientName ?? payment.clientId}</td>
                  <td className="px-4 py-3 text-[12.5px] capitalize text-slateink-200">{payment.kind}</td>
                  <td className="px-4 py-3 text-[12.5px] capitalize text-slateink-300">{payment.method.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right text-[12px] text-slateink-300">
                    {payment.allocations.length ? `${payment.allocations.length} invoice(s)` : payment.unallocatedMinor > 0 ? 'on account' : '—'}
                  </td>
                  <td className={cn('px-4 py-3 text-right font-mono text-[12px]', payment.direction === 'out' ? 'text-rose-700' : 'text-emerald-700')}>
                    {payment.direction === 'out' ? '−' : '+'}
                    {money(payment.amountMinor, payment.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={payment.status === 'void' ? 'default' : 'brand'}>{payment.status}</Pill>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}

      {tab === 'expenses' && (
        <div className="space-y-4">
          {expenses.length === 0 ? (
            <EmptyState icon="download" title="No expenses recorded" desc="Rent, supplies, software — record them and the overview shows what the practice keeps." />
          ) : (
            <DataTable
              columns={[
                { key: 'at', label: 'Date' },
                { key: 'category', label: 'Category' },
                { key: 'supplier', label: 'Supplier' },
                { key: 'description', label: 'What' },
                { key: 'amount', label: 'Amount', align: 'right' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: '', align: 'right' },
              ]}
            >
              {expenses.map((expense) => (
                <tr key={expense.id} className="border-b border-slate-900/[0.04] last:border-0">
                  <td className="px-4 py-3 text-[12px] text-slateink-300">{expense.at}</td>
                  <td className="px-4 py-3 text-[12.5px] capitalize text-slate-900">{expense.category}</td>
                  <td className="px-4 py-3 text-[12.5px] text-slateink-200">{expense.supplier ?? '—'}</td>
                  <td className="px-4 py-3 text-[12.5px] text-slateink-300">{expense.description ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-slate-900">{money(expense.amountMinor + expense.taxMinor, expense.currency)}</td>
                  <td className="px-4 py-3">
                    <Pill tone={expense.status === 'void' ? 'default' : 'info'}>{expense.status}</Pill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {expense.status === 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt('Why is this expense being voided?');
                          if (reason) void act({ action: 'expense:void', expenseId: expense.id, reason }, 'Expense voided');
                        }}
                      >
                        Void
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ invoice drawer */}
      <Modal open={Boolean(openId)} onClose={() => setOpenId(null)} title={detail?.invoice.number ?? 'Invoice'} width="max-w-3xl">
        {!detail ? (
          <p className="text-[13px] text-slateink-300">Loading…</p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={STATUS_TONE[detail.invoice.status] ?? 'default'} title={STATUS_WORDS[detail.invoice.status]?.hint}>
                {STATUS_WORDS[detail.invoice.status]?.label ?? detail.invoice.status.replace('_', ' ')}
              </Pill>
              {detail.invoice.kind === 'credit' && <Pill tone="info">credit note</Pill>}
              <span className="text-[12.5px] text-slateink-300">{detail.client?.name ?? detail.invoice.clientId}</span>
              {detail.invoice.issueDate && (
                <span className="text-[12px] text-slateink-400">
                  issued {detail.invoice.issueDate}
                  {detail.invoice.dueDate ? ` · due ${detail.invoice.dueDate}` : ''}
                </span>
              )}
              <span className="ml-auto font-mono text-[13px] text-slate-900">{detail.invoice.totalFormatted}</span>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-900/[0.045]">
              <table className="w-full border-collapse text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-slate-900/[0.045] bg-ink-900/60 text-[10.5px] uppercase tracking-wide text-slateink-400">
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Unit</th>
                    <th className="px-3 py-2 text-right">Tax</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.invoice.lines.map((line) => (
                    <tr key={line.id} className="border-b border-slate-900/[0.04] last:border-0">
                      <td className="px-3 py-2 text-slate-900">
                        {line.description}
                        {line.discountMinor > 0 && <span className="text-slateink-400"> · −{money(line.discountMinor, detail.invoice.currency)} discount</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-slateink-300">{line.qty}</td>
                      <td className="px-3 py-2 text-right font-mono text-slateink-200">{money(line.unitAmountMinor, detail.invoice.currency)}</td>
                      <td className="px-3 py-2 text-right text-slateink-300">{line.taxRatePct}%</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">{money(line.grossMinor, detail.invoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="grid gap-1 bg-ink-900/40 px-3 py-2 text-[12.5px] text-slateink-300">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-mono">{money(detail.invoice.subtotalMinor, detail.invoice.currency)}</span>
                </div>
                {detail.invoice.discountMinor > 0 && (
                  <div className="flex justify-between">
                    <span>Discount</span>
                    <span className="font-mono">−{money(detail.invoice.discountMinor, detail.invoice.currency)}</span>
                  </div>
                )}
                {detail.invoice.taxMinor > 0 && (
                  <div className="flex justify-between">
                    <span>Tax</span>
                    <span className="font-mono">{money(detail.invoice.taxMinor, detail.invoice.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-900">
                  <span>Total</span>
                  <span className="font-mono">{money(detail.invoice.totalMinor, detail.invoice.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Paid{detail.invoice.creditedMinor > 0 ? ' + credited' : ''}</span>
                  <span className="font-mono">{money(detail.invoice.paidMinor + detail.invoice.creditedMinor, detail.invoice.currency)}</span>
                </div>
                <div className="flex justify-between text-slate-900">
                  <span>Balance</span>
                  <span className="font-mono">{detail.invoice.balanceFormatted}</span>
                </div>
              </div>
            </div>

            {detail.appointments.some((a) => !a.missing) && (
              <p className="text-[12px] text-slateink-400">
                Raised from{' '}
                {detail.appointments
                  .filter((a) => !a.missing)
                  .map((a) => `${a.service ?? 'appointment'} on ${a.startsAt ? fmtDate(a.startsAt) : '—'}`)
                  .join(', ')}
              </p>
            )}

            {/* actions */}
            <div className="flex flex-wrap gap-2">
              {detail.permissions.canIssue && (
                <Button size="sm" disabled={busy} onClick={() => void act({ action: 'issue', id: detail.invoice.id }, 'Invoice issued')}>
                  Issue invoice
                </Button>
              )}
              {!detail.permissions.canEdit && (
                <Button size="sm" disabled={busy} onClick={() => void act({ action: 'pay', id: detail.invoice.id, method: 'card' }, 'Payment recorded')}>
                  Take payment
                </Button>
              )}
              {detail.permissions.canCredit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Why is a credit note being raised?');
                    if (reason) void act({ action: 'credit', id: detail.invoice.id, reason }, 'Credit note raised');
                  }}
                >
                  Credit note
                </Button>
              )}
              {['issued', 'partly_paid', 'overdue'].includes(detail.invoice.status) && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const created = await request<{ link: LinkRow }>('POST', '/api/v1/invoices', { action: 'link:create', id: detail.invoice.id });
                        toast('Payment link created', 'success');
                        await load();
                        await openInvoice(detail.invoice.id);
                        void created;
                      } catch (error) {
                        fail(error);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Payment link
                  </Button>
                  {detail.links.some((l) => l.status === 'open') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act({ action: 'link:send', invoiceId: detail.invoice.id, via: 'sms' }, 'Link texted')}
                    >
                      Text the link
                    </Button>
                  )}
                </>
              )}
              {detail.permissions.canVoid && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Why is this invoice being voided?');
                    if (reason) void act({ action: 'void', id: detail.invoice.id, reason }, 'Invoice voided');
                  }}
                >
                  Void
                </Button>
              )}
            </div>

            {detail.links.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Payment links</h4>
                {detail.links.map((link) => (
                  <div key={link.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2 text-[12px]">
                    <Pill tone={link.status === 'paid' ? 'brand' : link.status === 'open' ? 'info' : 'default'}>{link.status}</Pill>
                    <span className="font-mono text-slate-900">{money(link.amountMinor, link.currency)}</span>
                    <span className="text-slateink-400">
                      {link.provider}
                      {link.sentAt ? ` · sent by ${link.sentVia}` : ' · not sent'}
                    </span>
                    {link.status === 'open' && (
                      <span className="ml-auto flex items-center gap-2">
                        <CopyButton value={link.url} label="Copy link" />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void act({ action: 'link:cancel', linkId: link.id }, 'Link cancelled')}
                        >
                          Cancel
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {detail.payments.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Payments</h4>
                {detail.payments.map((payment) => (
                  <div key={payment.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2 text-[12px]">
                    <span className={cn('font-mono', payment.direction === 'out' ? 'text-rose-700' : 'text-emerald-700')}>
                      {payment.direction === 'out' ? '−' : '+'}
                      {money(payment.amountMinor, payment.currency)}
                    </span>
                    <span className="capitalize text-slateink-300">
                      {payment.kind} · {payment.method.replace('_', ' ')}
                    </span>
                    <span className="text-slateink-400">{fmtDate(payment.at)}</span>
                    {payment.status === 'void' && <Pill tone="default">void — {payment.voidReason}</Pill>}
                    {payment.status === 'settled' && detail.permissions.canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt('Why is this payment being reversed?');
                          if (reason) void act({ action: 'void-payment', paymentId: payment.id, reason }, 'Payment voided');
                        }}
                      >
                        Reverse
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {detail.creditNotes.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Credit notes</h4>
                {detail.creditNotes.map((credit) => (
                  <p key={credit.id} className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 px-3 py-2 text-[12px] text-slateink-200">
                    <span className="font-mono text-slate-900">{credit.number}</span> · {money(credit.totalMinor, credit.currency)} · {credit.notes}
                  </p>
                ))}
              </div>
            )}

            {detail.chase && (
              <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Chasing this bill</h4>
                  <span className="text-[11.5px] text-slateink-300">{detail.chase.summary}</span>
                </div>
                {detail.chase.enabled && detail.chase.steps.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {detail.chase.steps.map((step) => (
                      <li
                        key={`${step.offsetDays}-${step.on}`}
                        title={step.on ? `${step.label} — ${step.on}` : step.label}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11.5px]',
                          step.state === 'sent'
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-700'
                            : step.state === 'queued'
                              ? 'border-brand-500/40 bg-brand-500/10 text-brand-700'
                              : step.state === 'withdrawn'
                                ? 'border-slate-900/[0.035] text-slateink-500 line-through'
                                : 'border-slate-900/[0.035] text-slateink-300'
                        )}
                      >
                        {step.label}
                        {step.state === 'sent' ? ' · sent' : step.state === 'queued' ? ' · queued' : step.state === 'withdrawn' ? ' · withdrawn' : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {detail.notices.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {detail.notices.slice(0, 5).map((notice) => (
                      <li key={notice.id} className="text-[12px] leading-relaxed text-slateink-300">
                        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-slateink-500">
                          {notice.kind} · {notice.channel} · {notice.status}
                        </span>
                        {notice.reason ? <span className="text-amber-800"> — {notice.reason}</span> : null}
                        <div className="text-slateink-200">{notice.body}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">This record's history</h4>
                <ul className="mt-2 space-y-1 text-[12px] text-slateink-300">
                  {detail.access.slice(0, 8).map((row) => (
                    <li key={row.id}>
                      <span className="text-slate-900">{row.action}</span> · {row.actorName ?? row.actor}
                      {row.detail ? ` · ${row.detail}` : ''} <span className="text-slateink-500">(<Ago at={row.at} />)</span>
                    </li>
                  ))}
                  {detail.access.length === 0 && <li className="text-slateink-500">Nobody but the system has touched it yet.</li>}
                </ul>
              </div>
              <div>
                <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Account</h4>
                <ul className="mt-2 space-y-1 text-[12px] text-slateink-300">
                  <li>{money(detail.account.dueMinor, detail.account.currency)} outstanding across all invoices</li>
                  <li>{money(detail.account.creditMinor, detail.account.currency)} on account</li>
                  <li className={cn(detail.account.balanceMinor > 0 ? 'text-amber-800' : 'text-emerald-700')}>
                    {money(detail.account.balanceMinor, detail.account.currency)} net balance
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <NewInvoiceModal
        open={newOpen}
        busy={busy}
        currency={currency}
        onClose={() => setNewOpen(false)}
        onCreated={async () => {
          setNewOpen(false);
          await load();
        }}
      />

      <NewExpenseModal
        open={expenseOpen}
        busy={busy}
        currency={currency}
        onClose={() => setExpenseOpen(false)}
        onCreated={async () => {
          setExpenseOpen(false);
          await load();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ new invoice */

function NewInvoiceModal({ open, busy, currency, onClose, onCreated }: { open: boolean; busy: boolean; currency: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const toast = useToast();
  const [mode, setMode] = React.useState<'visit' | 'lines'>('visit');
  const [clients, setClients] = React.useState<{ id: string; name: string }[]>([]);
  const [bookings, setBookings] = React.useState<{ id: string; label: string; clientId?: string }[]>([]);
  const [clientId, setClientId] = React.useState('');
  const [bookingId, setBookingId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [taxRatePct, setTaxRatePct] = React.useState('0');
  const [discountPct, setDiscountPct] = React.useState('');
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [c, b] = await Promise.all([
          request<{ data: { id: string; name: string }[] }>('GET', '/api/v1/clients?limit=200'),
          request<{ data: { id: string; customer?: { name?: string }; startsAt: string; service?: string; clientId?: string; status?: string }[] }>('GET', '/api/v1/bookings?limit=200'),
        ]);
        setClients(c.data);
        setBookings(
          b.data
            .filter((row) => ['completed', 'arrived', 'confirmed'].includes(String(row.status)))
            .slice(0, 60)
            .map((row) => ({ id: row.id, clientId: row.clientId, label: `${row.customer?.name ?? 'Client'} · ${row.service ?? 'appointment'} · ${row.startsAt.slice(0, 10)}` }))
        );
      } catch {
        /* the modal still works with the manual form */
      }
    })();
  }, [open]);

  const submit = async () => {
    setWorking(true);
    try {
      const payload =
        mode === 'visit'
          ? { action: 'from-booking', bookingId }
          : {
              action: 'create',
              clientId,
              lines: [{ description: description || 'Services', qty: 1, unitAmount: amount || '0', taxRatePct: Number(taxRatePct) || 0 }],
              discountPct: discountPct ? Number(discountPct) : undefined,
            };
      await request('POST', '/api/v1/invoices', payload);
      toast(mode === 'visit' ? 'Draft invoice raised from the visit' : 'Draft invoice created', 'success');
      await onCreated();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not create the invoice', 'error');
    } finally {
      setWorking(false);
    }
  };

  const ready = mode === 'visit' ? Boolean(bookingId) : Boolean(clientId && amount);

  return (
    <Modal open={open} onClose={onClose} title="New invoice" width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'visit' ? 'primary' : 'ghost'} onClick={() => setMode('visit')}>
            From a visit
          </Button>
          <Button size="sm" variant={mode === 'lines' ? 'primary' : 'ghost'} onClick={() => setMode('lines')}>
            From lines
          </Button>
        </div>
        <p className="text-[12.5px] text-slateink-300">
          {mode === 'visit'
            ? 'Bills the appointment\u2019s service at its own price and tax rate, and attributes the line to the practitioner who did the work.'
            : `Free-form lines, billed in ${currency}. Amounts are entered as they would appear on paper.`}
        </p>

        {mode === 'visit' ? (
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Appointment</span>
            <select className="input w-full" value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
              <option value="">Choose an appointment…</option>
              {bookings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Client</span>
              <select className="input w-full" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">What for</span>
                <input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Consultation" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Amount ({currency})</span>
                <input className="input w-full" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="120.00" inputMode="decimal" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Tax rate %</span>
                <input className="input w-full" value={taxRatePct} onChange={(e) => setTaxRatePct(e.target.value)} inputMode="decimal" />
              </label>
              <label className="block">
                <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Discount %</span>
                <input className="input w-full" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} placeholder="0" inputMode="decimal" />
              </label>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready || working || busy} onClick={() => void submit()}>
            {working ? 'Creating…' : 'Create draft'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ new expense */

const CATEGORIES = ['rent', 'equipment', 'supplies', 'wages', 'marketing', 'utilities', 'software', 'travel', 'insurance', 'other'];

function NewExpenseModal({ open, busy, currency, onClose, onCreated }: { open: boolean; busy: boolean; currency: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = React.useState({ category: 'supplies', supplier: '', description: '', amount: '', date: new Date().toISOString().slice(0, 10) });
  const [working, setWorking] = React.useState(false);

  const submit = async () => {
    setWorking(true);
    try {
      await request('POST', '/api/v1/invoices', { action: 'expense:create', ...form, category: form.category });
      toast('Expense recorded', 'success');
      setForm({ category: 'supplies', supplier: '', description: '', amount: '', date: new Date().toISOString().slice(0, 10) });
      await onCreated();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not record the expense', 'error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record an expense" width="max-w-2xl">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Category</span>
          <select className="input w-full" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Date</span>
          <input className="input w-full" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Supplier</span>
          <input className="input w-full" value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} placeholder="Northwind Supplies" />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">Amount ({currency})</span>
          <input className="input w-full" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="318.40" inputMode="decimal" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-400">What it was for</span>
          <input className="input w-full" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Consumables and paper stock" />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!form.amount || working || busy} onClick={() => void submit()}>
          {working ? 'Saving…' : 'Record expense'}
        </Button>
      </div>
    </Modal>
  );
}
