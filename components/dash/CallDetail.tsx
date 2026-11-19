'use client';

import * as React from 'react';
import Link from 'next/link';
import { useStore } from '@/lib/store';
import { cn, fmtDate, fmtDuration } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, CodeBlock, Pill, Progress, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { EndReason } from './bits';

export function CallDetail({ id }: { id: string }) {
  const store = useStore();
  const toast = useToast();
  const call = store.calls.find((c) => c.id === id);
  const [tab, setTab] = React.useState<'transcript' | 'analysis' | 'raw'>('transcript');
  const [showAll, setShowAll] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  if (!call) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-10 text-center">
        <Icons.phoneOff size={22} className="mx-auto text-slateink-400" />
        <p className="mt-4 text-[14.5px] font-medium text-slate-900">No call with that id</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">
          It may have been deleted, or it may belong to another workspace. Try the tenant-scoped call list instead.
        </p>
        <Link href="/dashboard/calls" className="btn-brand btn-sm mt-6">
          Back to calls
        </Link>
      </div>
    );
  }

  const c = call;
  const mayDelete = ['owner', 'admin', 'developer'].includes(store.connection.user?.role ?? '');
  const costRows: [string, number][] = [
    ['Platform', c.cost.platform],
    ['Speech-to-text', c.cost.stt],
    ['Language model', c.cost.llm],
    ['Text-to-speech', c.cost.tts],
    ['Telephony', c.cost.telephony],
  ];
  const maxCost = Math.max(...costRows.map(([, v]) => v), 0.0001);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Call ${c.id.slice(0, 14)}`}
        desc={`${c.customer.name}${c.customer.company ? ` · ${c.customer.company}` : ''} · ${c.from} → ${c.to}`}
        breadcrumb={[{ label: 'Calls', href: '/dashboard/calls' }, { label: c.id.slice(0, 12) }]}
        actions={
          <>
            {c.recordingUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigator.clipboard.writeText(c.recordingUrl as string).then(() => toast('Recording URL copied.'))}
              >
                <Icons.copy size={13} /> Copy recording URL
              </Button>
            )}
            {mayDelete && (
              <Button
                variant="brand"
                size="sm"
                disabled={deleting}
                onClick={async () => {
                  if (!window.confirm('Permanently delete this call record?')) return;
                  setDeleting(true);
                  try {
                    const response = await fetch(`/api/v1/calls/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
                    if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message ?? 'The call could not be deleted.');
                    await store.refreshFromServer();
                    window.location.assign('/dashboard/calls');
                  } catch (error) {
                    toast(error instanceof Error ? error.message : 'The call could not be deleted.');
                    setDeleting(false);
                  }
                }}
              >
                <Icons.trash size={13} /> {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Duration', fmtDuration(c.durationSeconds), 'wall clock'],
          ['Recorded cost', c.cost.total > 0 ? `$${c.cost.total.toFixed(3)}` : '—', c.cost.total > 0 && c.durationSeconds > 0 ? `$${(c.cost.total / (c.durationSeconds / 60)).toFixed(4)}/stored min` : 'no provider or operator cost imported'],
          ['Latency', c.metrics.latencyMs > 0 ? `${c.metrics.latencyMs}ms` : '—', c.metrics.latencyMs > 0 ? `${c.metrics.interruptions} interruptions recorded` : 'no measured latency sample'],
          ['Score', c.analysis.successEvaluation === 'not_evaluated' ? '—' : `${c.analysis.score}/100`, c.analysis.successEvaluation === 'true' ? 'rubric passed' : c.analysis.successEvaluation === 'false' ? 'rubric failed' : 'not evaluated'], 
        ].map(([k, v, sub]) => (
          <div key={k} className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">{k}</div>
            <div className="mt-2 text-[24px] font-semibold tracking-[-0.03em] text-slate-900">{v}</div>
            <div className="mt-1.5 font-mono text-[10.5px] text-slateink-400">{sub}</div>
          </div>
        ))}
      </div>

      {/* Audio is rendered only when the call record carries a provider URL. */}
      <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
        {c.recordingUrl ? (
          <div className="flex flex-wrap items-center gap-4">
            <audio controls preload="metadata" src={c.recordingUrl} className="min-w-[260px] flex-1" aria-label="Stored call recording" />
            <a href={c.recordingUrl} download className="btn-quiet btn-sm">
              <Icons.download size={13} /> Download provider audio
            </a>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <Icons.phoneOff size={17} className="mt-0.5 shrink-0 text-slateink-400" />
            <div>
              <h2 className="text-[13.5px] font-medium text-slate-900">No recording stored</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-slateink-400">This call record has no recording URL. The transcript and measured call facts remain available below; no synthetic waveform or MP3 is generated.</p>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-900/[0.045] px-5 py-3.5">
            {([
              ['transcript', 'Transcript'],
              ['analysis', 'Analysis'],
              ['raw', 'Raw payload'],
            ] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[12.5px] transition-colors',
                  tab === k ? 'bg-slate-900/[0.08] text-slate-900' : 'text-slateink-400 hover:text-slate-900'
                )}
              >
                {l}
              </button>
            ))}
            <span className="ml-auto font-mono text-[10.5px] text-slateink-400">
              {c.transcript.length} turns · {c.metrics.turns} model turns
            </span>
          </div>

          {tab === 'transcript' && (
            <div id="transcript" className="max-h-[620px] space-y-3 overflow-y-auto p-5">
              {(showAll ? c.transcript : c.transcript.slice(0, 24)).map((t, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-xl px-3 py-2.5"
                >
                  <span className="w-10 shrink-0 pt-0.5 font-mono text-[10.5px] text-slateink-400">
                    {fmtDuration(t.seconds)}
                  </span>
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-lg border font-mono text-[9px]',
                      t.role === 'assistant'
                        ? 'border-brand-500/25 bg-brand-500/10 text-brand-700'
                        : t.role === 'tool'
                          ? 'border-sky-400/25 bg-sky-400/10 text-sky-800'
                          : t.role === 'system'
                            ? 'border-amber-400/25 bg-amber-400/10 text-amber-800'
                            : 'border-slate-900/[0.04] bg-slate-900/[0.04] text-slateink-300'
                    )}
                  >
                    {t.role === 'assistant' ? 'AI' : t.role === 'user' ? 'U' : t.role === 'tool' ? '⚙' : 'S'}
                  </span>
                  <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-slateink-200">{t.text}</p>
                </div>
              ))}
              {!showAll && c.transcript.length > 24 && (
                <Button variant="quiet" size="sm" className="w-full" onClick={() => setShowAll(true)}>
                  Show all {c.transcript.length} turns
                </Button>
              )}
            </div>
          )}

          {tab === 'analysis' && (
            <div className="space-y-5 p-5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Summary</div>
                <p className="mt-2 text-[13.5px] leading-relaxed text-slateink-200">{c.analysis.summary || 'No summary was stored for this call.'}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slateink-400">Success</div>
                  <div className="mt-2">
                    <Pill tone={c.analysis.successEvaluation === 'true' ? 'brand' : c.analysis.successEvaluation === 'false' ? 'warn' : 'default'}>
                      {c.analysis.successEvaluation === 'true' ? 'rubric passed' : c.analysis.successEvaluation === 'false' ? 'rubric failed' : 'not evaluated'}
                    </Pill>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slateink-400">Sentiment</div>
                  <div className="mt-2">
                    <Pill tone={c.analysis.sentiment === 'positive' ? 'brand' : c.analysis.sentiment === 'negative' ? 'danger' : 'default'}>
                      {c.analysis.successEvaluation === 'not_evaluated' && c.analysis.sentiment === 'neutral' ? 'not evaluated' : c.analysis.sentiment}
                    </Pill>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-900/[0.04] bg-ink-900/40 p-3.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-slateink-400">Intent</div>
                  <div className="mt-2 font-mono text-[12px] text-slate-900">{c.analysis.intent}</div>
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Structured data</div>
                <div className="mt-3 space-y-1.5">
                  {Object.entries(c.analysis.structuredData).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 rounded-lg border border-slate-900/[0.04] bg-ink-900/40 px-3.5 py-2.5">
                      <span className="font-mono text-[11.5px] text-slateink-300">{k}</span>
                      <span className="font-mono text-[11.5px] text-slate-900">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slateink-400">Recorded score</div>
                {c.analysis.successEvaluation === 'not_evaluated' ? (
                  <p className="mt-3 text-[12px] text-slateink-400">No rubric score was recorded.</p>
                ) : (
                  <>
                    <div className="mt-3 flex items-center gap-3">
                      <Progress value={Math.max(0, Math.min(100, c.analysis.score))} className="flex-1" />
                      <span className="font-mono text-[12px] text-slate-900">{c.analysis.score}/100</span>
                    </div>
                    <p className="mt-2 text-[11.5px] text-slateink-400">One explicit score from this call record. No comparison distribution is inferred.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'raw' && (
            <div className="p-5">
              <CodeBlock
                lang="json"
                filename={`GET /v1/calls/${c.id}`}
                code={JSON.stringify(
                  {
                    id: c.id,
                    assistantId: c.assistantId,
                    type: c.type,
                    status: c.status,
                    endedReason: c.endedReason,
                    from: c.from,
                    to: c.to,
                    startedAt: c.startedAt,
                    durationSeconds: c.durationSeconds,
                    cost: c.cost,
                    metrics: c.metrics,
                    analysis: c.analysis,
                    recordingUrl: c.recordingUrl,
                  },
                  null,
                  2
                )}
              />
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Call facts</h2>
            <div className="mt-4 space-y-3">
              {[
                ['Assistant', c.assistantName],
                ['Type', c.type],
                ['Ended reason', c.endedReason],
                ['Started', fmtDate(c.startedAt)],
                ['From', c.from],
                ['To', c.to],
                ['Interruptions', String(c.metrics.interruptions)],
                ['Recording', c.recordingUrl ? 'provider URL stored' : 'not stored'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-4 border-b border-slate-900/[0.035] pb-2.5 last:border-0 last:pb-0">
                  <span className="text-[12px] text-slateink-400">{k}</span>
                  <span className="max-w-[60%] truncate text-right font-mono text-[11.5px] text-slate-900">{v}</span>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <EndReason reason={c.endedReason} />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Cost breakdown</h2>
            {c.cost.total > 0 ? (
              <>
                <div className="mt-4 space-y-3">
                  {costRows.map(([k, v]) => (
                    <div key={k}>
                      <div className="mb-1.5 flex items-center justify-between text-[12px]">
                        <span className="text-slateink-400">{k}</span>
                        <span className="font-mono text-slate-900">${v.toFixed(4)}</span>
                      </div>
                      <Progress value={(v / maxCost) * 100} color={k === 'Platform' ? '#D2FD45' : '#2BE38B'} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-900/[0.045] pt-3.5">
                  <span className="text-[12.5px] font-medium text-slateink-300">Recorded total</span>
                  <span className="font-mono text-[13px] text-brand-700">${c.cost.total.toFixed(4)}</span>
                </div>
              </>
            ) : (
              <p className="mt-3 text-[12px] leading-relaxed text-slateink-400">No provider or operator cost was imported for this call. Zero-filled component fields are not presented as a free tariff.</p>
            )}
          </div>

          <div className="rounded-2xl border border-slate-900/[0.045] bg-ink-850/50 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Recorded events</h2>
            <div className="mt-4 space-y-2.5">
              <div className="flex items-center justify-between gap-3 font-mono text-[11px]">
                <span className="text-slateink-300">call.started</span>
                <span className="text-slateink-400">{fmtDate(c.startedAt)}</span>
              </div>
              {(c.toolCalls ?? []).map((tool, index) => (
                <div key={`${tool.name}-${index}`} className="flex items-center justify-between gap-3 font-mono text-[11px]">
                  <span className="min-w-0 truncate text-slateink-300">tool.call · {tool.name}</span>
                  <span className="shrink-0 text-slateink-400">{tool.ms}ms · {tool.status}</span>
                </div>
              ))}
              {(c.toolCalls ?? []).length === 0 && <p className="text-[11.5px] text-slateink-400">No tool calls were recorded on this call.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
