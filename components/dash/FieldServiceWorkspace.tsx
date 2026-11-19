'use client';

import * as React from 'react';
import Link from 'next/link';
import { request } from '@/lib/server-sync';
import { minorUnits } from '@/lib/server/money-format';
import { cn, fmtDate } from '@/lib/utils';
import { Icons } from '@/components/icons';
import { Button, EmptyState, Modal, Pill, useToast } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

type Mode = 'enquiries' | 'estimates' | 'jobs' | 'dispatch';
type Site = { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country?: string };
type Customer = { name: string; number: string; email?: string };
type EstimateLine = { id: string; description: string; quantity: number; unitAmountMinor: number; taxRatePct: number; netMinor: number; taxMinor: number; totalMinor: number; code?: string };
type DraftLine = { description: string; quantity: string; unitPrice: string; taxRatePct: string };

type Enquiry = {
  id: string; reference: string; clientId: string; customer: Customer; description: string; urgency: string; siteAddress: Site;
  status: string; source: string; estimateIds: string[]; jobId?: string; assignedTo?: string; createdAt: string; updatedAt: string;
};
type Estimate = {
  id: string; reference: string; enquiryId?: string; clientId: string; customer: Customer; siteAddress: Site; description?: string;
  status: string; currency: string; version: number; lines: EstimateLine[]; subtotalMinor: number; taxMinor: number; totalMinor: number;
  validUntil: string; notes?: string; jobId?: string; createdAt: string; updatedAt: string;
};
type Job = {
  id: string; reference: string; enquiryId?: string; estimateId?: string; clientId: string; customer: Customer; siteAddress: Site;
  description: string; status: string; currency: string; lines: EstimateLine[]; visitIds: string[]; invoiceId?: string;
  workSummary?: string; createdAt: string; updatedAt: string;
};
type Visit = {
  id: string; jobId: string; reference: string; bookingId?: string; startsAt?: string; durationMinutes: number; providerId?: string;
  locationId?: string; serviceId?: string; status: string; travelBufferMinutes: number; instructions?: string; workPerformed?: string;
  completionNote?: string; createdAt: string; updatedAt: string;
};
type Provider = { id: string; name: string; title?: string; active: boolean; locationIds: string[]; serviceIds: string[] };
type Location = { id: string; name: string; timezone: string; active: boolean };
type Service = { id: string; name: string; durationMinutes: number; active: boolean };
type Summary = {
  enquiries: { open: number; urgent: number };
  estimates: { drafts: number; awaitingDecision: number; accepted: number };
  jobs: { active: number; unassigned: number; completedUninvoiced: number };
  visits: { today: number; inProgress: number };
};

type List<T> = { data: T[]; summary?: Summary };

const EMPTY_SITE: Site = { line1: '', city: '', region: '', postalCode: '', country: '' };
const EMPTY_LINE: DraftLine = { description: '', quantity: '1', unitPrice: '', taxRatePct: '0' };
const NAV: Array<{ id: Mode; href: string; label: string }> = [
  { id: 'enquiries', href: '/dashboard/enquiries', label: 'Enquiries' },
  { id: 'estimates', href: '/dashboard/estimates', label: 'Estimates' },
  { id: 'jobs', href: '/dashboard/jobs', label: 'Jobs' },
  { id: 'dispatch', href: '/dashboard/dispatch', label: 'Dispatch' },
];

function money(amountMinor: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 10 ** minorUnits(currency));
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function toMinor(value: string, currency: string) {
  const amount = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 10 ** minorUnits(currency)) : 0;
}

function site(siteAddress: Site) {
  return [siteAddress.line1, siteAddress.line2, siteAddress.city, siteAddress.region, siteAddress.postalCode, siteAddress.country].filter(Boolean).join(', ');
}

function tone(status: string): 'default' | 'brand' | 'warn' | 'danger' | 'info' {
  if (['accepted', 'won', 'completed', 'paid'].includes(status)) return 'brand';
  if (['urgent', 'emergency', 'cancelled', 'lost', 'declined'].includes(status)) return 'danger';
  if (['draft', 'unassigned', 'expired'].includes(status)) return 'warn';
  if (['scheduled', 'sent', 'en_route', 'on_site', 'in_progress', 'qualified', 'quoted'].includes(status)) return 'info';
  return 'default';
}

function Status({ value }: { value: string }) {
  return <Pill tone={tone(value)}>{value.replaceAll('_', ' ')}</Pill>;
}

function SiteFields({ value, onChange }: { value: Site; onChange: (value: Site) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><label className="label">Service address</label><input aria-label="Service address" className="field" value={value.line1} onChange={(event) => onChange({ ...value, line1: event.target.value })} placeholder="Address line 1" /></div>
      <div><label className="label">City / locality</label><input aria-label="City or locality" className="field" value={value.city} onChange={(event) => onChange({ ...value, city: event.target.value })} /></div>
      <div><label className="label">Region</label><input aria-label="Region" className="field" value={value.region ?? ''} onChange={(event) => onChange({ ...value, region: event.target.value })} /></div>
      <div><label className="label">Postal code</label><input aria-label="Postal code" className="field" value={value.postalCode ?? ''} onChange={(event) => onChange({ ...value, postalCode: event.target.value })} /></div>
      <div><label className="label">Country code</label><input aria-label="Country code" className="field uppercase" maxLength={2} value={value.country ?? ''} onChange={(event) => onChange({ ...value, country: event.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} placeholder="GB" /></div>
    </div>
  );
}

function LineEditor({ lines, setLines, currency }: { lines: DraftLine[]; setLines: React.Dispatch<React.SetStateAction<DraftLine[]>>; currency: string }) {
  const change = (index: number, patch: Partial<DraftLine>) => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3"><label className="label mb-0">Line items</label><Button variant="quiet" size="sm" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}><Icons.plus size={12} /> Add line</Button></div>
      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 rounded-xl border border-slate-900/[0.05] p-3 sm:grid-cols-[minmax(160px,1fr)_80px_110px_78px_32px] sm:items-end">
            <div><label className="label">Description</label><input aria-label={`Line ${index + 1} description`} className="field" value={line.description} onChange={(event) => change(index, { description: event.target.value })} /></div>
            <div><label className="label">Qty</label><input aria-label={`Line ${index + 1} quantity`} className="field" type="number" min="0.01" step="0.01" value={line.quantity} onChange={(event) => change(index, { quantity: event.target.value })} /></div>
            <div><label className="label">Unit ({currency})</label><input aria-label={`Line ${index + 1} unit amount in ${currency}`} className="field" inputMode="decimal" value={line.unitPrice} onChange={(event) => change(index, { unitPrice: event.target.value })} /></div>
            <div><label className="label">Tax %</label><input aria-label={`Line ${index + 1} tax percentage`} className="field" type="number" min="0" max="100" step="0.1" value={line.taxRatePct} onChange={(event) => change(index, { taxRatePct: event.target.value })} /></div>
            <button type="button" aria-label={`Remove line ${index + 1}`} className="btn-quiet mb-1 p-2" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, i) => i !== index))}><Icons.trash size={13} /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 text-right font-mono text-[11px] text-slateink-400">
        Draft total before per-line tax: {money(lines.reduce((sum, line) => sum + Number(line.quantity || 0) * toMinor(line.unitPrice, currency), 0), currency)}
      </div>
    </div>
  );
}

function SummaryCards({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  const cards = [
    ['Open enquiries', summary.enquiries.open, `${summary.enquiries.urgent} urgent`],
    ['Awaiting estimate decision', summary.estimates.awaitingDecision, `${summary.estimates.drafts} drafts`],
    ['Active jobs', summary.jobs.active, `${summary.jobs.unassigned} unassigned visits`],
    ["Today's visits", summary.visits.today, `${summary.visits.inProgress} in progress`],
  ];
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, detail]) => <div key={String(label)} className="panel p-4"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">{label}</div><div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div><div className="mt-1 text-[11.5px] text-slateink-400">{detail}</div></div>)}</div>;
}

export function FieldServiceWorkspace({ mode }: { mode: Mode }) {
  const toast = useToast();
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [enquiries, setEnquiries] = React.useState<Enquiry[]>([]);
  const [estimates, setEstimates] = React.useState<Estimate[]>([]);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [visits, setVisits] = React.useState<Visit[]>([]);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [locations, setLocations] = React.useState<Location[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [currency, setCurrency] = React.useState('USD');
  const [selectedEstimate, setSelectedEstimate] = React.useState<Estimate | null>(null);
  const [selectedJob, setSelectedJob] = React.useState<Job | null>(null);
  const [shareLink, setShareLink] = React.useState('');

  const [enquiryOpen, setEnquiryOpen] = React.useState(false);
  const [estimateOpen, setEstimateOpen] = React.useState(false);
  const [jobOpen, setJobOpen] = React.useState(false);
  const [visitOpen, setVisitOpen] = React.useState(false);
  const [scheduleVisit, setScheduleVisit] = React.useState<Visit | null>(null);
  const [estimateSource, setEstimateSource] = React.useState<Enquiry | null>(null);
  const [editEstimate, setEditEstimate] = React.useState<Estimate | null>(null);

  // Enquiry form.
  const [customer, setCustomer] = React.useState<Customer>({ name: '', number: '', email: '' });
  const [description, setDescription] = React.useState('');
  const [urgency, setUrgency] = React.useState('routine');
  const [siteAddress, setSiteAddress] = React.useState<Site>({ ...EMPTY_SITE });
  // Estimate/job lines.
  const [lines, setLines] = React.useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [validUntil, setValidUntil] = React.useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [notes, setNotes] = React.useState('');
  // Visit form.
  const [visitJobId, setVisitJobId] = React.useState('');
  const [visitDuration, setVisitDuration] = React.useState('60');
  const [travelBuffer, setTravelBuffer] = React.useState('15');
  const [instructions, setInstructions] = React.useState('');
  const [startsAt, setStartsAt] = React.useState('');
  const [providerId, setProviderId] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const [serviceId, setServiceId] = React.useState('');

  const load = React.useCallback(async () => {
    setError('');
    try {
      const [enq, est, job, visit, provider, location, service, profile] = await Promise.all([
        request<List<Enquiry>>('GET', '/api/v1/enquiries'),
        request<List<Estimate>>('GET', '/api/v1/estimates'),
        request<List<Job>>('GET', '/api/v1/jobs'),
        request<List<Visit>>('GET', '/api/v1/visits'),
        request<List<Provider>>('GET', '/api/v1/providers?includeInactive=false'),
        request<List<Location>>('GET', '/api/v1/locations?includeInactive=false'),
        request<List<Service>>('GET', '/api/v1/services?includeInactive=false'),
        request<{ business: { currency?: string }; money: { currency: string } }>('GET', '/api/v1/workspace/profile'),
      ]);
      setEnquiries(enq.data ?? []); setEstimates(est.data ?? []); setJobs(job.data ?? []); setVisits(visit.data ?? []);
      setProviders(provider.data ?? []); setLocations(location.data ?? []); setServices(service.data ?? []);
      setSummary(enq.summary ?? est.summary ?? job.summary ?? visit.summary ?? null);
      setCurrency(profile.business.currency ?? profile.money.currency ?? 'USD');
      setSelectedEstimate((current) => current ? (est.data ?? []).find((row) => row.id === current.id) ?? null : null);
      setSelectedJob((current) => current ? (job.data ?? []).find((row) => row.id === current.id) ?? null : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Field-service records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    if (mode === 'enquiries' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1') setEnquiryOpen(true);
  }, [mode]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await action(); await load(); }
    catch (err) { const message = err instanceof Error ? err.message : 'That action failed.'; setError(message); toast(message, 'error'); }
    finally { setBusy(''); }
  };

  const resetCommon = () => { setCustomer({ name: '', number: '', email: '' }); setDescription(''); setUrgency('routine'); setSiteAddress({ ...EMPTY_SITE }); setLines([{ ...EMPTY_LINE }]); setNotes(''); };
  const linePayload = () => lines.map((line) => ({ description: line.description, quantity: Number(line.quantity), unitAmountMinor: toMinor(line.unitPrice, currency), taxRatePct: Number(line.taxRatePct) }));

  const openEstimateFor = (enquiry: Enquiry) => {
    setEstimateSource(enquiry); setEditEstimate(null); setDescription(enquiry.description); setSiteAddress({ ...enquiry.siteAddress }); setLines([{ ...EMPTY_LINE }]); setNotes(''); setEstimateOpen(true);
  };
  const openEstimateEdit = (estimate: Estimate) => {
    setEstimateSource(null); setEditEstimate(estimate); setDescription(estimate.description ?? ''); setSiteAddress({ ...estimate.siteAddress });
    setLines(estimate.lines.map((line) => ({ description: line.description, quantity: String(line.quantity), unitPrice: String(line.unitAmountMinor / 10 ** minorUnits(estimate.currency)), taxRatePct: String(line.taxRatePct) })));
    setValidUntil(estimate.validUntil); setNotes(estimate.notes ?? ''); setEstimateOpen(true);
  };
  const openVisitFor = (job: Job) => { setVisitJobId(job.id); setVisitDuration('60'); setTravelBuffer('15'); setInstructions(''); setVisitOpen(true); };
  const openSchedule = (visit: Visit) => {
    setScheduleVisit(visit); setStartsAt(visit.startsAt ? new Date(visit.startsAt).toISOString().slice(0, 16) : ''); setProviderId(visit.providerId ?? '');
    setLocationId(visit.locationId ?? ''); setServiceId(visit.serviceId ?? ''); setVisitDuration(String(visit.durationMinutes)); setTravelBuffer(String(visit.travelBufferMinutes));
  };

  const title = mode === 'enquiries' ? 'Contractor enquiries' : mode === 'estimates' ? 'Estimates' : mode === 'jobs' ? 'Jobs' : 'Dispatch';
  const desc = mode === 'enquiries'
    ? 'Capture the customer, work requested, urgency and the service address before quoting.'
    : mode === 'estimates'
      ? 'Build reviewed line-item estimates, share a single-use decision link and convert accepted work.'
      : mode === 'jobs'
        ? 'Keep the job lifecycle separate from its visits, completion record and invoice.'
        : 'Assign and move visits against real working hours, breaks and diary conflicts.';

  const headerAction = mode === 'enquiries'
    ? <Button variant="brand" size="sm" onClick={() => { resetCommon(); setEnquiryOpen(true); }}><Icons.plus size={13} /> New enquiry</Button>
    : mode === 'jobs'
      ? <Button variant="brand" size="sm" onClick={() => { resetCommon(); setJobOpen(true); }}><Icons.plus size={13} /> New direct job</Button>
      : mode === 'dispatch'
        ? <Button variant="ghost" size="sm" onClick={() => void load()}><Icons.refresh size={13} /> Refresh dispatch</Button>
        : null;

  const jobFor = (visit: Visit) => jobs.find((job) => job.id === visit.jobId);
  const providerName = (id?: string) => providers.find((row) => row.id === id)?.name ?? 'Unassigned';
  const locationName = (id?: string) => locations.find((row) => row.id === id)?.name ?? 'No dispatch location';

  return (
    <div className="space-y-5">
      <PageHeader title={title} desc={desc} breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Field service' }, { label: title }]} actions={headerAction} />
      <nav aria-label="Field service" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-900/[0.05] bg-ink-900/30 p-1">
        {NAV.map((item) => <Link key={item.id} href={item.href} prefetch={false} className={cn('shrink-0 rounded-lg px-3.5 py-2 text-[12.5px] transition-colors', item.id === mode ? 'bg-slate-900/[0.07] font-medium text-slate-900' : 'text-slateink-400 hover:text-slate-900')}>{item.label}</Link>)}
      </nav>
      <SummaryCards summary={summary} />
      {error && <div role="alert" className="rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-[12.5px] text-rose-700">{error}</div>}
      {loading ? <div className="panel p-6"><div className="h-4 w-48 animate-pulse rounded bg-slate-900/[0.06]" /></div> : null}

      {!loading && mode === 'enquiries' && (
        enquiries.length ? <div className="space-y-3">{enquiries.map((enquiry) => (
          <article key={enquiry.id} className="panel p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[11px] text-brand-700">{enquiry.reference}</span><Status value={enquiry.status} /><Status value={enquiry.urgency} /></div><h2 className="mt-2 text-[14px] font-semibold">{enquiry.customer.name}</h2><p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-slateink-300">{enquiry.description}</p><p className="mt-2 text-[11.5px] text-slateink-400">{site(enquiry.siteAddress)} · {enquiry.customer.number}</p></div>
              <div className="flex flex-wrap gap-2">
                {['new', 'qualified'].includes(enquiry.status) && <Button variant="brand" size="sm" onClick={() => openEstimateFor(enquiry)}>Create estimate</Button>}
                {enquiry.status === 'new' && <Button variant="ghost" size="sm" onClick={() => void run(`qualify-${enquiry.id}`, async () => { await request('POST', `/api/v1/enquiries/${enquiry.id}`, { action: 'status', status: 'qualified' }); })}>Qualify</Button>}
                {!['lost', 'closed', 'won'].includes(enquiry.status) && <Button variant="quiet" size="sm" onClick={() => void run(`lose-${enquiry.id}`, async () => { await request('POST', `/api/v1/enquiries/${enquiry.id}`, { action: 'status', status: 'lost', note: 'Marked lost from enquiry list' }); })}>Mark lost</Button>}
              </div>
            </div>
          </article>
        ))}</div> : <EmptyState icon="send" title="No contractor enquiries yet" desc="Capture a real customer request and service address. No sample customer is created for you." action={<Button variant="brand" onClick={() => setEnquiryOpen(true)}><Icons.plus size={13} /> New enquiry</Button>} />
      )}

      {!loading && mode === 'estimates' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)] xl:items-start">
          <div className="space-y-3">{estimates.length ? estimates.map((estimate) => (
            <button key={estimate.id} onClick={() => { setSelectedEstimate(estimate); setShareLink(''); }} className={cn('panel w-full p-4 text-left transition-colors sm:p-5', selectedEstimate?.id === estimate.id && 'border-brand-500/35')}>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="font-mono text-[11px] text-brand-700">{estimate.reference}</span><Status value={estimate.status} /></div><div className="mt-2 text-[14px] font-semibold">{estimate.customer.name}</div><div className="mt-1 text-[11.5px] text-slateink-400">Version {estimate.version} · valid to {estimate.validUntil}</div></div><div className="text-right"><div className="font-mono text-[16px] font-semibold">{money(estimate.totalMinor, estimate.currency)}</div><div className="mt-1 text-[10.5px] text-slateink-400">{estimate.lines.length} line{estimate.lines.length === 1 ? '' : 's'}</div></div></div>
            </button>
          )) : <EmptyState icon="layers" title="No estimates yet" desc="Start with an enquiry so the customer and service address carry through without retyping." action={<Link href="/dashboard/enquiries" className="btn-brand btn-sm">Open enquiries</Link>} />}</div>
          <aside className="panel p-5 xl:sticky xl:top-[74px]">
            {selectedEstimate ? <div>
              <div className="flex items-start justify-between gap-3"><div><div className="font-mono text-[10.5px] text-brand-700">{selectedEstimate.reference}</div><h2 className="mt-1 text-[15px] font-semibold">{selectedEstimate.customer.name}</h2></div><Status value={selectedEstimate.status} /></div>
              <p className="mt-3 text-[12px] leading-relaxed text-slateink-400">{selectedEstimate.description}</p>
              <div className="mt-4 space-y-2 border-y border-slate-900/[0.05] py-4">{selectedEstimate.lines.map((line) => <div key={line.id} className="flex justify-between gap-4 text-[12px]"><span className="text-slateink-300">{line.quantity} × {line.description}</span><span className="font-mono">{money(line.totalMinor, selectedEstimate.currency)}</span></div>)}</div>
              <div className="mt-3 flex items-center justify-between text-[14px] font-semibold"><span>Total</span><span className="font-mono text-brand-700">{money(selectedEstimate.totalMinor, selectedEstimate.currency)}</span></div>
              <div className="mt-5 flex flex-wrap gap-2">
                {selectedEstimate.status === 'draft' && <><Button variant="ghost" size="sm" onClick={() => openEstimateEdit(selectedEstimate)}>Edit draft</Button><Button variant="brand" size="sm" disabled={busy === `share-${selectedEstimate.id}`} onClick={() => void run(`share-${selectedEstimate.id}`, async () => { const result = await request<{ acceptUrl: string }>('POST', `/api/v1/estimates/${selectedEstimate.id}`, { action: 'share' }); setShareLink(result.acceptUrl); toast('Secure decision link created. It has not been sent.', 'success'); })}>Create decision link</Button></>}
                {selectedEstimate.status === 'accepted' && !selectedEstimate.jobId && <Button variant="brand" size="sm" onClick={() => void run(`convert-${selectedEstimate.id}`, async () => { const job = await request<Job>('POST', `/api/v1/estimates/${selectedEstimate.id}`, { action: 'convert' }); toast(`${job.reference} created.`, 'success'); setSelectedEstimate(null); })}>Convert to job</Button>}
                {['sent', 'declined', 'expired'].includes(selectedEstimate.status) && <Button variant="ghost" size="sm" onClick={() => void run(`revise-${selectedEstimate.id}`, async () => { const revised = await request<Estimate>('POST', `/api/v1/estimates/${selectedEstimate.id}`, { action: 'revise' }); setSelectedEstimate(revised); toast(`Draft version ${revised.version} created.`, 'success'); })}>Create revision</Button>}
                {selectedEstimate.jobId && <Link href="/dashboard/jobs" className="btn-ghost btn-sm">Open job</Link>}
              </div>
              {shareLink && <div className="mt-4 rounded-xl border border-brand-500/25 bg-brand-500/[0.06] p-3"><div className="font-mono text-[9.5px] uppercase tracking-wide text-brand-700">Not sent · secure one-use link</div><input aria-label="Secure decision link" className="field mt-2 font-mono text-[10.5px]" readOnly value={shareLink} /><Button variant="quiet" size="sm" className="mt-2" onClick={() => void navigator.clipboard.writeText(shareLink).then(() => toast('Link copied.'))}>Copy link</Button></div>}
            </div> : <div className="py-8 text-center text-[12.5px] text-slateink-400">Choose an estimate to review its exact lines and next valid action.</div>}
          </aside>
        </div>
      )}

      {!loading && mode === 'jobs' && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)] xl:items-start">
          <div className="space-y-3">{jobs.length ? jobs.map((job) => <button key={job.id} onClick={() => setSelectedJob(job)} className={cn('panel w-full p-4 text-left sm:p-5', selectedJob?.id === job.id && 'border-brand-500/35')}><div className="flex flex-wrap justify-between gap-3"><div><div className="flex items-center gap-2"><span className="font-mono text-[11px] text-brand-700">{job.reference}</span><Status value={job.status} /></div><div className="mt-2 text-[14px] font-semibold">{job.customer.name}</div><p className="mt-1 max-w-2xl text-[12px] text-slateink-300">{job.description}</p><p className="mt-2 text-[11px] text-slateink-400">{site(job.siteAddress)}</p></div><div className="text-right text-[11.5px] text-slateink-400">{job.visitIds.length} visit{job.visitIds.length === 1 ? '' : 's'}<br />{job.invoiceId ? 'invoice drafted' : job.status === 'completed' ? 'ready to invoice' : 'not yet invoiced'}</div></div></button>) : <EmptyState icon="briefcase" title="No jobs yet" desc="Convert an accepted estimate, or create a direct job when no estimate is needed." action={<Button variant="brand" onClick={() => setJobOpen(true)}>Create direct job</Button>} />}</div>
          <aside className="panel p-5 xl:sticky xl:top-[74px]">{selectedJob ? <div><div className="flex items-start justify-between gap-3"><div><div className="font-mono text-[10.5px] text-brand-700">{selectedJob.reference}</div><h2 className="mt-1 text-[15px] font-semibold">{selectedJob.customer.name}</h2></div><Status value={selectedJob.status} /></div><p className="mt-3 text-[12.5px] text-slateink-300">{selectedJob.description}</p><p className="mt-2 text-[11.5px] text-slateink-400">{site(selectedJob.siteAddress)}</p>
            <div className="mt-4 rounded-xl border border-slate-900/[0.05] p-3"><div className="font-mono text-[9.5px] uppercase tracking-wide text-slateink-400">Visits</div>{visits.filter((visit) => visit.jobId === selectedJob.id).length ? <div className="mt-2 space-y-2">{visits.filter((visit) => visit.jobId === selectedJob.id).map((visit) => <div key={visit.id} className="flex items-center justify-between gap-3 text-[11.5px]"><span>{visit.reference} · {visit.startsAt ? fmtDate(visit.startsAt) : 'not scheduled'}</span><Status value={visit.status} /></div>)}</div> : <p className="mt-2 text-[11.5px] text-slateink-400">No visits yet.</p>}</div>
            <div className="mt-5 flex flex-wrap gap-2">
              {!['completed', 'cancelled'].includes(selectedJob.status) && <Button variant="brand" size="sm" onClick={() => openVisitFor(selectedJob)}>Add visit</Button>}
              {selectedJob.status === 'scheduled' && <Button variant="ghost" size="sm" onClick={() => void run(`start-${selectedJob.id}`, async () => { await request('POST', `/api/v1/jobs/${selectedJob.id}`, { action: 'status', status: 'in_progress' }); })}>Start job</Button>}
              {['scheduled', 'in_progress'].includes(selectedJob.status) && <Button variant="ghost" size="sm" onClick={() => void run(`complete-${selectedJob.id}`, async () => { await request('POST', `/api/v1/jobs/${selectedJob.id}`, { action: 'status', status: 'completed' }); })}>Complete job</Button>}
              {!['completed', 'cancelled'].includes(selectedJob.status) && <Button variant="quiet" size="sm" onClick={() => void run(`cancel-${selectedJob.id}`, async () => { await request('POST', `/api/v1/jobs/${selectedJob.id}`, { action: 'status', status: 'cancelled' }); })}>Cancel</Button>}
              {['completed', 'cancelled'].includes(selectedJob.status) && <Button variant="quiet" size="sm" onClick={() => void run(`reopen-${selectedJob.id}`, async () => { await request('POST', `/api/v1/jobs/${selectedJob.id}`, { action: 'reopen' }); })}>Reopen</Button>}
              {selectedJob.status === 'completed' && !selectedJob.invoiceId && <Button variant="brand" size="sm" onClick={() => void run(`invoice-${selectedJob.id}`, async () => { const result = await request<{ invoice: { id: string } }>('POST', `/api/v1/jobs/${selectedJob.id}`, { action: 'invoice' }); toast('Draft invoice created. Review it before issue.', 'success'); void result; })}>Draft invoice</Button>}
              {selectedJob.invoiceId && <Link className="btn-ghost btn-sm" href="/dashboard/money">Open invoice</Link>}
            </div></div> : <div className="py-8 text-center text-[12.5px] text-slateink-400">Choose a job to manage its visits, completion and invoice.</div>}</aside>
        </div>
      )}

      {!loading && mode === 'dispatch' && (
        <div className="space-y-5">
          {providers.length === 0 || locations.length === 0 ? <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-[12.5px] text-amber-800">Dispatch needs at least one active technician, one dispatch location and a rota. Add them in <Link className="font-medium underline" href="/dashboard/practice">Services & team</Link>.</div> : null}
          <section><div className="mb-3 flex items-center justify-between"><h2 className="text-[15px] font-semibold">Unassigned visits</h2><span className="font-mono text-[10.5px] text-slateink-400">{visits.filter((visit) => visit.status === 'unassigned').length}</span></div>{visits.filter((visit) => visit.status === 'unassigned').length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visits.filter((visit) => visit.status === 'unassigned').map((visit) => { const job = jobFor(visit); return <article key={visit.id} className="panel p-4"><div className="flex items-center justify-between"><span className="font-mono text-[10.5px] text-brand-700">{visit.reference}</span><Status value={visit.status} /></div><h3 className="mt-2 text-[13.5px] font-semibold">{job?.customer.name ?? 'Unknown customer'}</h3><p className="mt-1 text-[11.5px] text-slateink-400">{job ? site(job.siteAddress) : ''}</p><p className="mt-2 text-[12px] text-slateink-300">{job?.description}</p><Button variant="brand" size="sm" className="mt-4" onClick={() => openSchedule(visit)}>Assign & schedule</Button></article>; })}</div> : <EmptyState icon="calendar" title="No unassigned visits" desc="Visits added to a job appear here until a technician and time are chosen." />}</section>
          <section><div className="mb-3 flex items-center justify-between"><h2 className="text-[15px] font-semibold">Scheduled and active visits</h2><span className="font-mono text-[10.5px] text-slateink-400">collision checked</span></div><div className="space-y-3">{visits.filter((visit) => visit.status !== 'unassigned').map((visit) => { const job = jobFor(visit); return <article key={visit.id} className="panel p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[10.5px] text-brand-700">{visit.reference}</span><Status value={visit.status} /></div><h3 className="mt-2 text-[14px] font-semibold">{job?.customer.name} · {job?.reference}</h3><p className="mt-1 text-[12px] text-slateink-300">{visit.startsAt ? new Date(visit.startsAt).toLocaleString() : 'Not scheduled'} · {providerName(visit.providerId)} · {locationName(visit.locationId)}</p><p className="mt-1 text-[11.5px] text-slateink-400">{job ? site(job.siteAddress) : ''} · {visit.durationMinutes} min + {visit.travelBufferMinutes} min travel buffer</p></div><div className="flex flex-wrap gap-2">{['scheduled', 'en_route', 'on_site'].includes(visit.status) && <Button variant="ghost" size="sm" onClick={() => openSchedule(visit)}>Move / reassign</Button>}{visit.status === 'scheduled' && <Button variant="brand" size="sm" onClick={() => void run(`route-${visit.id}`, async () => { await request('POST', `/api/v1/visits/${visit.id}`, { action: 'status', status: 'en_route' }); })}>En route</Button>}{visit.status === 'en_route' && <Button variant="brand" size="sm" onClick={() => void run(`site-${visit.id}`, async () => { await request('POST', `/api/v1/visits/${visit.id}`, { action: 'status', status: 'on_site' }); })}>On site</Button>}{visit.status === 'on_site' && <Button variant="brand" size="sm" onClick={() => void run(`done-${visit.id}`, async () => { await request('PATCH', `/api/v1/visits/${visit.id}`, { workPerformed: visit.workPerformed ?? job?.description }); await request('POST', `/api/v1/visits/${visit.id}`, { action: 'status', status: 'completed', note: 'Work completed' }); })}>Complete visit</Button>}{!['completed', 'cancelled'].includes(visit.status) && <Button variant="quiet" size="sm" onClick={() => void run(`cancel-${visit.id}`, async () => { await request('POST', `/api/v1/visits/${visit.id}`, { action: 'status', status: 'cancelled' }); })}>Cancel</Button>}{['completed', 'cancelled'].includes(visit.status) && <Button variant="quiet" size="sm" onClick={() => void run(`reopen-${visit.id}`, async () => { await request('POST', `/api/v1/visits/${visit.id}`, { action: 'reopen' }); })}>Reopen</Button>}</div></div></article>; })}</div></section>
        </div>
      )}

      <Modal open={enquiryOpen} onClose={() => setEnquiryOpen(false)} title="New contractor enquiry" desc="The service address belongs to this enquiry; it is not copied from a mailing address." width="max-w-2xl" footer={<><Button variant="quiet" onClick={() => setEnquiryOpen(false)}>Cancel</Button><Button variant="brand" disabled={busy === 'create-enquiry'} onClick={() => void run('create-enquiry', async () => { const made = await request<Enquiry>('POST', '/api/v1/enquiries', { customer, description, urgency, siteAddress }); setEnquiryOpen(false); resetCommon(); toast(`${made.reference} created.`, 'success'); })}>Create enquiry</Button></>}>
        <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Customer name</label><input aria-label="Customer name" className="field" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></div><div><label className="label">Phone</label><input aria-label="Phone" className="field" value={customer.number} onChange={(event) => setCustomer({ ...customer, number: event.target.value })} /></div><div><label className="label">Email <span className="text-slateink-400">(optional)</span></label><input aria-label="Email (optional)" type="email" className="field" value={customer.email ?? ''} onChange={(event) => setCustomer({ ...customer, email: event.target.value })} /></div><div><label className="label">Urgency</label><select aria-label="Urgency" className="field" value={urgency} onChange={(event) => setUrgency(event.target.value)}>{['routine', 'soon', 'urgent', 'emergency'].map((value) => <option key={value} value={value}>{value}</option>)}</select></div></div><div><label className="label">What needs doing?</label><textarea aria-label="What needs doing" className="field min-h-24" value={description} onChange={(event) => setDescription(event.target.value)} /></div><SiteFields value={siteAddress} onChange={setSiteAddress} /></div>
      </Modal>

      <Modal open={estimateOpen} onClose={() => setEstimateOpen(false)} title={editEstimate ? `Edit ${editEstimate.reference}` : `Estimate for ${estimateSource?.reference ?? 'enquiry'}`} desc="Prices are entered by a person and saved in minor units. Nothing is sent or accepted by creating this draft." width="max-w-4xl" footer={<><Button variant="quiet" onClick={() => setEstimateOpen(false)}>Cancel</Button><Button variant="brand" disabled={busy === 'save-estimate'} onClick={() => void run('save-estimate', async () => { const payload = { description, siteAddress, lines: linePayload(), validUntil, notes }; const made = editEstimate ? await request<Estimate>('PATCH', `/api/v1/estimates/${editEstimate.id}`, payload) : await request<Estimate>('POST', '/api/v1/estimates', { ...payload, enquiryId: estimateSource?.id, currency }); setEstimateOpen(false); setSelectedEstimate(made); setEditEstimate(null); setEstimateSource(null); toast(`${made.reference} saved as a draft.`, 'success'); })}>{editEstimate ? 'Save new version' : 'Create draft estimate'}</Button></>}>
        <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div className="sm:col-span-2"><label className="label">Work description</label><textarea aria-label="Work description" className="field min-h-20" value={description} onChange={(event) => setDescription(event.target.value)} /></div><div><label className="label">Valid until</label><input aria-label="Valid until" className="field" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></div><div><label className="label">Currency</label><input aria-label="Currency" className="field" value={currency} readOnly /></div></div><LineEditor lines={lines} setLines={setLines} currency={currency} /><div><label className="label">Customer notes</label><textarea aria-label="Customer notes" className="field min-h-20" value={notes} onChange={(event) => setNotes(event.target.value)} /></div></div>
      </Modal>

      <Modal open={jobOpen} onClose={() => setJobOpen(false)} title="New direct job" desc="Use this when work does not need an estimate. Add confirmed charge lines now or later before invoicing." width="max-w-4xl" footer={<><Button variant="quiet" onClick={() => setJobOpen(false)}>Cancel</Button><Button variant="brand" onClick={() => void run('create-job', async () => { const made = await request<Job>('POST', '/api/v1/jobs', { customer, description, siteAddress, lines: lines[0]?.description ? linePayload() : [] }); setJobOpen(false); setSelectedJob(made); resetCommon(); toast(`${made.reference} created.`, 'success'); })}>Create job</Button></>}>
        <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Customer name</label><input aria-label="Customer name" className="field" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></div><div><label className="label">Phone</label><input aria-label="Phone" className="field" value={customer.number} onChange={(event) => setCustomer({ ...customer, number: event.target.value })} /></div></div><div><label className="label">Work description</label><textarea aria-label="Work description" className="field min-h-20" value={description} onChange={(event) => setDescription(event.target.value)} /></div><SiteFields value={siteAddress} onChange={setSiteAddress} /><LineEditor lines={lines} setLines={setLines} currency={currency} /></div>
      </Modal>

      <Modal open={visitOpen} onClose={() => setVisitOpen(false)} title="Add unassigned visit" desc="It will appear in Dispatch. Scheduling later checks technician hours, breaks and diary collisions." footer={<><Button variant="quiet" onClick={() => setVisitOpen(false)}>Cancel</Button><Button variant="brand" onClick={() => void run('create-visit', async () => { const made = await request<Visit>('POST', '/api/v1/visits', { jobId: visitJobId, durationMinutes: Number(visitDuration), travelBufferMinutes: Number(travelBuffer), instructions }); setVisitOpen(false); toast(`${made.reference} added to dispatch.`, 'success'); })}>Add visit</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2"><div><label className="label">Duration (minutes)</label><input aria-label="Duration in minutes" type="number" min="5" className="field" value={visitDuration} onChange={(event) => setVisitDuration(event.target.value)} /></div><div><label className="label">Travel buffer after (minutes)</label><input aria-label="Travel buffer after in minutes" type="number" min="0" className="field" value={travelBuffer} onChange={(event) => setTravelBuffer(event.target.value)} /></div><div className="sm:col-span-2"><label className="label">Instructions</label><textarea aria-label="Instructions" className="field min-h-20" value={instructions} onChange={(event) => setInstructions(event.target.value)} /></div></div>
      </Modal>

      <Modal open={Boolean(scheduleVisit)} onClose={() => setScheduleVisit(null)} title={scheduleVisit?.status === 'unassigned' ? 'Assign and schedule visit' : 'Move or reassign visit'} desc="The dispatch location supplies the technician rota and timezone. The customer's service address stays on the job." width="max-w-2xl" footer={<><Button variant="quiet" onClick={() => setScheduleVisit(null)}>Cancel</Button><Button variant="brand" disabled={!startsAt || !providerId || !locationId} onClick={() => scheduleVisit && void run('schedule-visit', async () => { await request('POST', `/api/v1/visits/${scheduleVisit.id}`, { action: 'schedule', startsAt: new Date(startsAt).toISOString(), providerId, locationId, serviceId: serviceId || undefined, durationMinutes: Number(visitDuration), travelBufferMinutes: Number(travelBuffer) }); setScheduleVisit(null); toast('Visit scheduled with collision checks.', 'success'); })}>Check & schedule</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2"><div className="sm:col-span-2"><label className="label">Start</label><input aria-label="Start" type="datetime-local" className="field" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></div><div><label className="label">Technician</label><select aria-label="Technician" className="field" value={providerId} onChange={(event) => { setProviderId(event.target.value); const provider = providers.find((row) => row.id === event.target.value); if (!locationId && provider?.locationIds[0]) setLocationId(provider.locationIds[0]); }}><option value="">Choose…</option>{providers.filter((row) => row.active !== false).map((row) => <option key={row.id} value={row.id}>{row.name}{row.title ? ` — ${row.title}` : ''}</option>)}</select></div><div><label className="label">Dispatch location</label><select aria-label="Dispatch location" className="field" value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">Choose…</option>{locations.filter((row) => row.active !== false).map((row) => <option key={row.id} value={row.id}>{row.name} · {row.timezone}</option>)}</select></div><div><label className="label">Service <span className="text-slateink-400">(optional)</span></label><select aria-label="Service (optional)" className="field" value={serviceId} onChange={(event) => { setServiceId(event.target.value); const service = services.find((row) => row.id === event.target.value); if (service) setVisitDuration(String(service.durationMinutes)); }}><option value="">Field visit</option>{services.filter((row) => row.active !== false).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div><div><label className="label">Duration</label><input aria-label="Duration in minutes" type="number" min="5" className="field" value={visitDuration} onChange={(event) => setVisitDuration(event.target.value)} /></div><div><label className="label">Travel buffer after</label><input aria-label="Travel buffer after in minutes" type="number" min="0" className="field" value={travelBuffer} onChange={(event) => setTravelBuffer(event.target.value)} /></div></div>
      </Modal>
    </div>
  );
}
