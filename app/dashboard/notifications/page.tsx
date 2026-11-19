'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import type { Notification } from '@/lib/types';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

const KIND_TONE: Record<Notification['kind'], 'default' | 'brand' | 'info' | 'warn' | 'danger'> = {
  call: 'info', alert: 'danger', billing: 'brand', security: 'warn', product: 'default', review: 'info',
};
const KIND_LABEL: Record<Notification['kind'], string> = {
  call: 'Calls', alert: 'Alerts', billing: 'Billing', security: 'Security', product: 'Product', review: 'Review',
};

export default function NotificationsPage() {
  const store = useStore();
  const toast = useToast();
  const [filter, setFilter] = React.useState<'all' | Notification['kind']>('all');
  const unread = store.notifications.filter((row) => !row.read).length;
  const rows = store.notifications.filter((row) => filter === 'all' || row.kind === filter);
  const kinds = new Set(store.notifications.map((row) => row.kind)).size;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace notices"
        desc="Persisted inbox records for this workspace. Read and clear actions are saved; this build does not claim to generate or deliver operational alerts automatically."
        breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Workspace notices' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => store.readAllNotifications()} disabled={unread === 0}>
              <Icons.check size={13} /> Mark all read
            </Button>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => { store.clearNotifications(); toast('Workspace notice records cleared. Audit records are unaffected.'); }}
              disabled={store.notifications.length === 0}
            >
              <Icons.trash size={13} /> Clear notices
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Unread" value={String(unread)} sub="persisted notice records" icon="badge" tone="brand" />
        <StatCard label="Total records" value={String(store.notifications.length)} sub="in this workspace inbox" icon="layers" />
        <StatCard label="Kinds present" value={String(kinds)} sub="based on stored records" icon="filter" />
      </div>

      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
        <div className="flex items-start gap-3">
          <Icons.badge size={17} className="mt-0.5 shrink-0 text-amber-900" />
          <div>
            <h2 className="text-[13.5px] font-semibold text-amber-900">Alert delivery is not wired in this build</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-amber-900">Email digests, Slack delivery, quiet-hour paging and automatic threshold rules are unavailable. Use the audit log and server metrics for evidence; do not treat this inbox as an incident-alerting system.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Notice filters">
        {(['all', 'alert', 'review', 'security', 'billing', 'call', 'product'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setFilter(kind)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
              filter === kind ? 'border-brand-400/50 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] text-slateink-300 hover:border-slate-900/[0.09]'
            )}
          >
            {kind === 'all' ? 'Everything' : KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="badge" title="No notice records" desc={filter === 'all' ? 'This workspace inbox is empty.' : 'No stored notice has this kind.'} />
      ) : (
        <div className="panel overflow-hidden">
          {rows.map((notice) => (
            <div key={notice.id} className={cn('flex flex-wrap items-start gap-4 border-b border-slate-900/[0.035] px-4 py-4 last:border-0', !notice.read && 'bg-brand-500/[0.03]')}>
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', notice.read ? 'bg-slate-900/15' : 'bg-brand-400')} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium text-slate-900">{notice.title}</span>
                  <Pill tone={KIND_TONE[notice.kind]}>{KIND_LABEL[notice.kind]}</Pill>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-slateink-400"><Ago at={notice.at} /></span>
                </div>
                <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slateink-400">{notice.body}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  {notice.href && notice.href.startsWith('/dashboard/') && <Link href={notice.href} className="text-[12.5px] text-brand-700 hover:underline">Open related screen →</Link>}
                  {!notice.read && <button type="button" onClick={() => store.markNotificationRead(notice.id)} className="text-[12.5px] text-slateink-400 hover:text-slate-900">Mark read</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
