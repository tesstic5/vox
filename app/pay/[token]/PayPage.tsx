'use client';

import * as React from 'react';
import { Button } from '@/components/ui';

/**
 * The public payment page.
 *
 * What it shows a stranger: the practice's name, what the link is for, the amount
 * and whether it is still open. What it deliberately does not show: the client's
 * name, their other invoices, anything else about them. A payment link travels by
 * text message and lands on whatever phone is nearest — it has to be safe to open
 * by accident.
 *
 * With a payment provider connected, this page is a landing page (the money is
 * taken on the provider's own checkout). With none connected — which is how a
 * fresh workspace runs — it takes a **sandbox** payment: a real payment row,
 * written through the same module, and labelled so nobody can mistake it for
 * money that moved. That is what makes "the sandbox flow works with no keys"
 * true rather than decorative.
 */

type LinkView = {
  token: string;
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  amountMinor: number;
  currency: string;
  amountFormatted: string;
  description: string;
  practiceName: string;
  expiresAt: string;
  provider: 'stripe' | 'sandbox';
  paidAt?: string;
  sandbox: boolean;
};

export function PayPage(props: { link: LinkView }) {
  const [link, setLink] = React.useState<LinkView>(props.link);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [done, setDone] = React.useState(link.status === 'paid');

  const post = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/public/pay/${link.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as { link?: LinkView; error?: { message?: string } };
      if (!res.ok) {
        setError(body.error?.message ?? 'Something went wrong — try again, or ring the practice.');
        return;
      }
      if (body.link) setLink(body.link);
      setDone(true);
    } catch {
      setError('Could not reach the practice — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const closed = link.status === 'cancelled' || link.status === 'expired';

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-5 py-10">
      <div className="rounded-2xl border border-slate-900/[0.035] bg-ink-900/60 p-6 shadow-xl">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slateink-400">Secure payment</p>
        <h1 className="mt-2 text-xl font-semibold text-slate-900">{link.practiceName}</h1>
        <p className="mt-1 text-sm text-slateink-300">{link.description}</p>

        <div className="mt-6 rounded-xl border border-slate-900/[0.04] bg-ink-950/60 px-4 py-5 text-center">
          <p className="text-[11px] uppercase tracking-wide text-slateink-400">Amount due</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">{link.amountFormatted}</p>
        </div>

        {done ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-emerald-700">
              {link.sandbox ? 'Test payment complete.' : 'Payment complete — thank you.'}
            </p>
            <p className="text-[12.5px] text-slateink-300">
              {link.sandbox
                ? 'This practice has not connected a payment provider, so this was a sandbox payment: the invoice and its receipt are real, the money is not. Nothing was charged.'
                : 'The practice has this against your invoice straight away. A receipt is on its way.'}
            </p>
            <p className="font-mono text-[11px] text-slateink-500">Reference {link.token.slice(0, 12)}</p>
          </div>
        ) : closed ? (
          <p className="mt-6 text-sm text-amber-800">
            {link.status === 'expired' ? 'This link has expired.' : 'This link was cancelled.'} Ask the practice for a new one — nothing has been charged.
          </p>
        ) : (
          <div className="mt-6 space-y-3">
            {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
            {link.sandbox && (
              <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-800">
                Sandbox mode — no card is taken and no money moves. The practice has no payment provider connected.
              </p>
            )}
            <Button className="w-full" disabled={busy} onClick={() => void post('sandbox-pay')}>
              {busy ? 'Working…' : `Pay ${link.amountFormatted}`}
            </Button>
            <p className="text-center text-[11.5px] text-slateink-400">Card details are never taken over the phone or stored here.</p>
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-[11.5px] text-slateink-500">
        This link is for one invoice and expires {new Date(link.expiresAt).toLocaleDateString()}. Powered by Voxera.
      </p>
    </main>
  );
}
