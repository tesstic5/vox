'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type Check = {
  id: string;
  category: string;
  label: string;
  status: 'pass' | 'fail' | 'warning';
  requiredForLive: boolean;
  detail: string;
  evidence?: string;
};

type Readiness = {
  evaluatedAt: string;
  readyForLive: boolean;
  failedRequired: string[];
  statement: string;
  profile: { operatingMode: 'disabled' | 'synthetic_test' | 'live'; market: string; customerType: string };
  checks: Check[];
};

export default function ClinicalFoundationPage() {
  const [readiness, setReadiness] = React.useState<Readiness | null>(null);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState('');

  const load = React.useCallback(async () => {
    setError('');
    const response = await fetch('/api/v1/clinical/readiness', { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'Clinical readiness could not be loaded.');
    setReadiness(body);
  }, []);

  React.useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Clinical readiness could not be loaded.')); }, [load]);

  const setMode = async (mode: 'disabled' | 'synthetic_test' | 'live') => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/v1/clinical/readiness', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, confirmation: mode === 'live' ? confirmation : undefined }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'Clinical mode could not be changed.');
      setReadiness(body.readiness);
      setConfirmation('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Clinical mode could not be changed.');
    } finally {
      setSaving(false);
    }
  };

  const runMigrations = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/v1/clinical/migrations', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'RUN PHASE 1 DATA MIGRATIONS' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? body?.error ?? 'Data migrations could not be completed.');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Data migrations could not be completed.');
    } finally {
      setSaving(false);
    }
  };

  const grouped = React.useMemo(() => {
    const rows = new Map<string, Check[]>();
    for (const check of readiness?.checks ?? []) rows.set(check.category, [...(rows.get(check.category) ?? []), check]);
    return [...rows.entries()];
  }, [readiness]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clinical foundation"
        desc="UK private allied-health setup, access controls and deployment gates. This page reports recorded evidence; it does not issue a compliance or clinical-suitability badge."
      />

      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-5" aria-labelledby="patient-data-boundary">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-800"><Icons.shield size={17} /></span>
          <div>
            <h2 id="patient-data-boundary" className="text-[14px] font-semibold text-amber-950">Real patient data is not cleared yet</h2>
            <p className="mt-1.5 max-w-4xl text-[12.5px] leading-relaxed text-amber-900">
              Use synthetic/test data only until PostgreSQL, encrypted object storage, malware scanning, controller records, restore evidence and current independent security, UK privacy/legal and allied-health clinical approvals all pass. Local checks cannot substitute for those reviews.
            </p>
          </div>
        </div>
      </section>

      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-700">{error}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <section className="panel p-5" aria-labelledby="readiness-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="readiness-title" className="text-[15px] font-semibold text-slate-900">Live-mode readiness</h2>
              <p className="mt-1 text-[12px] text-slateink-400">{readiness ? `Evaluated ${new Date(readiness.evaluatedAt).toLocaleString()}` : 'Loading server evidence…'}</p>
            </div>
            <Pill tone={readiness?.readyForLive ? 'brand' : 'warn'}>{readiness?.readyForLive ? 'gates pass' : readiness ? `${readiness.failedRequired.length} blocked` : 'loading'}</Pill>
          </div>
          {readiness ? <p className="mt-4 rounded-xl bg-slate-900/[0.03] px-3.5 py-3 text-[12.5px] leading-relaxed text-slateink-500">{readiness.statement}</p> : null}

          <div className="mt-5 space-y-5">
            {grouped.map(([category, checks]) => (
              <div key={category}>
                <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-slateink-400">{category.replaceAll('_', ' ')}</h3>
                <div className="divide-y divide-slate-900/[0.05] rounded-xl border border-slate-900/[0.05]">
                  {checks.map((check) => (
                    <div key={check.id} className="flex gap-3 px-3.5 py-3">
                      <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${check.status === 'pass' ? 'bg-emerald-500' : check.status === 'warning' ? 'bg-amber-500' : 'bg-red-500'}`} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-medium text-slate-900">
                          {check.label} {check.requiredForLive ? <span className="font-mono text-[9px] uppercase tracking-wide text-slateink-300">required</span> : null}
                        </div>
                        <p className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">{check.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="space-y-5">
          <section className="panel p-5" aria-labelledby="mode-title">
            <div className="flex items-center justify-between gap-3">
              <h2 id="mode-title" className="text-[14px] font-semibold text-slate-900">Operating mode</h2>
              <Pill tone={readiness?.profile.operatingMode === 'live' ? 'brand' : 'warn'}>{readiness?.profile.operatingMode?.replaceAll('_', ' ') ?? 'loading'}</Pill>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-slateink-400">Synthetic mode requires an explicit request acknowledgement on every new clinical upload. Live activation remains fail-closed.</p>
            <div className="mt-4 grid gap-2">
              <Button variant="ghost" size="sm" disabled={saving || !readiness} onClick={() => void setMode('synthetic_test')}>Use synthetic-test mode</Button>
              <Button variant="ghost" size="sm" disabled={saving || !readiness} onClick={() => void setMode('disabled')}>Disable clinical writes</Button>
            </div>
            <label className="mt-5 block text-[11px] font-medium text-slateink-500" htmlFor="live-confirmation">Owner live confirmation</label>
            <input
              id="live-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
              placeholder="ENABLE LIVE UK CLINICAL DATA"
              className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] bg-white px-3 py-2 font-mono text-[11px] text-slate-900 outline-none focus:border-brand-500/40"
            />
            <Button className="mt-2 w-full" size="sm" disabled={saving || !readiness?.readyForLive || confirmation !== 'ENABLE LIVE UK CLINICAL DATA'} onClick={() => void setMode('live')}>
              Enable live mode
            </Button>
          </section>

          <section className="panel p-5">
            <h2 className="text-[14px] font-semibold text-slate-900">Foundation tools</h2>
            <div className="mt-3 space-y-2">
              {readiness?.failedRequired.includes('data-migrations') ? <Button variant="brand" size="sm" className="w-full" disabled={saving} onClick={() => void runMigrations()}>Run/resume data migrations</Button> : null}
              <Link href="/dashboard/clinical/templates" className="btn-ghost btn-sm w-full justify-between">Clinical note templates <Icons.arrowRight size={13} /></Link>
              <Link href="/dashboard/clinical/operations" className="btn-ghost btn-sm w-full justify-between">Clinical job operations <Icons.arrowRight size={13} /></Link>
              <Link href="/dashboard/documents" className="btn-ghost btn-sm w-full justify-between">Clinical documents <Icons.arrowRight size={13} /></Link>
              <Link href="/dashboard/settings/privacy" className="btn-ghost btn-sm w-full justify-between">Privacy & retention records <Icons.arrowRight size={13} /></Link>
              <Link href="/dashboard/settings/roles" className="btn-ghost btn-sm w-full justify-between">Granular roles <Icons.arrowRight size={13} /></Link>
              <Link href="/dashboard/audit" className="btn-ghost btn-sm w-full justify-between">Workspace audit <Icons.arrowRight size={13} /></Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
