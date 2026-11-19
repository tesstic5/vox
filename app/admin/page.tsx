'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, LinkButton, Modal, Pill, useToast } from '@/components/ui';
import { StatCard } from '@/components/dash/bits';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

type Overview = {
  generatedAt: string;
  totals: { orgs: number; suspendedOrgs: number; users: number; calls: number; minutes: number; spend: number };
  queues: { messagesPending: number; messagesFailed: number; messagesBlocked: number; webhookFailed: number; webhookRetrying: number };
  store: { collections: Record<string, number>; docs: number };
  orgs: {
    id: string; name: string; slug: string; plan: string; region: string; createdAt: string;
    suspended: boolean; members: number; calls: number; minutes: number; spend: number; lastActivityAt: string | null;
  }[];
};

export default function OperatorConsolePage() {
  const toast = useToast();
  const [data, setData] = React.useState<Overview | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [confirm, setConfirm] = React.useState<{ org: Overview['orgs'][number]; action: 'suspend' | 'reactivate' } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/v1/admin/overview', { headers: { accept: 'application/json' } });
      if (res.status === 403 || res.status === 401) { setState('forbidden'); return; }
      if (!res.ok) { setState('error'); return; }
      setData((await res.json()) as Overview);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function applyAction() {
    if (!confirm) return;
    setBusy(true);
    try {
      const res = await fetch('/api/v1/admin/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: confirm.action, orgId: confirm.org.id }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      toast(confirm.action === 'suspend' ? `${confirm.org.name} suspended — its API access is refused until reactivated.` : `${confirm.org.name} reactivated.`, 'success');
      setConfirm(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.18em] text-brand-700">Platform operator</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.02em] text-slate-900">Operator console</h1>
          <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-slateink-400">
            Every workspace on this deployment, what it uses, and the health of the queues underneath. Customers never see
            this page — it answers only for the operator.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/dashboard/growth" variant="ghost" size="sm">Growth</LinkButton>
          <LinkButton href="/dashboard/leads" variant="ghost" size="sm">Leads</LinkButton>
          <LinkButton href="/dashboard" variant="ghost" size="sm">My workspace</LinkButton>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <Icons.refresh size={13} /> Refresh
          </Button>
        </div>
      </div>

      {state === 'loading' && <p className="mt-10 text-[13px] text-slateink-400">Loading the platform view…</p>}

      {state === 'forbidden' && (
        <div className="mt-10 rounded-[20px] border border-slate-900/[0.045] bg-white/90 p-6 shadow-panel">
          <h2 className="text-[15px] font-semibold text-slate-900">Not the operator</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-slateink-400">
            This console is for whoever runs this Voxera deployment. If that is you, sign in with an operator account —
            an administrator can add your email to <span className="code-chip">VOXERA_OPERATOR_EMAILS</span> on the server.
            If it is unset, no account has platform operator access.
          </p>
          <LinkButton href="/login" variant="brand" size="sm" className="mt-4">Sign in</LinkButton>
        </div>
      )}

      {state === 'error' && (
        <div className="mt-10 rounded-[20px] border border-rose-400/25 bg-rose-500/[0.06] p-6">
          <h2 className="text-[15px] font-semibold text-rose-700">The platform view did not load</h2>
          <p className="mt-1.5 text-[13px] text-slateink-400">The API did not answer. Try Refresh, or check the app is running.</p>
        </div>
      )}

      {state === 'ready' && data && (
        <div className="mt-8 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Workspaces" value={data.totals.orgs.toLocaleString()} sub={data.totals.suspendedOrgs ? `${data.totals.suspendedOrgs} suspended` : 'none suspended'} icon="building" />
            <StatCard label="Users" value={data.totals.users.toLocaleString()} sub="across all workspaces" icon="users" />
            <StatCard label="Calls" value={data.totals.calls.toLocaleString()} sub={`${data.totals.minutes.toLocaleString()} minutes total`} icon="phone" />
            <StatCard label="Call spend" value={`$${data.totals.spend.toLocaleString()}`} sub="at provider cost, all time" icon="dollar" tone="brand" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-[20px] border border-slate-900/[0.045] bg-white/90 p-5 shadow-panel">
              <h2 className="text-[15px] font-semibold text-slate-900">Queues</h2>
              <p className="mt-1 text-[12px] text-slateink-400">Messages and webhook deliveries that still owe somebody an answer.</p>
              <div className="mt-4 space-y-2.5 text-[12.5px]">
                {[
                  ['Messages pending', data.queues.messagesPending, false],
                  ['Messages failed', data.queues.messagesFailed, true],
                  ['Messages blocked', data.queues.messagesBlocked, false],
                  ['Webhook deliveries failed', data.queues.webhookFailed, true],
                  ['Webhook deliveries retrying', data.queues.webhookRetrying, false],
                ].map(([label, n, alarm]) => (
                  <div key={String(label)} className="flex items-center justify-between">
                    <span className="text-slateink-300">{String(label)}</span>
                    <span className={cn('font-mono', alarm && Number(n) > 0 ? 'text-rose-700' : 'text-slate-900')}>{String(n)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[20px] border border-slate-900/[0.045] bg-white/90 p-5 shadow-panel">
              <h2 className="text-[15px] font-semibold text-slate-900">Store</h2>
              <p className="mt-1 text-[12px] text-slateink-400">{data.store.docs.toLocaleString()} documents · generated {new Date(data.generatedAt).toLocaleTimeString()}</p>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
                {Object.entries(data.store.collections).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => (
                  <div key={name} className="flex items-center justify-between">
                    <span className="font-mono text-[11.5px] text-slateink-300">{name}</span>
                    <span className="font-mono text-slate-900">{n.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-[20px] border border-slate-900/[0.045] bg-white/90 p-5 shadow-panel">
            <h2 className="text-[15px] font-semibold text-slate-900">Workspaces</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] text-left">
                <thead>
                  <tr className="border-b border-slate-900/[0.04]">
                    {['Workspace', 'Plan', 'Members', 'Calls', 'Minutes', 'Spend', 'Last call', 'Status', ''].map((h) => (
                      <th key={h} className="px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slateink-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900/[0.03]">
                  {data.orgs.map((org) => (
                    <tr key={org.id}>
                      <td className="px-3 py-3">
                        <div className="text-[13px] font-medium text-slate-900">{org.name}</div>
                        <div className="font-mono text-[10.5px] text-slateink-400">/{org.slug} · {org.region}</div>
                      </td>
                      <td className="px-3 py-3 text-[12px] capitalize text-slateink-300">{org.plan}</td>
                      <td className="px-3 py-3 font-mono text-[12px] text-slateink-300">{org.members}</td>
                      <td className="px-3 py-3 font-mono text-[12px] text-slateink-300">{org.calls.toLocaleString()}</td>
                      <td className="px-3 py-3 font-mono text-[12px] text-slateink-300">{org.minutes.toLocaleString()}</td>
                      <td className="px-3 py-3 font-mono text-[12px] text-slateink-300">${org.spend.toFixed(2)}</td>
                      <td className="px-3 py-3 font-mono text-[11px] text-slateink-400">{org.lastActivityAt ? org.lastActivityAt.slice(0, 10) : '—'}</td>
                      <td className="px-3 py-3">{org.suspended ? <Pill tone="danger">suspended</Pill> : <Pill tone="brand">active</Pill>}</td>
                      <td className="px-3 py-3 text-right">
                        <Button variant={org.suspended ? 'brand' : 'danger'} size="sm" onClick={() => setConfirm({ org, action: org.suspended ? 'reactivate' : 'suspend' })}>
                          {org.suspended ? 'Reactivate' : 'Suspend'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.orgs.length === 0 && <p className="py-6 text-center text-[12.5px] text-slateink-400">No workspaces yet.</p>}
          </div>

          <p className="text-[12px] text-slateink-400">
            Suspending a workspace refuses its API access immediately (sessions and API keys) until it is reactivated.
            The action is written to that workspace's audit log. Platform funnel and sales pipeline live in{' '}
            <Link href="/dashboard/growth" className="text-brand-700 hover:underline">Growth</Link> and{' '}
            <Link href="/dashboard/leads" className="text-brand-700 hover:underline">Leads</Link>.
          </p>
        </div>
      )}

      <Modal open={Boolean(confirm)} onClose={() => setConfirm(null)} title={confirm?.action === 'suspend' ? 'Suspend this workspace?' : 'Reactivate this workspace?'}>
        <p className="text-[13px] leading-relaxed text-slateink-300">
          {confirm?.action === 'suspend'
            ? `${confirm?.org.name} will lose API access straight away — its team will be signed out of anything data-backed and its API keys will stop working. Nothing is deleted; reactivating restores access.`
            : `${confirm?.org.name} will be able to use the API again immediately.`}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm?.action === 'suspend' ? 'danger' : 'brand'} size="sm" disabled={busy} onClick={() => void applyAction()}>
            {busy ? 'Working…' : confirm?.action === 'suspend' ? 'Suspend workspace' : 'Reactivate'}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
