'use client';

import * as React from 'react';
import { EmptyState } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';
import { StatCard } from '@/components/dash/bits';

type Report = {
  stages: { id: string; label: string; workspaces: number; fromPrevious: number; fromStart: number }[];
  workspaces: number;
  activated: number;
  activationRate: number;
  medianHoursToFirstCall: number | null;
  signupsByWeek: { week: string; signups: number }[];
};

export default function GrowthPage() {
  const [report, setReport] = React.useState<Report | null>(null);
  const [forbidden, setForbidden] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      const res = await fetch('/api/v1/growth', { credentials: 'include' });
      if (res.status === 403) setForbidden(true);
      else if (res.ok) setReport((await res.json()) as Report);
      setLoading(false);
    })();
  }, []);

  if (forbidden) {
    return (
      <div className="space-y-6">
        <PageHeader title="Growth" desc="How workspaces go from signup to value." />
        <EmptyState
          title="This view is not yours to see"
          desc="Growth is the platform's view of itself. If you run the platform, ask an administrator to add your email to VOXERA_OPERATOR_EMAILS."
        />
      </div>
    );
  }

  const maxWeek = report ? Math.max(1, ...report.signupsByWeek.map((w) => w.signups)) : 1;
  const biggestDrop = report
    ? report.stages.slice(1).reduce((worst, s) => (s.fromPrevious < worst.fromPrevious ? s : worst), report.stages[1] ?? report.stages[0])
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Growth"
        desc="The funnel from signup to value, computed from the workspaces' own rows — no tracking pixel. The demo workspace and probe fixtures are excluded."
      />

      {loading ? (
        <p className="text-[13px] text-slateink-400">Loading the funnel…</p>
      ) : !report ? (
        <EmptyState title="No funnel yet" desc="Once workspaces sign up and start working, their journey shows here stage by stage." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Workspaces" value={String(report.workspaces)} icon="building" />
            <StatCard label="Activated (first call)" value={String(report.activated)} icon="phone" />
            <StatCard label="Activation rate" value={`${report.activationRate}%`} icon="trend" tone="brand" />
            <StatCard
              label="Median time to first call"
              value={report.medianHoursToFirstCall === null ? '—' : report.medianHoursToFirstCall < 1 ? `${Math.round(report.medianHoursToFirstCall * 60)}m` : `${report.medianHoursToFirstCall}h`}
              icon="bolt"
            />
          </div>

          <div className="rounded-2xl border border-slate-900/[0.035] bg-ink-850/50 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Signup → value</h2>
            <div className="mt-4 space-y-3">
              {report.stages.map((stage) => (
                <div key={stage.id} className="grid items-center gap-3 sm:grid-cols-[180px_1fr_130px]">
                  <div className="text-[12.5px] text-slateink-300">{stage.label}</div>
                  <div className="h-7 overflow-hidden rounded-lg bg-slate-900/[0.04]">
                    <div
                      className="flex h-full items-center rounded-lg bg-brand-500/25 px-2 font-mono text-[11px] text-brand-700 transition-all"
                      style={{ width: `${Math.max(stage.fromStart, stage.workspaces ? 8 : 0)}%` }}
                    >
                      {stage.workspaces}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] text-slateink-400">
                    {stage.fromStart}% overall{stage.id !== 'signed_up' ? ` · ${stage.fromPrevious}% of prev` : ''}
                  </div>
                </div>
              ))}
            </div>
            {biggestDrop && biggestDrop.id !== 'signed_up' && (
              <p className="mt-4 text-[12.5px] text-slateink-400">
                The steepest drop is <span className="text-slate-900">{biggestDrop.label.toLowerCase()}</span> — only {biggestDrop.fromPrevious}% of the
                previous stage gets there. That is the step to fix first.
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-slate-900/[0.035] bg-ink-850/50 p-5">
            <h2 className="text-[14.5px] font-semibold text-slate-900">Signups, last 12 weeks</h2>
            <div className="mt-4 flex h-28 items-end gap-1.5">
              {report.signupsByWeek.map((w) => (
                <div key={w.week} className="group relative flex-1 rounded-t bg-brand-500/30 transition-colors hover:bg-brand-500/50" style={{ height: `${Math.max((w.signups / maxWeek) * 100, w.signups ? 6 : 2)}%` }}>
                  <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-slateink-300 opacity-0 transition-opacity group-hover:opacity-100">
                    {w.week}: {w.signups}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between font-mono text-[10px] text-slateink-400">
              <span>{report.signupsByWeek[0]?.week}</span>
              <span>{report.signupsByWeek[report.signupsByWeek.length - 1]?.week}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
