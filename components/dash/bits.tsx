'use client';

import * as React from 'react';
import Link from 'next/link';
import { Call } from '@/lib/types';
import { cn, fmtDuration } from '@/lib/utils';
import { Ago } from '@/components/dash/Ago';
import { Icons } from '../icons';
import { Pill } from '../ui';

export function StatCard({
  label,
  value,
  delta,
  sub,
  icon,
  spark,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  sub?: string;
  icon?: keyof typeof Icons;
  spark?: number[];
  tone?: 'default' | 'brand';
}) {
  const Icon = icon ? Icons[icon] : null;
  return (
    <div
      className={cn(
        'rounded-2xl border p-5',
        tone === 'brand' ? 'border-brand-500/25 bg-gradient-to-br from-brand-500/[0.07] to-ink-850/60' : 'border-slate-900/[0.045] bg-ink-850/50'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{label}</span>
        {Icon && (
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-slate-900/[0.045] bg-slate-900/[0.03] text-slateink-300">
            <Icon size={14} />
          </span>
        )}
      </div>
      <div className="mt-3 text-[26px] font-semibold leading-none tracking-[-0.03em] text-slate-900 tabular">{value}</div>
      <div className="mt-2.5 flex items-center gap-2.5">
        {delta && (
          <span
            className={cn(
              'inline-flex items-center gap-1 font-mono text-[11px]',
              delta.startsWith('-') ? 'text-red-700' : 'text-brand-700'
            )}
          >
            <Icons.trend size={12} /> {delta}
          </span>
        )}
        {sub && <span className="text-[11.5px] text-slateink-400">{sub}</span>}
      </div>
      {spark && (
        <div className="mt-4 -mb-1">
          <Sparkbars data={spark} />
        </div>
      )}
    </div>
  );
}

export function Sparkbars({ data, color = '#2BE38B', height = 30 }: { data: number[]; color?: string; height?: number }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {data.map((d, i) => (
        <span
          key={i}
          className="flex-1 rounded-t-[2px] transition-[height] duration-500"
          style={{ height: `${Math.max(6, (d / max) * 100)}%`, background: color, opacity: i === data.length - 1 ? 1 : 0.45 }}
        />
      ))}
    </div>
  );
}

export function DataTable({
  columns,
  children,
  className,
}: {
  columns: { key: string; label: string; className?: string; align?: 'left' | 'right' | 'center' }[];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-slate-900/[0.045] bg-ink-850/40', className)}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-900/[0.045] bg-ink-900/60">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'whitespace-nowrap px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slateink-400',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.className
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-900/[0.03]">{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    ended: 'bg-slate-900/30',
    'in-progress': 'bg-brand-400',
    queued: 'bg-amber-400',
    failed: 'bg-red-400',
    active: 'bg-brand-400',
    published: 'bg-brand-400',
    draft: 'bg-amber-400',
    provisioning: 'bg-amber-400',
    released: 'bg-slate-900/25',
    running: 'bg-brand-400',
    paused: 'bg-amber-400',
    completed: 'bg-sky-400',
    scheduled: 'bg-sky-400',
    passed: 'bg-brand-400',
    operational: 'bg-brand-400',
    degraded: 'bg-amber-400',
    invited: 'bg-sky-400',
  };
  return <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', map[status] ?? 'bg-slate-900/30')} />;
}

export function EndReason({ reason }: { reason: Call['endedReason'] }) {
  const map: Record<string, { tone: 'default' | 'brand' | 'warn' | 'danger' | 'info'; label: string }> = {
    'customer-ended-call': { tone: 'default', label: 'Customer ended' },
    'assistant-ended-call': { tone: 'brand', label: 'Assistant ended' },
    'assistant-forwarded-call': { tone: 'info', label: 'Transferred' },
    'silence-timeout': { tone: 'warn', label: 'Silence timeout' },
    'max-duration-exceeded': { tone: 'warn', label: 'Max duration' },
    'customer-busy': { tone: 'warn', label: 'Busy' },
    voicemail: { tone: 'info', label: 'Voicemail' },
    error: { tone: 'danger', label: 'Error' },
    'assistant-error': { tone: 'danger', label: 'Assistant error' },
  };
  const m = map[reason] ?? { tone: 'default' as const, label: reason };
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

export function CallRow({ call, onOpen }: { call: Call; onOpen?: () => void }) {
  const customerLabel = call.customer.name?.trim() || call.customer.number?.trim() || 'Unknown caller';
  return (
    <tr className="transition-colors hover:bg-slate-900/[0.03]">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <StatusDot status={call.status} />
          {onOpen ? (
            <button onClick={onOpen} className="font-mono text-[11.5px] text-slateink-300 hover:text-brand-700">
              {call.id.slice(0, 16)}
            </button>
          ) : (
            <Link href={`/dashboard/calls/${call.id}`} className="font-mono text-[11.5px] text-slateink-300 hover:text-brand-700">
              {call.id.slice(0, 16)}
            </Link>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-[12.5px] text-slate-900">
        <Link href={`/dashboard/calls/${call.id}`} className="hover:text-brand-700">
          {customerLabel}
        </Link>
        {call.customer.company && <span className="ml-2 font-mono text-[10.5px] text-slateink-400">{call.customer.company}</span>}
      </td>
      <td className="px-4 py-3 text-[12.5px] text-slateink-300">{call.assistantName}</td>
      <td className="px-4 py-3">
        <Pill tone={call.type === 'outbound' ? 'info' : 'default'}>{call.type}</Pill>
      </td>
      <td className="px-4 py-3 font-mono text-[11.5px] text-slateink-300">{call.analysis.intent}</td>
      <td className="px-4 py-3">
        <EndReason reason={call.endedReason} />
      </td>
      <td className="tabular px-4 py-3 text-right font-mono text-[11.5px] text-slateink-300">
        {fmtDuration(call.durationSeconds)}
      </td>
      <td className="tabular px-4 py-3 text-right font-mono text-[11.5px] text-slate-900">
        {call.cost.total > 0 ? `$${call.cost.total.toFixed(3)}` : '—'}
      </td>
      <td className="px-4 py-3 text-right">
        <span
          className={cn(
            'inline-flex items-center gap-1 font-mono text-[11px]',
            call.analysis.successEvaluation === 'true'
              ? 'text-brand-700'
              : call.analysis.successEvaluation === 'false'
                ? 'text-amber-800'
                : 'text-slateink-400'
          )}
        >
          {call.analysis.successEvaluation === 'not_evaluated' ? '—' : call.analysis.score}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-[11.5px] text-slateink-400"><Ago at={call.startedAt} /></td>
    </tr>
  );
}

export function Filters({
  filters,
  active,
  onChange,
  className,
}: {
  filters: { id: string; label: string; options: string[] }[];
  active: Record<string, string>;
  onChange: (id: string, value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {filters.map((f) => (
        <select
          key={f.id}
          value={active[f.id] ?? 'All'}
          onChange={(e) => onChange(f.id, e.target.value)}
          className="rounded-lg border border-slate-900/[0.035] bg-ink-900/70 px-2.5 py-2 text-[12px] text-slateink-200 focus:border-brand-500/40 focus:outline-none"
        >
          {f.options.map((o) => (
            <option key={o} value={o} className="bg-ink-900">
              {o === 'All' ? `All ${f.label.toLowerCase()}` : o}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}
