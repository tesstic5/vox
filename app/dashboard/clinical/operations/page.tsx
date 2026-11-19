'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type DeadLetter = {
  id: string;
  sourceType: 'job' | 'outbox';
  sourceId: string;
  sourceKind: string;
  redactedFailure: string;
  firstFailedAt: string;
  lastFailedAt: string;
  attempts: number;
  status: 'open' | 'resolved';
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  revision: number;
};

export default function ClinicalOperationsPage() {
  const [rows, setRows] = React.useState<DeadLetter[]>([]);
  const [status, setStatus] = React.useState<'open' | 'all'>('open');
  const [reasons, setReasons] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  const load = React.useCallback(async () => {
    setError('');
    const response = await fetch(`/api/v1/clinical/dead-letters?status=${status}`, { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'Clinical job failures could not be loaded.');
    setRows(Array.isArray(body.data) ? body.data : []);
  }, [status]);

  React.useEffect(() => {
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Clinical job failures could not be loaded.'));
  }, [load]);

  const act = async (row: DeadLetter, action: 'retry' | 'resolve') => {
    const reason = (reasons[row.id] ?? '').trim();
    if (reason.length < 12) {
      setError('Enter a reason of at least 12 characters before changing a failure.');
      return;
    }
    setBusy(row.id);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/v1/clinical/dead-letters', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id: row.id, expectedRevision: row.revision, reason }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'The failure could not be changed.');
      setReasons((current) => ({ ...current, [row.id]: '' }));
      setNotice(action === 'retry' ? 'The source job was atomically re-queued and the failure was resolved.' : 'The failure was marked resolved with your explanation.');
      await load();
    } catch (reason_) {
      setError(reason_ instanceof Error ? reason_.message : 'The failure could not be changed.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clinical job operations"
        desc="Review redacted exhausted-job failures. Retrying re-queues the original durable job and resolves its dead letter in one revision-checked transaction."
        actions={<Link href="/dashboard/clinical" className="btn-ghost btn-sm">Clinical foundation</Link>}
      />

      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4 text-[12.5px] leading-relaxed text-amber-950">
        Failure text is redacted before storage and this screen never returns job payloads. Retry only after the underlying scanner, object store or configuration problem has been corrected.
      </section>

      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-700">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12.5px] text-emerald-800">{notice}</div> : null}

      <section className="panel overflow-hidden" aria-labelledby="failures-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.06] px-5 py-4">
          <div>
            <h2 id="failures-title" className="text-[15px] font-semibold text-slate-900">Dead letters</h2>
            <p className="mt-1 text-[11.5px] text-slateink-400">{rows.length} {status === 'open' ? 'open' : 'recorded'} failure{rows.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={status === 'open' ? 'brand' : 'ghost'} onClick={() => setStatus('open')}>Open</Button>
            <Button size="sm" variant={status === 'all' ? 'brand' : 'ghost'} onClick={() => setStatus('all')}>All</Button>
            <Button size="sm" variant="ghost" onClick={() => void load()}><Icons.refresh size={13} /> Refresh</Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-700"><Icons.shield size={17} /></div>
            <p className="mt-3 text-[13px] font-medium text-slate-900">No {status === 'open' ? 'open ' : ''}dead letters</p>
            <p className="mt-1 text-[11.5px] text-slateink-400">Exhausted durable jobs will appear here with redacted error evidence.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-900/[0.06]">
            {rows.map((row) => (
              <article key={row.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-mono text-[12px] font-semibold text-slate-900">{row.sourceKind}</h3>
                      <Pill tone={row.status === 'open' ? 'warn' : 'default'}>{row.status}</Pill>
                      <span className="text-[10.5px] text-slateink-300">{row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span>
                    </div>
                    <p className="mt-2 break-words rounded-lg bg-slate-900/[0.035] px-3 py-2 font-mono text-[11px] leading-relaxed text-slateink-500">{row.redactedFailure}</p>
                    <p className="mt-2 text-[10.5px] text-slateink-300">Last failed {new Date(row.lastFailedAt).toLocaleString()} · source {row.sourceType}:{row.sourceId}</p>
                    {row.resolution ? <p className="mt-2 text-[11.5px] text-slateink-500"><span className="font-medium">Resolution:</span> {row.resolution}</p> : null}
                  </div>
                </div>

                {row.status === 'open' ? (
                  <div className="mt-4 grid gap-2 md:grid-cols-[minmax(240px,1fr)_auto_auto]">
                    <label className="sr-only" htmlFor={`reason-${row.id}`}>Retry or resolution reason</label>
                    <input
                      id={`reason-${row.id}`}
                      value={reasons[row.id] ?? ''}
                      onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                      placeholder="What was corrected, or why this needs no retry?"
                      className="rounded-xl border border-slate-900/[0.08] bg-white px-3 py-2 text-[12px] text-slate-900 outline-none focus:border-brand-500/40"
                    />
                    <Button size="sm" variant="brand" disabled={busy === row.id} onClick={() => void act(row, 'retry')}>Retry job</Button>
                    <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => void act(row, 'resolve')}>Resolve only</Button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
