'use client';

import * as React from 'react';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';

type Client = { id: string; name: string; number?: string };
type Provider = { id: string; name: string };
type Service = { id: string; name: string };
type CaseRow = {
  id: string; patientId: string; name: string; number: string; type: string; status: 'draft' | 'active' | 'paused' | 'closed';
  startsOn: string; endsOn?: string; trackingMode: 'appointments' | 'hours' | 'budget';
  limitAppointments?: number; limitMinutes?: number; limitBudgetMinor?: number; limitPolicy: 'warn' | 'block';
  enforcementMode: 'shadow' | 'enforced'; warningThresholdPct: number; revision: number;
};
type Vector = { appointments: number; minutes: number; budgetMinor: number };
type Period = { id: string; startsOn: string; endsOn: string; allowed: Vector; rollover: Vector; committed: Vector; used: Vector; revision: number };
type Rule = {
  id: string; serviceId?: string; providerId?: string; startsOn: string; endsOn?: string; unit: 'appointment' | 'hour';
  fundedPriceMinor: number; taxRateBps: number; noShowPolicy: 'consume' | 'release'; lateCancelPolicy: 'consume' | 'release';
  lateCancellationHours: number; requiresAuthorisation: boolean; active: boolean; revision: number;
};
type Authorisation = { id: string; externalReference: string; status: string; endsOn: string; authorised: Vector; committed: Vector; used: Vector };
type CaseDetail = { case: CaseRow; fundingPeriods: Period[]; serviceRules: Rule[]; authorisations: Authorisation[]; assignments: unknown[] };

const today = () => new Date().toISOString().slice(0, 10);
const zero = (): Vector => ({ appointments: 0, minutes: 0, budgetMinor: 0 });
const money = (minor: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
const sum = (rows: Period[], field: 'committed' | 'used', metric: keyof Vector) => rows.reduce((total, row) => total + Number(row[field][metric] ?? 0), 0);

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? 'The request could not be completed.');
  return body;
}

export default function CasesPage() {
  const [cases, setCases] = React.useState<CaseRow[]>([]);
  const [clients, setClients] = React.useState<Client[]>([]);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState<CaseDetail | null>(null);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);

  const [draft, setDraft] = React.useState({
    patientId: '', name: '', number: '', type: 'private', startsOn: today(), endsOn: '',
    trackingMode: 'appointments', limit: '10', limitPolicy: 'warn', enforcementMode: 'shadow', warningThresholdPct: '80',
  });
  const [period, setPeriod] = React.useState({ startsOn: today(), endsOn: '', allowance: '10', rollover: '0' });
  const [rule, setRule] = React.useState({
    serviceId: '', providerId: '', startsOn: today(), endsOn: '', unit: 'appointment', fundedPriceMinor: '0', taxRatePct: '0',
    noShowPolicy: 'release', lateCancelPolicy: 'release', lateCancellationHours: '24', requiresAuthorisation: false,
  });

  const load = React.useCallback(async () => {
    const [caseBody, clientBody, providerBody, serviceBody] = await Promise.all([
      jsonFetch('/api/v1/cases?includeClosed=true'),
      jsonFetch('/api/v1/clients?limit=500'),
      jsonFetch('/api/v1/providers'),
      jsonFetch('/api/v1/services'),
    ]);
    setCases(caseBody.data ?? []);
    setClients(clientBody.data ?? []);
    setProviders(providerBody.data ?? providerBody.providers ?? []);
    setServices(serviceBody.data ?? serviceBody.services ?? []);
  }, []);

  const loadDetail = React.useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    const body = await jsonFetch(`/api/v1/cases/${encodeURIComponent(id)}`);
    setDetail(body as CaseDetail);
  }, []);

  React.useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : 'Cases could not be loaded.')); }, [load]);
  React.useEffect(() => { void loadDetail(selectedId).catch((reason) => setError(reason instanceof Error ? reason.message : 'Case detail could not be loaded.')); }, [loadDetail, selectedId]);

  const run = async (work: () => Promise<void>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The change could not be saved.'); }
    finally { setBusy(false); }
  };

  const createCase = () => run(async () => {
    const limit = Math.max(0, Math.floor(Number(draft.limit)));
    const body = await jsonFetch('/api/v1/cases', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patientId: draft.patientId, name: draft.name, number: draft.number, type: draft.type,
        startsOn: draft.startsOn, endsOn: draft.endsOn || undefined, trackingMode: draft.trackingMode,
        ...(draft.trackingMode === 'appointments' ? { limitAppointments: limit } : {}),
        ...(draft.trackingMode === 'hours' ? { limitMinutes: limit * 60 } : {}),
        ...(draft.trackingMode === 'budget' ? { limitBudgetMinor: limit } : {}),
        limitPolicy: draft.limitPolicy, enforcementMode: draft.enforcementMode,
        warningThresholdPct: Number(draft.warningThresholdPct), status: 'draft',
      }),
    });
    await load();
    setSelectedId(body.case.id);
    setShowCreate(false);
  }, 'Draft case created. Add its funding period and service rule before activation.');

  const setStatus = (status: CaseRow['status']) => {
    if (!detail) return;
    void run(async () => {
      await jsonFetch(`/api/v1/cases/${detail.case.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: detail.case.revision, patch: { status } }),
      });
      await Promise.all([load(), loadDetail(detail.case.id)]);
    }, status === 'active' ? 'Case activated. Funding rules now apply to explicitly linked bookings.' : `Case marked ${status}.`);
  };

  const addPeriod = () => {
    if (!detail) return;
    void run(async () => {
      const allowance = Math.max(0, Math.floor(Number(period.allowance)));
      const rollover = Math.max(0, Math.floor(Number(period.rollover)));
      const vector = zero();
      const rolloverVector = zero();
      if (detail.case.trackingMode === 'appointments') { vector.appointments = allowance; rolloverVector.appointments = rollover; }
      if (detail.case.trackingMode === 'hours') { vector.minutes = allowance * 60; rolloverVector.minutes = rollover * 60; }
      if (detail.case.trackingMode === 'budget') { vector.budgetMinor = allowance; rolloverVector.budgetMinor = rollover; }
      await jsonFetch(`/api/v1/cases/${detail.case.id}/funding-periods`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startsOn: period.startsOn, endsOn: period.endsOn, allowed: vector, rolloverPolicy: rollover ? 'staff_entered' : 'none', rollover: rolloverVector }),
      });
      await loadDetail(detail.case.id);
    }, 'Funding period added. Existing bookings were not inferred or consumed.');
  };

  const addRule = () => {
    if (!detail) return;
    void run(async () => {
      await jsonFetch(`/api/v1/cases/${detail.case.id}/service-rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serviceId: rule.serviceId || undefined, providerId: rule.providerId || undefined,
          startsOn: rule.startsOn, endsOn: rule.endsOn || undefined, unit: rule.unit,
          fundedPriceMinor: Math.max(0, Math.floor(Number(rule.fundedPriceMinor))),
          taxRateBps: Math.max(0, Math.round(Number(rule.taxRatePct) * 100)),
          noShowPolicy: rule.noShowPolicy, lateCancelPolicy: rule.lateCancelPolicy,
          lateCancellationHours: Math.max(0, Math.floor(Number(rule.lateCancellationHours))),
          requiresAuthorisation: rule.requiresAuthorisation,
        }),
      });
      await loadDetail(detail.case.id);
    }, 'Service rule added. Claim codes remain staff-entered and no clinical code was generated.');
  };

  const clientName = (id: string) => clients.find((client) => client.id === id)?.name ?? id;
  const selected = detail?.case;
  const metric: keyof Vector = selected?.trackingMode === 'hours' ? 'minutes' : selected?.trackingMode === 'budget' ? 'budgetMinor' : 'appointments';
  const committed = detail ? sum(detail.fundingPeriods, 'committed', metric) : 0;
  const used = detail ? sum(detail.fundingPeriods, 'used', metric) : 0;
  const total = detail?.fundingPeriods.reduce((value, row) => value + row.allowed[metric] + row.rollover[metric], 0) ?? 0;
  const displayUnits = (value: number) => selected?.trackingMode === 'budget' ? money(value) : selected?.trackingMode === 'hours' ? `${(value / 60).toFixed(value % 60 ? 1 : 0)} h` : String(value);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cases & funding"
        desc="Staff-entered coverage rules, exact committed and used balances, expiry queues and immutable booking allocation events. No case or funding history is inferred."
        actions={<Button onClick={() => setShowCreate((value) => !value)}>{showCreate ? 'Close form' : 'New case'}</Button>}
      />

      <div className="rounded-2xl border border-amber-400/25 bg-amber-50/70 px-4 py-3 text-[12px] leading-relaxed text-amber-900">
        Enforcement starts in <strong>shadow</strong> mode. Move a reviewed case to enforced mode only after its periods, prices, cancellation policy and authorisation evidence are complete. Overrides require a separate permission and an immutable reason.
      </div>
      {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-50 px-4 py-3 text-[12px] text-red-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-50 px-4 py-3 text-[12px] text-emerald-800">{notice}</div> : null}

      {showCreate ? (
        <section className="panel p-5">
          <h2 className="text-[15px] font-semibold text-slate-900">Create a draft case</h2>
          <p className="mt-1 text-[11.5px] text-slateink-400">Case numbers and limits are entered by staff. The case does not attach historical appointments.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[11px] font-medium text-slateink-500">Client<select className="input mt-1 w-full" value={draft.patientId} onChange={(event) => setDraft({ ...draft, patientId: event.target.value })}><option value="">Select client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
            <label className="text-[11px] font-medium text-slateink-500">Case name<input className="input mt-1 w-full" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="text-[11px] font-medium text-slateink-500">Staff case number<input className="input mt-1 w-full" value={draft.number} onChange={(event) => setDraft({ ...draft, number: event.target.value })} /></label>
            <label className="text-[11px] font-medium text-slateink-500">Type<select className="input mt-1 w-full" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}><option value="private">Private</option><option value="insurance">Insurance</option><option value="employer">Employer</option><option value="other">Other</option></select></label>
            <label className="text-[11px] font-medium text-slateink-500">Starts<input type="date" className="input mt-1 w-full" value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} /></label>
            <label className="text-[11px] font-medium text-slateink-500">Ends (optional)<input type="date" className="input mt-1 w-full" value={draft.endsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} /></label>
            <label className="text-[11px] font-medium text-slateink-500">Track<select className="input mt-1 w-full" value={draft.trackingMode} onChange={(event) => setDraft({ ...draft, trackingMode: event.target.value, limit: event.target.value === 'budget' ? '100000' : '10' })}><option value="appointments">Appointments</option><option value="hours">Hours</option><option value="budget">Budget (pence)</option></select></label>
            <label className="text-[11px] font-medium text-slateink-500">Case limit<input type="number" min="1" className="input mt-1 w-full" value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: event.target.value })} /></label>
            <label className="text-[11px] font-medium text-slateink-500">Limit policy<select className="input mt-1 w-full" value={draft.limitPolicy} onChange={(event) => setDraft({ ...draft, limitPolicy: event.target.value })}><option value="warn">Warn</option><option value="block">Block</option></select></label>
            <label className="text-[11px] font-medium text-slateink-500">Enforcement<select className="input mt-1 w-full" value={draft.enforcementMode} onChange={(event) => setDraft({ ...draft, enforcementMode: event.target.value })}><option value="shadow">Shadow compute</option><option value="enforced">Enforced</option></select></label>
            <label className="text-[11px] font-medium text-slateink-500">Warning at %<input type="number" min="1" max="100" className="input mt-1 w-full" value={draft.warningThresholdPct} onChange={(event) => setDraft({ ...draft, warningThresholdPct: event.target.value })} /></label>
          </div>
          <div className="mt-4"><Button disabled={busy} onClick={() => void createCase()}>{busy ? 'Saving…' : 'Create draft case'}</Button></div>
        </section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.8fr)] xl:items-start">
        <section className="panel overflow-hidden">
          <div className="border-b border-slate-900/[0.06] px-5 py-4"><h2 className="text-[14px] font-semibold text-slate-900">Case queue</h2><p className="mt-1 text-[11px] text-slateink-400">{cases.length} visible case(s)</p></div>
          <div className="divide-y divide-slate-900/[0.05]">
            {cases.map((row) => (
              <button key={row.id} type="button" onClick={() => setSelectedId(row.id)} className={`block w-full px-5 py-4 text-left transition ${selectedId === row.id ? 'bg-brand-50/70' : 'hover:bg-slate-50'}`}>
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-[13px] font-semibold text-slate-900">{row.name}</p><p className="mt-1 truncate text-[11px] text-slateink-400">{clientName(row.patientId)} · {row.number}</p></div><Pill tone={row.status === 'active' ? 'brand' : row.status === 'closed' ? 'default' : 'warn'}>{row.status}</Pill></div>
                <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-slateink-300">{row.trackingMode} · {row.limitPolicy}/{row.enforcementMode}</p>
              </button>
            ))}
            {!cases.length ? <p className="px-5 py-8 text-center text-[12px] text-slateink-400">No cases are visible in your scope.</p> : null}
          </div>
        </section>

        <section className="space-y-5">
          {!detail ? <div className="panel p-8 text-center text-[12px] text-slateink-400">Choose a case to review its exact funding evidence.</div> : (
            <>
              <div className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-[17px] font-semibold text-slate-900">{detail.case.name}</h2><Pill tone={detail.case.status === 'active' ? 'brand' : 'warn'}>{detail.case.status}</Pill><Pill tone={detail.case.enforcementMode === 'enforced' ? 'warn' : 'default'}>{detail.case.enforcementMode}</Pill></div><p className="mt-1 text-[11.5px] text-slateink-400">{clientName(detail.case.patientId)} · {detail.case.number} · {detail.case.startsOn}{detail.case.endsOn ? ` to ${detail.case.endsOn}` : ''}</p></div><div className="flex gap-2">{detail.case.status === 'draft' || detail.case.status === 'paused' ? <Button disabled={busy || !detail.fundingPeriods.length || !detail.serviceRules.length} onClick={() => setStatus('active')}>Activate</Button> : null}{detail.case.status === 'active' ? <Button variant="ghost" disabled={busy} onClick={() => setStatus('paused')}>Pause</Button> : null}</div></div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl bg-slate-900/[0.035] p-3"><p className="text-[9.5px] uppercase tracking-[0.12em] text-slateink-300">Committed</p><p className="mt-1 text-[19px] font-semibold text-slate-900">{displayUnits(committed)}</p></div>
                  <div className="rounded-xl bg-slate-900/[0.035] p-3"><p className="text-[9.5px] uppercase tracking-[0.12em] text-slateink-300">Used</p><p className="mt-1 text-[19px] font-semibold text-slate-900">{displayUnits(used)}</p></div>
                  <div className="rounded-xl bg-slate-900/[0.035] p-3"><p className="text-[9.5px] uppercase tracking-[0.12em] text-slateink-300">Period allowance</p><p className="mt-1 text-[19px] font-semibold text-slate-900">{displayUnits(total)}</p></div>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <section className="panel p-5">
                  <h3 className="text-[14px] font-semibold text-slate-900">Funding periods</h3>
                  <div className="mt-3 space-y-2">{detail.fundingPeriods.map((row) => <div key={row.id} className="rounded-xl border border-slate-900/[0.06] p-3 text-[11px]"><div className="flex justify-between gap-3"><span className="font-medium text-slate-800">{row.startsOn} – {row.endsOn}</span><span className="text-slateink-400">rev {row.revision}</span></div><p className="mt-1 text-slateink-400">Committed {displayUnits(row.committed[metric])} · used {displayUnits(row.used[metric])} · allowed {displayUnits(row.allowed[metric] + row.rollover[metric])}</p></div>)}</div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2"><label className="text-[10.5px] text-slateink-500">From<input type="date" className="input mt-1 w-full" value={period.startsOn} onChange={(event) => setPeriod({ ...period, startsOn: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">To<input type="date" className="input mt-1 w-full" value={period.endsOn} onChange={(event) => setPeriod({ ...period, endsOn: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">Allowance ({detail.case.trackingMode})<input type="number" min="0" className="input mt-1 w-full" value={period.allowance} onChange={(event) => setPeriod({ ...period, allowance: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">Staff-entered rollover<input type="number" min="0" className="input mt-1 w-full" value={period.rollover} onChange={(event) => setPeriod({ ...period, rollover: event.target.value })} /></label></div>
                  <div className="mt-3"><Button variant="ghost" disabled={busy} onClick={addPeriod}>Add period</Button></div>
                </section>

                <section className="panel p-5">
                  <h3 className="text-[14px] font-semibold text-slate-900">Service rules</h3>
                  <div className="mt-3 space-y-2">{detail.serviceRules.map((row) => <div key={row.id} className="rounded-xl border border-slate-900/[0.06] p-3 text-[11px]"><div className="flex justify-between gap-3"><span className="font-medium text-slate-800">{services.find((service) => service.id === row.serviceId)?.name ?? 'All matching services'}</span><Pill tone={row.active ? 'brand' : 'default'}>{row.active ? 'active' : 'inactive'}</Pill></div><p className="mt-1 text-slateink-400">{money(row.fundedPriceMinor)} per {row.unit} + {(row.taxRateBps / 100).toFixed(2)}% tax · no-show {row.noShowPolicy} · late cancel {row.lateCancelPolicy}</p></div>)}</div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2"><label className="text-[10.5px] text-slateink-500">Service<select className="input mt-1 w-full" value={rule.serviceId} onChange={(event) => setRule({ ...rule, serviceId: event.target.value })}><option value="">All services</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label><label className="text-[10.5px] text-slateink-500">Practitioner<select className="input mt-1 w-full" value={rule.providerId} onChange={(event) => setRule({ ...rule, providerId: event.target.value })}><option value="">Any assigned</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="text-[10.5px] text-slateink-500">Valid from<input type="date" className="input mt-1 w-full" value={rule.startsOn} onChange={(event) => setRule({ ...rule, startsOn: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">Valid to<input type="date" className="input mt-1 w-full" value={rule.endsOn} onChange={(event) => setRule({ ...rule, endsOn: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">Price (pence)<input type="number" min="0" className="input mt-1 w-full" value={rule.fundedPriceMinor} onChange={(event) => setRule({ ...rule, fundedPriceMinor: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">Tax %<input type="number" min="0" step="0.01" className="input mt-1 w-full" value={rule.taxRatePct} onChange={(event) => setRule({ ...rule, taxRatePct: event.target.value })} /></label><label className="text-[10.5px] text-slateink-500">No-show<select className="input mt-1 w-full" value={rule.noShowPolicy} onChange={(event) => setRule({ ...rule, noShowPolicy: event.target.value })}><option value="release">Release</option><option value="consume">Consume</option></select></label><label className="text-[10.5px] text-slateink-500">Late cancellation<select className="input mt-1 w-full" value={rule.lateCancelPolicy} onChange={(event) => setRule({ ...rule, lateCancelPolicy: event.target.value })}><option value="release">Release</option><option value="consume">Consume</option></select></label><label className="text-[10.5px] text-slateink-500">Late window (hours)<input type="number" min="0" className="input mt-1 w-full" value={rule.lateCancellationHours} onChange={(event) => setRule({ ...rule, lateCancellationHours: event.target.value })} /></label><label className="flex items-center gap-2 pt-5 text-[10.5px] text-slateink-500"><input type="checkbox" checked={rule.requiresAuthorisation} onChange={(event) => setRule({ ...rule, requiresAuthorisation: event.target.checked })} /> Require explicit authorisation</label></div>
                  <div className="mt-3"><Button variant="ghost" disabled={busy} onClick={addRule}>Add rule</Button></div>
                </section>
              </div>

              <section className="panel p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-[14px] font-semibold text-slate-900">Authorisation expiry queue</h3><p className="mt-1 text-[11px] text-slateink-400">Missing records remain blocked; Voxera never invents a payer or authorisation.</p></div><Pill tone={detail.authorisations.some((row) => row.status === 'active' && row.endsOn <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)) ? 'warn' : 'default'}>{detail.authorisations.length} record(s)</Pill></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{detail.authorisations.map((row) => <div key={row.id} className="rounded-xl border border-slate-900/[0.06] p-3 text-[11px]"><p className="font-medium text-slate-800">{row.externalReference}</p><p className="mt-1 text-slateink-400">{row.status} · ends {row.endsOn}</p></div>)}{!detail.authorisations.length ? <p className="text-[11.5px] text-slateink-400">No authorisation has been entered.</p> : null}</div></section>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
