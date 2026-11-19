'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';
import type { FormSchema } from '@/lib/forms-schema';
import { CustomFieldEditor, draftsForCustomFields, type CustomFieldEntry } from '@/components/dash/CustomFieldEditor';
import { StructuredAddressEditor } from '@/components/dash/StructuredAddressEditor';
import type { StructuredAddress, StructuredAddressInput } from '@/lib/addresses';

type Status = 'received' | 'triaged' | 'needs_information' | 'accepted' | 'waitlisted' | 'rejected' | 'duplicate' | 'withdrawn' | 'converted';
type Referral = { id: string; status: Status; priority: 'routine' | 'soon' | 'urgent'; source: string; patient: { name: string; dateOfBirth?: string; email?: string; phone?: string; address?: string; structuredAddress?: StructuredAddress }; referrer?: { name: string; organisation?: string; email?: string }; reason: string; notes?: string; ownerId?: string; receivedAt: string; convertedClientId?: string; revision: number };
type Detail = { referral: Referral & { referralFormSubmissionId?: string; documentIds?: string[] }; events: Array<{ id: string; from?: Status; to: Status; actor: string; note?: string; at: string }>; riskFlags: Array<{ id: string; label: string; severity: string; detail?: string; status: string; revision: number }>; notifications: Array<{ id: string; statusSnapshot: Status; to: string; subject: string; state: string; messageId?: string; requestedAt: string }>; duplicateCandidates: Array<{ referral: Referral; score: number; reasons: string[] }>; attachments: Array<{ id: string; title: string; currentScanStatus?: string; downloadPath?: string }>; publicSubmission?: { id: string; templateVersion: number; answers?: Record<string, unknown>; answersHash?: string; submittedAt?: string; evidence?: { verified: boolean }; schema?: FormSchema } };
const clinicalHeaders = { 'x-voxera-synthetic-data': '1' };

export default function ReferralsPage() {
  const [rows, setRows] = React.useState<Referral[]>([]);
  const [selected, setSelected] = React.useState<Detail>();
  const [customFields, setCustomFields] = React.useState<CustomFieldEntry[]>([]);
  const [customDrafts, setCustomDrafts] = React.useState<Record<string, unknown>>({});
  const [filter, setFilter] = React.useState<Status | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [showNew, setShowNew] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: '', dateOfBirth: '', email: '', phone: '', address: '', reason: '', priority: 'routine', referrerName: '', referrerEmail: '', referrerOrganisation: '' });
  const [transitionNote, setTransitionNote] = React.useState('');
  const [ownerId, setOwnerId] = React.useState('');
  const [risk, setRisk] = React.useState({ label: '', detail: '', severity: 'warning' });
  const [existingClientId, setExistingClientId] = React.useState('');
  const [notification, setNotification] = React.useState({ subject: 'Referral update', message: '' });

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);
  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams(); if (filter !== 'all') params.set('status', filter); if (query.trim()) params.set('q', query.trim());
      const body = await api(`/api/v1/referrals?${params}`); setRows(body.data ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referrals could not be loaded.'); }
    finally { setLoading(false); }
  }, [api, filter, query]);
  React.useEffect(() => { const timer = setTimeout(() => void load(), 200); return () => clearTimeout(timer); }, [load]);

  const open = React.useCallback(async (id: string) => {
    setBusy(true); setError('');
    try {
      const [body, fieldBody] = await Promise.all([
        api(`/api/v1/referrals/${encodeURIComponent(id)}`),
        api(`/api/v1/referrals/${encodeURIComponent(id)}/custom-fields`),
      ]);
      setSelected(body); setOwnerId(body.referral.ownerId ?? '');
      const entries = (fieldBody.data ?? []) as CustomFieldEntry[];
      setCustomFields(entries); setCustomDrafts(draftsForCustomFields(entries));
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral could not be opened.'); }
    finally { setBusy(false); }
  }, [api]);

  const create = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api('/api/v1/referrals', { method: 'POST', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ patient: { name: draft.name, dateOfBirth: draft.dateOfBirth || undefined, email: draft.email || undefined, phone: draft.phone || undefined, address: draft.address || undefined }, priority: draft.priority, reason: draft.reason, referrer: draft.referrerName ? { name: draft.referrerName, email: draft.referrerEmail || undefined, organisation: draft.referrerOrganisation || undefined } : undefined, source: 'manual' }) });
      setDraft({ name: '', dateOfBirth: '', email: '', phone: '', address: '', reason: '', priority: 'routine', referrerName: '', referrerEmail: '', referrerOrganisation: '' }); setShowNew(false);
      setNotice(body.duplicateCandidates?.length ? `Referral received with ${body.duplicateCandidates.length} possible duplicate(s) for staff review.` : 'Referral received and added to the triage queue.');
      await load(); await open(body.referral.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral creation failed.'); }
    finally { setBusy(false); }
  };

  const patch = async (body: Record<string, unknown>, success: string): Promise<boolean> => {
    if (!selected) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/referrals/${selected.referral.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify(body) });
      setNotice(success); setTransitionNote(''); setRisk({ label: '', detail: '', severity: 'warning' });
      await load(); await open(selected.referral.id);
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral update failed.'); return false; }
    finally { setBusy(false); }
  };
  const transition = (to: Status, extra: Record<string, unknown> = {}) => patch({ action: 'transition', to, note: transitionNote || undefined, expectedRevision: selected?.referral.revision, ...extra }, `Referral moved to ${to.replace('_', ' ')}.`);
  const updateOwner = () => patch({ action: 'update', expectedRevision: selected?.referral.revision, patch: { ownerId: ownerId || undefined } }, 'Referral owner updated.');
  const convert = () => patch({ action: 'convert', expectedRevision: selected?.referral.revision, existingClientId: existingClientId || undefined }, 'Referral converted to a patient record with its decision trail preserved.');
  const addRisk = () => patch({ action: 'add_risk_flag', label: risk.label, detail: risk.detail || undefined, severity: risk.severity }, 'Risk flag added for authorised triage staff.');
  const saveCustomField = async (entry: CustomFieldEntry) => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/referrals/${encodeURIComponent(selected.referral.id)}/custom-fields`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...clinicalHeaders },
        body: JSON.stringify({ definitionId: entry.definition.id, value: customDrafts[entry.definition.id], expectedRevision: entry.value?.revision ?? null }),
      });
      setNotice(`${entry.definition.label} saved with verified staff evidence.`);
      await open(selected.referral.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral field could not be saved.'); }
    finally { setBusy(false); }
  };
  const saveAddress = async (address: StructuredAddressInput) => {
    if (!selected) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/referrals/${encodeURIComponent(selected.referral.id)}/address`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...clinicalHeaders },
        body: JSON.stringify({ expectedRevision: selected.referral.revision, address }),
      });
      setNotice('Referral address reviewed; the source text remains preserved.');
      await load(); await open(selected.referral.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral address could not be saved.'); }
    finally { setBusy(false); }
  };

  const notifyReferrer = async () => {
    if (!selected) return;
    const saved = await patch({
      action: 'notify_referrer',
      expectedRevision: selected.referral.revision,
      subject: notification.subject,
      message: notification.message,
    }, 'Referrer notification queued through the durable controlled-message path.');
    if (saved) setNotification((current) => ({ ...current, message: '' }));
  };

  const tone = (status: Status | string): 'default' | 'brand' | 'warn' | 'danger' => ['accepted', 'converted'].includes(status) ? 'brand' : ['urgent', 'needs_information', 'waitlisted', 'triaged'].includes(status) ? 'warn' : ['rejected', 'withdrawn', 'duplicate', 'critical'].includes(status) ? 'danger' : 'default';
  const actions = (status: Status): Status[] => ({ received: ['triaged', 'needs_information', 'accepted', 'rejected', 'withdrawn'], triaged: ['needs_information', 'accepted', 'waitlisted', 'rejected', 'withdrawn'], needs_information: ['triaged', 'accepted', 'rejected', 'withdrawn'], accepted: ['waitlisted', 'converted', 'withdrawn'], waitlisted: ['accepted', 'converted', 'withdrawn'], rejected: [], duplicate: [], withdrawn: [], converted: [] }[status] as Status[]);

  return <div className="space-y-6">
    <PageHeader title="Referral inbox" desc="A queue with explicit ownership, urgency, duplicate warnings, risk flags and an immutable decision trail through patient conversion." actions={<div className="flex flex-wrap gap-2"><Link href="/dashboard/referral-forms" className="btn-ghost btn-sm"><Icons.globe size={13} /> Public forms</Link><Button size="sm" onClick={() => setShowNew((value) => !value)}><Icons.plus size={13} /> New referral</Button></div>} />
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">Synthetic-test mode is acknowledged by this screen. “Urgent” changes queue visibility; it does not provide emergency monitoring or clinical triage advice.</section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}{notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}

    {showNew && <section className="panel p-5"><div className="flex items-center justify-between"><div><h2 className="text-[15px] font-semibold">Record referral</h2><p className="mt-1 text-[11.5px] text-slateink-400">Identity matches generate warnings; they never merge records automatically.</p></div><button onClick={() => setShowNew(false)} aria-label="Close"><Icons.close size={15} /></button></div><div className="mt-4 grid gap-3 md:grid-cols-3"><label className="text-[11px] font-medium text-slateink-500">Patient name<input value={draft.name} onChange={(event) => setDraft((row) => ({ ...row, name: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Date of birth<input type="date" value={draft.dateOfBirth} onChange={(event) => setDraft((row) => ({ ...row, dateOfBirth: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Priority<select value={draft.priority} onChange={(event) => setDraft((row) => ({ ...row, priority: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label><label className="text-[11px] font-medium text-slateink-500">Email<input type="email" value={draft.email} onChange={(event) => setDraft((row) => ({ ...row, email: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Phone<input value={draft.phone} onChange={(event) => setDraft((row) => ({ ...row, phone: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Legacy address text<input value={draft.address} onChange={(event) => setDraft((row) => ({ ...row, address: event.target.value }))} placeholder="Preserved for staff review" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Referrer name<input value={draft.referrerName} onChange={(event) => setDraft((row) => ({ ...row, referrerName: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Referrer email<input type="email" value={draft.referrerEmail} onChange={(event) => setDraft((row) => ({ ...row, referrerEmail: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500 md:col-span-2">Reason<textarea value={draft.reason} onChange={(event) => setDraft((row) => ({ ...row, reason: event.target.value }))} className="mt-1.5 min-h-24 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[11px] font-medium text-slateink-500">Referrer organisation<input value={draft.referrerOrganisation} onChange={(event) => setDraft((row) => ({ ...row, referrerOrganisation: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label></div><div className="mt-4 flex justify-end"><Button size="sm" disabled={busy || !draft.name.trim() || !draft.reason.trim()} onClick={() => void create()}>{busy ? 'Saving…' : 'Add to referral inbox'}</Button></div></section>}

    <div className="grid gap-5 xl:grid-cols-[minmax(430px,0.9fr)_minmax(0,1.1fr)] xl:items-start">
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] p-4"><div className="grid gap-2 sm:grid-cols-[1fr_180px]"><label className="text-[10.5px] font-medium text-slateink-400">Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Patient, referrer or reference" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="text-[10.5px] font-medium text-slateink-400">Status<select value={filter} onChange={(event) => setFilter(event.target.value as Status | 'all')} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="all">All</option>{(['received', 'triaged', 'needs_information', 'accepted', 'waitlisted', 'rejected', 'duplicate', 'withdrawn', 'converted'] as Status[]).map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}</select></label></div></div><div className="divide-y divide-slate-900/[0.05]">{rows.map((row) => <button key={row.id} onClick={() => void open(row.id)} className={`flex w-full gap-3 px-5 py-4 text-left hover:bg-slate-900/[0.02] ${selected?.referral.id === row.id ? 'bg-brand-500/[0.045]' : ''}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${row.priority === 'urgent' ? 'bg-red-500' : row.priority === 'soon' ? 'bg-amber-400' : 'bg-slate-300'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-[13px] font-semibold">{row.patient.name}</p><Pill tone={tone(row.status)}>{row.status.replace('_', ' ')}</Pill>{row.priority !== 'routine' && <Pill tone={tone(row.priority)}>{row.priority}</Pill>}</div><p className="mt-1 truncate text-[11px] text-slateink-400">{row.reason}</p><p className="mt-1 font-mono text-[10px] text-slateink-300">{row.id} · {new Date(row.receivedAt).toLocaleDateString('en-GB')}</p></div><Icons.chevronRight size={14} /></button>)}{!loading && !rows.length && <p className="px-5 py-14 text-center text-[12px] text-slateink-400">No referrals match this queue view.</p>}</div></section>

      <section className="panel min-h-[420px] p-5 xl:sticky xl:top-6">{!selected ? <div className="grid min-h-[360px] place-items-center text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-900/[0.04]"><Icons.send size={20} /></span><h2 className="mt-4 text-[15px] font-semibold">Select a referral</h2><p className="mt-2 max-w-sm text-[12px] leading-relaxed text-slateink-400">Review identity warnings, ownership, risk flags and every status decision before conversion.</p></div></div> : <div className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h2 className="text-[18px] font-semibold">{selected.referral.patient.name}</h2><Pill tone={tone(selected.referral.status)}>{selected.referral.status.replace('_', ' ')}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{selected.referral.id}</p></div><Pill tone={tone(selected.referral.priority)}>{selected.referral.priority}</Pill></div>
        <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-900/[0.025] p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Patient details</p><p className="mt-2 text-[12px]">DOB {selected.referral.patient.dateOfBirth || 'not supplied'}</p><p className="mt-1 text-[12px]">{selected.referral.patient.email || 'No email'}</p><p className="mt-1 text-[12px]">{selected.referral.patient.phone || 'No phone'}</p></div><div className="rounded-xl bg-slate-900/[0.025] p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Referrer</p><p className="mt-2 text-[12px]">{selected.referral.referrer?.name || 'Not recorded'}</p><p className="mt-1 text-[12px] text-slateink-400">{selected.referral.referrer?.organisation || selected.referral.source}</p><p className="mt-1 text-[11px] text-slateink-400">{selected.referral.referrer?.email || 'No referrer email'}</p></div></div>
        <div className="rounded-xl border border-slate-900/[0.07] p-3"><div className="flex items-center justify-between gap-2"><div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Patient postal address</h3><p className="mt-1 text-[10px] text-slateink-400">Legacy text is retained until explicit review.</p></div></div><div className="mt-3"><StructuredAddressEditor value={selected.referral.patient.structuredAddress} legacyAddress={selected.referral.patient.address} busy={busy} onSave={saveAddress} idPrefix="referral-address" /></div></div>
        <div className="overflow-hidden rounded-xl border border-slate-900/[0.07]"><div className="border-b border-slate-900/[0.05] px-4 py-3"><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Referral custom fields</h3><p className="mt-1 text-[10px] text-slateink-400">Typed values retain source and review evidence.</p></div><CustomFieldEditor entries={customFields} drafts={customDrafts} setDrafts={setCustomDrafts} busy={busy} onSave={saveCustomField} idPrefix="referral-custom" emptyText="No visible referral fields are configured." /></div>
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Reason</h3><p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-800">{selected.referral.reason}</p></div>
        {selected.publicSubmission && <div className="rounded-xl border border-slate-900/[0.07] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="flex items-center gap-2"><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Original public submission</h3><Pill tone={selected.publicSubmission.evidence?.verified ? 'brand' : 'danger'}>{selected.publicSubmission.evidence?.verified ? 'verified evidence' : 'integrity warning'}</Pill></div><p className="mt-1 font-mono text-[9.5px] text-slateink-400">template v{selected.publicSubmission.templateVersion} · evidence {selected.publicSubmission.answersHash?.slice(0, 12) ?? 'unavailable'}…</p></div>{selected.publicSubmission.submittedAt && <span className="text-[10px] text-slateink-400">{new Date(selected.publicSubmission.submittedAt).toLocaleString('en-GB')}</span>}</div><dl className="mt-3 grid gap-2 sm:grid-cols-2">{selected.publicSubmission.schema?.fields.filter((field) => field.type !== 'display' && field.type !== 'file' && selected.publicSubmission?.answers?.[field.key] !== undefined).map((field) => <div key={field.key} className="rounded-lg bg-slate-900/[0.025] p-2.5"><dt className="text-[9.5px] font-bold uppercase tracking-wider text-slateink-300">{field.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-slate-700">{Array.isArray(selected.publicSubmission?.answers?.[field.key]) ? (selected.publicSubmission?.answers?.[field.key] as unknown[]).join(', ') : typeof selected.publicSubmission?.answers?.[field.key] === 'boolean' ? selected.publicSubmission?.answers?.[field.key] ? 'Yes' : 'No' : String(selected.publicSubmission?.answers?.[field.key] ?? '')}</dd></div>)}</dl></div>}
        {selected.attachments?.length > 0 && <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Attachments</h3><div className="mt-2 space-y-2">{selected.attachments.map((attachment) => <div key={attachment.id} className="flex items-center gap-3 rounded-xl border border-slate-900/[0.07] p-3"><span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900/[0.04]"><Icons.book size={14} /></span><div className="min-w-0 flex-1"><p className="truncate text-[11.5px] font-medium">{attachment.title}</p><p className="mt-0.5 font-mono text-[9.5px] text-slateink-400">{attachment.id} · {attachment.currentScanStatus ?? 'scan pending'}</p></div>{attachment.downloadPath ? <a href={attachment.downloadPath} className="btn-ghost btn-sm"><Icons.download size={12} /> Download</a> : <span className="text-[10px] text-amber-700">Quarantined</span>}</div>)}</div></div>}
        {selected.duplicateCandidates.length > 0 && <div className="rounded-xl border border-amber-300/50 bg-amber-50 p-3"><p className="text-[11px] font-semibold text-amber-950">Possible duplicates</p>{selected.duplicateCandidates.map((candidate) => <div key={candidate.referral.id} className="mt-2 flex items-center justify-between gap-2 text-[11px] text-amber-900"><span>{candidate.referral.patient.name} · {candidate.reasons.join(', ')}</span>{['received', 'triaged'].includes(selected.referral.status) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void transition('duplicate', { duplicateOfReferralId: candidate.referral.id })}>Mark duplicate</Button>}</div>)}</div>}
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Ownership</h3><div className="mt-2 flex gap-2"><input value={ownerId} onChange={(event) => setOwnerId(event.target.value)} placeholder="User or team owner ID" className="min-w-0 flex-1 rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px]" /><Button variant="ghost" size="sm" disabled={busy || ownerId === (selected.referral.ownerId ?? '')} onClick={() => void updateOwner()}>Save</Button></div></div>
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Decision</h3><textarea value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} placeholder="Decision note (required for rejection, withdrawal or more information)" className="mt-2 min-h-20 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11.5px]" /><div className="mt-2 flex flex-wrap gap-2">{actions(selected.referral.status).filter((action) => action !== 'converted').map((action) => <Button key={action} variant={action === 'accepted' ? 'primary' : 'ghost'} size="sm" disabled={busy || (['rejected', 'withdrawn', 'needs_information'].includes(action) && !transitionNote.trim())} onClick={() => void transition(action)}>{action.replace('_', ' ')}</Button>)}</div></div>
        {['accepted', 'waitlisted'].includes(selected.referral.status) && <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.04] p-3"><h3 className="text-[11px] font-semibold">Convert to patient</h3><p className="mt-1 text-[10.5px] text-slateink-400">Leave blank to create a new patient, or link an existing patient ID.</p><div className="mt-2 flex gap-2"><input value={existingClientId} onChange={(event) => setExistingClientId(event.target.value)} placeholder="Optional cli_…" className="min-w-0 flex-1 rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px]" /><Button size="sm" disabled={busy} onClick={() => void convert()}>Convert</Button></div></div>}
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Risk flags</h3><div className="mt-2 space-y-2">{selected.riskFlags.map((flag) => <div key={flag.id} className="flex items-start gap-2 rounded-xl border border-slate-900/[0.07] p-3"><Pill tone={tone(flag.severity)}>{flag.severity}</Pill><div className="min-w-0 flex-1"><p className="text-[11.5px] font-medium">{flag.label}</p>{flag.detail && <p className="mt-1 text-[10.5px] text-slateink-400">{flag.detail}</p>}</div>{flag.status === 'open' && <button disabled={busy} onClick={() => void patch({ action: 'resolve_risk_flag', riskFlagId: flag.id, expectedRevision: flag.revision }, 'Risk flag resolved.') } className="text-[10px] font-medium text-brand-700">Resolve</button>}</div>)}</div><div className="mt-2 grid gap-2 sm:grid-cols-[130px_1fr]"><select value={risk.severity} onChange={(event) => setRisk((current) => ({ ...current, severity: event.target.value }))} className="rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]"><option value="information">Information</option><option value="warning">Warning</option><option value="critical">Critical</option></select><input value={risk.label} onChange={(event) => setRisk((current) => ({ ...current, label: event.target.value }))} placeholder="Add a restricted risk flag" className="rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></div><Button variant="ghost" size="sm" className="mt-2" disabled={busy || !risk.label.trim()} onClick={() => void addRisk()}>Add flag</Button></div>
        {selected.referral.referrer?.email && <div className="rounded-xl border border-slate-900/[0.07] p-3"><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Notify referrer</h3><p className="mt-1 text-[10.5px] text-slateink-400">Destination is fixed to {selected.referral.referrer.email}. Staff-authored text is queued durably and keeps delivery evidence.</p><label className="mt-3 block text-[10.5px] font-medium text-slateink-500">Subject<input value={notification.subject} onChange={(event) => setNotification((current) => ({ ...current, subject: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><label className="mt-2 block text-[10.5px] font-medium text-slateink-500">Message<textarea value={notification.message} onChange={(event) => setNotification((current) => ({ ...current, message: event.target.value }))} placeholder="Write the administrative update; do not include unreviewed clinical advice." className="mt-1.5 min-h-24 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><Button variant="ghost" size="sm" className="mt-2" disabled={busy || notification.subject.trim().length < 2 || notification.message.trim().length < 10} onClick={() => void notifyReferrer()}>Queue referrer notification</Button>{selected.notifications?.length > 0 && <div className="mt-3 space-y-2">{selected.notifications.map((row) => <div key={row.id} className="rounded-lg bg-slate-900/[0.025] p-2.5"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10.5px] font-medium">{row.subject}</span><Pill tone={row.state === 'sent' ? 'brand' : ['failed', 'blocked'].includes(row.state) ? 'danger' : 'warn'}>{row.state}</Pill></div><p className="mt-1 font-mono text-[9px] text-slateink-400">{new Date(row.requestedAt).toLocaleString('en-GB')} · {row.statusSnapshot}</p></div>)}</div>}</div>}
        <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Decision history</h3><ol className="mt-3 space-y-3 border-l border-slate-200 pl-4">{selected.events.map((event) => <li key={event.id}><p className="text-[11.5px] font-medium">{event.from ? `${event.from.replace('_', ' ')} → ` : ''}{event.to.replace('_', ' ')}</p><p className="mt-0.5 text-[10px] text-slateink-400">{new Date(event.at).toLocaleString('en-GB')} · {event.actor}</p>{event.note && <p className="mt-1 text-[10.5px] text-slate-600">{event.note}</p>}</li>)}</ol></div>
      </div>}</section>
    </div>
  </div>;
}
