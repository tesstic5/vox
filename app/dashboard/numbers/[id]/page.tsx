'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { ApiError, request } from '@/lib/server-sync';
import { fmtDate } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, EmptyState, LinkButton, Modal, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { CallWidget } from '@/components/dash/CallWidget';

export default function NumberDetailPage() {
  const store = useStore();
  const router = useRouter();
  const toast = useToast();
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? '');
  const number = store.numbers.find((row) => row.id === id);
  const [releaseOpen, setReleaseOpen] = React.useState(false);
  const [callOpen, setCallOpen] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setLabel(number?.label ?? ''), [number?.id, number?.label]);

  if (!number) {
    return <EmptyState icon="globe" title="Number not found" desc="The number is not present in this workspace. It may have been released." action={<Button variant="brand" size="sm" onClick={() => router.push('/dashboard/numbers')}>Back to numbers</Button>} />;
  }

  const calls = store.calls.filter((call) => (call as typeof call & { numberId?: string }).numberId === number.id);
  const assistant = store.assistants.find((row) => row.id === number.assistantId);
  const carrierBacked = Boolean((number as typeof number & { carrierId?: string }).carrierId);

  const patch = async (next: { assistantId?: string | null; label?: string }) => {
    setSaving(true);
    try {
      await request('PATCH', `/api/v1/numbers/${number.id}`, next);
      await store.refreshFromServer();
      toast('Number record saved.');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The number record could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeSandbox = async () => {
    setSaving(true);
    try {
      await request('DELETE', `/api/v1/numbers/${number.id}`);
      await store.refreshFromServer();
      router.push('/dashboard/numbers');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The sandbox record could not be removed.', 'error');
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={number.number}
        desc={`${number.label || 'No internal label'} · ${number.country} · ${number.provider}`}
        breadcrumb={[{ label: 'Numbers', href: '/dashboard/numbers' }, { label: number.number }]}
        actions={
          <>
            <LinkButton href="/docs" variant="ghost" size="sm"><Icons.book size={13} /> Telephony docs</LinkButton>
            {carrierBacked ? (
              <LinkButton href="/dashboard/numbers" variant="ghost" size="sm"><Icons.server size={13} /> Manage carrier release</LinkButton>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setReleaseOpen(true)}><Icons.trash size={13} /> Remove sandbox record</Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Status', number.status],
          ['Monthly cost on record', Number.isFinite(number.monthlyCost) ? `$${number.monthlyCost.toFixed(2)}` : 'Unavailable'],
          ['Inbound calls (30d)', Number.isFinite(number.inboundCalls30d) ? number.inboundCalls30d.toLocaleString() : 'Unavailable'],
          ['Added', number.createdAt ? fmtDate(number.createdAt) : 'Unavailable'],
        ].map(([label, value]) => (
          <div key={label} className="panel p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{label}</div>
            <div className="mt-2.5 text-[19px] font-semibold capitalize text-slate-900">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)] xl:items-start">
        <section className="panel p-5" aria-labelledby="routing-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="routing-title" className="text-[15px] font-semibold text-slate-900">Server-backed routing</h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slateink-400">Assignments and labels are saved through the tenant-scoped number API. {carrierBacked ? 'An assigned assistant is available to the inbound runtime after carrier delivery reaches this deployment.' : 'This sandbox identifier is never carrier-delivered; assignment exercises configuration only.'}</p>
            </div>
            <Pill tone={store.connection.status === 'live' ? 'brand' : 'warn'}>{store.connection.status}</Pill>
          </div>
          <div className="mt-5 space-y-4">
            <div>
              <label className="label" htmlFor="number-assistant">Assistant</label>
              <select id="number-assistant" className="field" disabled={saving} value={number.assistantId ?? ''} onChange={(event) => void patch({ assistantId: event.target.value || null })}>
                <option value="">Not attached</option>
                {store.assistants.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="number-label">Internal label</label>
              <div className="flex gap-2">
                <input id="number-label" className="field" value={label} onChange={(event) => setLabel(event.target.value)} />
                <Button variant="ghost" size="sm" disabled={saving || label.trim() === number.label} onClick={() => void patch({ label: label.trim() })}>{saving ? 'Saving…' : 'Save'}</Button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel p-5" aria-labelledby="test-title">
          <h2 id="test-title" className="text-[15px] font-semibold text-slate-900">Test the attached assistant</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">The browser test exercises the assistant runtime. It does not test a carrier, codec, inbound caller ID or keypad delivery.</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="brand" size="sm" disabled={!assistant} onClick={() => setCallOpen(true)}><Icons.mic size={14} /> Start browser test</Button>
            <span className="font-mono text-[11px] text-slateink-400">{assistant ? `attached: ${assistant.name}` : 'no assistant attached'}</span>
          </div>
          <CallWidget open={callOpen} onClose={() => setCallOpen(false)} initialAssistantId={assistant?.id} />
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-5" aria-labelledby="recent-number-calls-title">
          <h2 id="recent-number-calls-title" className="text-[15px] font-semibold text-slate-900">Calls attributed to this number</h2>
          {calls.length ? (
            <div className="mt-4 divide-y divide-slate-900/[0.04]">
              {calls.slice(0, 8).map((call) => (
                <Link key={call.id} href={`/dashboard/calls/${call.id}`} className="flex items-center gap-3 py-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-brand-700">{call.id}</span>
                  <span className="font-mono text-[11.5px] text-slateink-300">{call.durationSeconds}s</span>
                </Link>
              ))}
            </div>
          ) : <p className="mt-3 text-[12.5px] text-slateink-400">No loaded call record names this number. Calls are not inferred from workspace-wide history.</p>}
        </section>

        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5" aria-labelledby="number-unavailable-title">
          <h2 id="number-unavailable-title" className="text-[14px] font-semibold text-amber-900">Not configured here</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-amber-900">Per-number SIP trunks, failover routing, recording policy and webhook delivery do not have dedicated number APIs in this deployment. No carrier health, trunk capacity or delivery history is fabricated on this page.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/dashboard/webhooks" className="btn-ghost btn-sm">Workspace webhooks</Link>
            <Link href="/dashboard/carriers" className="btn-ghost btn-sm">Carrier connections</Link>
          </div>
        </section>
      </div>

      <Modal open={releaseOpen} onClose={() => setReleaseOpen(false)} title={`Remove ${number.number}?`} desc="This deletes the non-dialable sandbox routing record from the workspace.">
        <p className="text-[13px] leading-relaxed text-slateink-300">No carrier action occurs. Historical call records are retained and are not rewritten.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setReleaseOpen(false)}>Keep it</Button>
          <Button variant="danger" size="sm" disabled={saving} onClick={() => void removeSandbox()}>{saving ? 'Removing…' : 'Remove record'}</Button>
        </div>
      </Modal>
    </div>
  );
}
