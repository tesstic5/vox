'use client';

import * as React from 'react';
import { Logo } from '@/components/icons';
import { cn } from '@/lib/utils';
import { minorUnits } from '@/lib/server/money-format';

type Estimate = {
  reference: string;
  description?: string;
  customer: { name: string; number: string; email?: string };
  siteAddress: { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country?: string };
  currency: string;
  lines: Array<{ id: string; description: string; quantity: number; unitAmountMinor: number; taxRatePct: number; netMinor: number; taxMinor: number; totalMinor: number }>;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  validUntil: string;
  status: string;
  version: number;
  notes?: string;
};

type View = { workspace: { name: string }; estimate: Estimate; expiresAt: string };

function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / 10 ** minorUnits(currency));
}

function siteLine(site: Estimate['siteAddress']) {
  return [site.line1, site.line2, site.city, site.region, site.postalCode, site.country].filter(Boolean).join(', ');
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : {};
  if (!response.ok) throw new Error(parsed?.error?.message ?? `Request failed (${response.status})`);
  return parsed as T;
}

export function EstimateDecision({ token }: { token: string }) {
  const path = `/api/public/estimates/${encodeURIComponent(token)}`;
  const [view, setView] = React.useState<View | null>(null);
  const [error, setError] = React.useState('');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState<'accepted' | 'declined' | ''>('');
  const [decision, setDecision] = React.useState<{ decision: 'accepted' | 'declined'; reference: string; decidedAt: string } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void json<View>('GET', path)
      .then((result) => {
        if (!cancelled) {
          setView(result);
          setName(result.estimate.customer.name ?? '');
          setEmail(result.estimate.customer.email ?? '');
        }
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'This estimate could not be loaded.'));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const decide = async (next: 'accepted' | 'declined') => {
    if (busy || name.trim().length < 2) return;
    setBusy(next);
    setError('');
    try {
      const result = await json<{ decision: 'accepted' | 'declined'; reference: string; decidedAt: string }>('POST', path, {
        decision: next,
        name: name.trim(),
        email: email.trim() || undefined,
      });
      setDecision(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your decision could not be recorded.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="border-b border-slate-900/[0.06] bg-ink-900/80">
        <div className="mx-auto flex h-16 max-w-5xl items-center px-5 sm:px-8">
          <a href="/" aria-label="Voxera home"><Logo /></a>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-slateink-400">Secure estimate review</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        {decision ? (
          <div className="mx-auto max-w-xl rounded-3xl border border-brand-500/25 bg-brand-500/[0.06] p-7 text-center sm:p-10">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-brand-500/25 bg-brand-500/[0.09] text-xl text-brand-700">✓</div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">
              Estimate {decision.decision === 'accepted' ? 'accepted' : 'declined'}
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-slateink-300">
              Your decision for {decision.reference} was recorded on {new Date(decision.decidedAt).toLocaleString()}.
              {decision.decision === 'accepted'
                ? ' The business will contact you to confirm the job and any visit time; this page has not scheduled or charged anything.'
                : ' The business can now follow up if another option would help.'}
            </p>
            <p className="mt-5 font-mono text-[10.5px] uppercase tracking-wide text-slateink-400">This decision link is now closed.</p>
          </div>
        ) : error && !view ? (
          <div className="mx-auto max-w-xl rounded-2xl border border-rose-400/25 bg-rose-500/[0.06] p-6">
            <h1 className="text-lg font-semibold">This estimate cannot be opened</h1>
            <p role="alert" className="mt-2 text-[13px] leading-relaxed text-rose-700">{error}</p>
            <p className="mt-4 text-[12.5px] text-slateink-400">Ask the business that sent it for a new link.</p>
          </div>
        ) : !view ? (
          <div className="mx-auto max-w-xl animate-pulse rounded-2xl border border-slate-900/[0.05] p-6">
            <div className="h-5 w-52 rounded bg-slate-900/[0.06]" />
            <div className="mt-4 h-3 w-full rounded bg-slate-900/[0.04]" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-700">{view.workspace.name}</div>
                <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Estimate {view.estimate.reference}</h1>
                <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-slateink-300">
                  For {view.estimate.customer.name} · service address {siteLine(view.estimate.siteAddress)}
                </p>
              </div>
              <div className="rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.02] px-4 py-3 text-right">
                <div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Valid until</div>
                <div className="mt-1 text-[13px] font-medium">{new Date(`${view.estimate.validUntil}T12:00:00Z`).toLocaleDateString()}</div>
                <div className="mt-1 font-mono text-[9.5px] text-slateink-400">version {view.estimate.version}</div>
              </div>
            </div>

            {view.estimate.description && <p className="mt-8 rounded-2xl border border-slate-900/[0.05] bg-ink-900/30 p-5 text-[13px] leading-relaxed text-slateink-300">{view.estimate.description}</p>}

            <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-900/[0.06]">
              <table className="w-full min-w-[660px] text-left text-[12.5px]">
                <thead className="border-b border-slate-900/[0.06] bg-slate-900/[0.025] font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">
                  <tr><th className="px-4 py-3">Work</th><th className="px-4 py-3 text-right">Quantity</th><th className="px-4 py-3 text-right">Unit price</th><th className="px-4 py-3 text-right">Tax</th><th className="px-4 py-3 text-right">Total</th></tr>
                </thead>
                <tbody>
                  {view.estimate.lines.map((line) => (
                    <tr key={line.id} className="border-b border-slate-900/[0.045] last:border-0">
                      <td className="px-4 py-3 text-slate-900">{line.description}</td>
                      <td className="px-4 py-3 text-right font-mono text-slateink-300">{line.quantity}</td>
                      <td className="px-4 py-3 text-right font-mono text-slateink-300">{money(line.unitAmountMinor, view.estimate.currency)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slateink-300">{line.taxRatePct}%</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-900">{money(line.totalMinor, view.estimate.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-900/[0.06] bg-slate-900/[0.015]">
                  <tr><td colSpan={4} className="px-4 pt-3 text-right text-slateink-400">Subtotal</td><td className="px-4 pt-3 text-right font-mono">{money(view.estimate.subtotalMinor, view.estimate.currency)}</td></tr>
                  <tr><td colSpan={4} className="px-4 py-2 text-right text-slateink-400">Tax</td><td className="px-4 py-2 text-right font-mono">{money(view.estimate.taxMinor, view.estimate.currency)}</td></tr>
                  <tr><td colSpan={4} className="px-4 pb-4 text-right text-[14px] font-semibold">Estimate total</td><td className="px-4 pb-4 text-right font-mono text-[16px] font-semibold text-brand-700">{money(view.estimate.totalMinor, view.estimate.currency)}</td></tr>
                </tfoot>
              </table>
            </div>

            {view.estimate.notes && <div className="mt-5 rounded-xl border border-slate-900/[0.05] p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Notes</div><p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slateink-300">{view.estimate.notes}</p></div>}

            <div className="mt-8 rounded-2xl border border-slate-900/[0.06] bg-ink-900/35 p-5 sm:p-6">
              <h2 className="text-[15px] font-semibold">Record your decision</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-400">
                Acceptance records your approval of this version and total. It does not schedule a visit, issue an invoice or take payment.
              </p>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div><label className="label" htmlFor="estimate-name">Your name</label><input id="estimate-name" className="field" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></div>
                <div><label className="label" htmlFor="estimate-email">Email <span className="text-slateink-400">(optional)</span></label><input id="estimate-email" type="email" className="field" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></div>
              </div>
              {error && <div role="alert" className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-[12.5px] text-rose-700">{error}</div>}
              <div className="mt-5 flex flex-wrap gap-3">
                <button disabled={Boolean(busy) || name.trim().length < 2} onClick={() => void decide('accepted')} className="btn-brand px-5 py-2.5 text-[13px]">
                  {busy === 'accepted' ? 'Recording…' : 'Accept this estimate'}
                </button>
                <button disabled={Boolean(busy) || name.trim().length < 2} onClick={() => void decide('declined')} className={cn('btn-ghost px-5 py-2.5 text-[13px]', busy === 'declined' && 'opacity-70')}>
                  {busy === 'declined' ? 'Recording…' : 'Decline'}
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
