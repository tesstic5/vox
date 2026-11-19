'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { PageHeader } from '@/components/dash/Shell';
import { Button, EmptyState, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';
import { fmtDate } from '@/lib/utils';
import { draftsForCustomFields, type CustomFieldEntry } from '@/components/dash/CustomFieldEditor';
import { StructuredAddressEditor } from '@/components/dash/StructuredAddressEditor';
import { formatStructuredAddress, type StructuredAddress, type StructuredAddressInput } from '@/lib/addresses';

type Contact = { id: string; kind: 'phone' | 'email'; label: string; value: string; primary: boolean; verified: boolean; shared?: boolean };
type Alert = { id: string; classification: 'administrative' | 'clinical'; label: string; detail?: string; severity: 'info' | 'warning' | 'critical'; active?: boolean };
type Appointment = { id: string; startsAt: string; durationMinutes: number; serviceName?: string; service?: string; providerName?: string; status: string };
type ClientDetail = {
  id: string; name: string; number?: string; email?: string; dateOfBirth?: string; address?: string; structuredAddress?: StructuredAddress; tags?: string[];
  revision: number; archivedAt?: string; redirectedFrom?: string; contactPoints?: Contact[]; alerts?: Alert[]; clinicalAlertsRestricted?: boolean;
  appointments?: Appointment[]; notes?: Array<{ id: string; title: string; status: string }>;
};
type DocumentRow = { id: string; title: string; category: string; status: string; versionCount: number; currentScanStatus?: string; currentVersionId?: string };
type AccessRow = { id: string; occurredAt: string; actorLabel?: string; actorId: string; action: string; resourceType: string; purpose: string };
type Assignment = { id: string; userId?: string; providerId?: string; kind: string; startsAt?: string; endsAt?: string };
type DirectoryContact = { id: string; name: string; kind: 'person' | 'organisation'; email?: string; phone?: string; referrer: boolean; payer: boolean };
type Relationship = { id: string; relationshipType: string; label?: string; guardian: boolean; proxy: boolean; billing: boolean; emergency: boolean; referrer: boolean; verified: boolean; status: string; revision: number; contact?: DirectoryContact; relatedClient?: { id: string; name: string } };
type Tab = 'overview' | 'contacts' | 'appointments' | 'documents' | 'access';

const syntheticHeaders = { 'x-voxera-synthetic-data': '1' };
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

export default function ClientRecordPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = String(params?.id ?? '');
  const [client, setClient] = React.useState<ClientDetail | null>(null);
  const [documents, setDocuments] = React.useState<DocumentRow[] | null>(null);
  const [access, setAccess] = React.useState<AccessRow[] | null>(null);
  const [assignments, setAssignments] = React.useState<Assignment[]>([]);
  const [relationships, setRelationships] = React.useState<Relationship[]>([]);
  const [directoryContacts, setDirectoryContacts] = React.useState<DirectoryContact[]>([]);
  const [customFields, setCustomFields] = React.useState<CustomFieldEntry[]>([]);
  const [customDrafts, setCustomDrafts] = React.useState<Record<string, unknown>>({});
  const [relationshipDraft, setRelationshipDraft] = React.useState({ contactId: '', relationshipType: 'emergency_contact', guardian: false, proxy: false, billing: false, emergency: true, referrer: false, verified: false });
  const [tab, setTab] = React.useState<Tab>('overview');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [denied, setDenied] = React.useState(false);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const main = await api(`/api/v1/clients/${encodeURIComponent(id)}`);
      if (cancelled) return;
      if (!main.response.ok) {
        setDenied(main.response.status === 403);
        setError(main.body?.error?.message ?? (main.response.status === 404 ? 'Client record not found.' : 'Client record could not be loaded.'));
        setLoading(false);
        return;
      }
      const loaded = main.body as ClientDetail;
      setClient(loaded);
      const canonicalId = loaded.id;
      if (loaded.redirectedFrom && canonicalId !== id) router.replace(`/dashboard/clients/${encodeURIComponent(canonicalId)}`);
      const [docs, accessRows, assignmentRows, relationshipRows, contactRows, customFieldRows] = await Promise.all([
        api(`/api/v1/documents?patientId=${encodeURIComponent(canonicalId)}`),
        api(`/api/v1/clinical-access?patientId=${encodeURIComponent(canonicalId)}&limit=200`),
        api(`/api/v1/clients/${encodeURIComponent(canonicalId)}/assignments`),
        api(`/api/v1/clients/${encodeURIComponent(canonicalId)}/relationships`),
        api('/api/v1/contacts?active=true'),
        api(`/api/v1/clients/${encodeURIComponent(canonicalId)}/custom-fields`),
      ]);
      if (cancelled) return;
      setDocuments(docs.response.ok ? (docs.body.data ?? []) : null);
      setAccess(accessRows.response.ok ? (accessRows.body.data ?? []) : null);
      setAssignments(assignmentRows.response.ok ? (assignmentRows.body.caseload ?? []) : []);
      setRelationships(relationshipRows.response.ok ? (relationshipRows.body.data ?? []) : []);
      setDirectoryContacts(contactRows.response.ok ? (contactRows.body.data ?? []) : []);
      const loadedFields = customFieldRows.response.ok ? (customFieldRows.body.data ?? []) as CustomFieldEntry[] : [];
      setCustomFields(loadedFields);
      setCustomDrafts(draftsForCustomFields(loadedFields));
      setLoading(false);
    })().catch((reason) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : 'Client record could not be loaded.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [id, router]);

  const refreshAdministration = React.useCallback(async () => {
    const [relationshipRows, contactRows, customFieldRows] = await Promise.all([
      api(`/api/v1/clients/${encodeURIComponent(id)}/relationships`),
      api('/api/v1/contacts?active=true'),
      api(`/api/v1/clients/${encodeURIComponent(id)}/custom-fields`),
    ]);
    if (relationshipRows.response.ok) setRelationships(relationshipRows.body.data ?? []);
    if (contactRows.response.ok) setDirectoryContacts(contactRows.body.data ?? []);
    if (customFieldRows.response.ok) {
      const loadedFields = (customFieldRows.body.data ?? []) as CustomFieldEntry[];
      setCustomFields(loadedFields);
      setCustomDrafts(draftsForCustomFields(loadedFields));
    }
  }, [id]);

  const createRelationship = async () => {
    if (!relationshipDraft.contactId) return;
    setBusy(true); setError(''); setNotice('');
    const result = await api(`/api/v1/clients/${encodeURIComponent(id)}/relationships`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...syntheticHeaders }, body: JSON.stringify(relationshipDraft),
    });
    if (!result.response.ok) setError(result.body?.error?.message ?? 'Relationship creation failed.');
    else {
      setNotice('Associated contact linked to this patient.');
      setRelationshipDraft({ contactId: '', relationshipType: 'emergency_contact', guardian: false, proxy: false, billing: false, emergency: true, referrer: false, verified: false });
      await refreshAdministration();
    }
    setBusy(false);
  };

  const endRelationship = async (row: Relationship) => {
    setBusy(true); setError(''); setNotice('');
    const result = await api(`/api/v1/clients/${encodeURIComponent(id)}/relationships/${encodeURIComponent(row.id)}?expectedRevision=${row.revision}`, { method: 'DELETE', headers: syntheticHeaders });
    if (!result.response.ok) setError(result.body?.error?.message ?? 'Relationship could not be ended.');
    else { setNotice('Relationship ended without deleting its history.'); await refreshAdministration(); }
    setBusy(false);
  };

  const saveCustomField = async (entry: CustomFieldEntry) => {
    setBusy(true); setError(''); setNotice('');
    const result = await api(`/api/v1/clients/${encodeURIComponent(id)}/custom-fields`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...syntheticHeaders },
      body: JSON.stringify({ definitionId: entry.definition.id, value: customDrafts[entry.definition.id], expectedRevision: entry.value?.revision ?? null }),
    });
    if (!result.response.ok) setError(result.body?.error?.message ?? 'Custom field could not be saved.');
    else { setNotice(`${entry.definition.label} saved with a verified staff source.`); await refreshAdministration(); }
    setBusy(false);
  };

  const saveAddress = async (address: StructuredAddressInput) => {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    const result = await api(`/api/v1/clients/${encodeURIComponent(client.id)}/address`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...syntheticHeaders },
      body: JSON.stringify({ expectedRevision: client.revision, address }),
    });
    if (!result.response.ok) setError(result.body?.error?.message ?? 'Address review could not be saved.');
    else { setClient((current) => current ? { ...current, ...(result.body as ClientDetail) } : result.body as ClientDetail); setNotice('Structured address reviewed. The original legacy text remains preserved.'); }
    setBusy(false);
  };

  if (loading) return <div className="panel h-72 animate-pulse" aria-label="Loading client record" />;
  if (!client) return <EmptyState icon="users" title={denied ? 'Access denied' : 'Client record unavailable'} desc={error || 'This record is not available in your workspace or scope.'} action={<Link href="/dashboard/clients" className="btn-brand btn-sm">Back to clients</Link>} />;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'contacts', label: 'Contacts & fields', count: relationships.length + customFields.length },
    { id: 'appointments', label: 'Appointments', count: client.appointments?.length ?? 0 },
    ...(documents !== null ? [{ id: 'documents' as const, label: 'Documents', count: documents.length }] : []),
    ...(access !== null ? [{ id: 'access' as const, label: 'Access', count: access.length }] : []),
  ];

  return <div className="space-y-5" data-client-record={client.id}>
    <PageHeader
      title={client.name}
      desc="Server-backed client record. Clinical content is fetched through typed, record-scoped APIs and is not persisted in browser storage."
      actions={<div className="flex flex-wrap gap-2">
        <a className="btn-ghost btn-sm" href={`/api/v1/clients/${encodeURIComponent(client.id)}/export`}><Icons.download size={13} /> Subject-access export</a>
        <Link href="/dashboard/clients" className="btn-quiet btn-sm">Back to clients</Link>
      </div>}
    />

    {client.archivedAt ? <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-[12px] text-amber-900">This record is archived. Its history remains preserved.</div> : null}
    {error ? <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div> : null}
    {notice ? <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div> : null}
    <nav className="flex flex-wrap gap-1 rounded-2xl border border-slate-900/[0.06] bg-white p-1.5" aria-label="Client record sections">
      {tabs.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={tab === item.id ? 'page' : undefined} className={`rounded-xl px-3 py-2 text-[12px] font-medium ${tab === item.id ? 'bg-brand-500/[0.10] text-brand-800' : 'text-slateink-500 hover:bg-slate-900/[0.03]'}`}>{item.label}{item.count === undefined ? '' : ` (${item.count})`}</button>)}
    </nav>

    {tab === 'overview' ? <div className="grid gap-5 lg:grid-cols-2">
      <section className="panel p-5" aria-labelledby="identity-title">
        <h2 id="identity-title" className="text-[15px] font-semibold text-slate-900">Identity & contact points</h2>
        <dl className="mt-4 grid grid-cols-[130px_1fr] gap-x-4 gap-y-3 text-[12px]">
          <dt className="text-slateink-400">Date of birth</dt><dd>{client.dateOfBirth || 'Not recorded'}</dd>
          <dt className="text-slateink-400">Address</dt><dd>{formatStructuredAddress(client.structuredAddress, client.address) || 'Not recorded'}</dd>
          <dt className="text-slateink-400">Tags</dt><dd>{client.tags?.join(', ') || 'None'}</dd>
        </dl>
        <div className="mt-5 space-y-2">
          {(client.contactPoints ?? []).map((point) => <div key={point.id} className="rounded-xl border border-slate-900/[0.06] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[12px] text-slate-900">{point.value}</span>{point.primary ? <Pill tone="brand">primary</Pill> : null}{point.shared ? <Pill tone="warn">shared</Pill> : null}</div>
            <p className="mt-1 text-[10.5px] text-slateink-400">{point.kind} · {point.label} · {point.verified ? 'verified' : 'not verified'}</p>
          </div>)}
          {(client.contactPoints ?? []).length === 0 ? <p className="text-[12px] text-slateink-400">No typed contact points recorded.</p> : null}
        </div>
      </section>
      <section className="panel p-5" aria-labelledby="alerts-title">
        <div className="flex items-center justify-between gap-3"><h2 id="alerts-title" className="text-[15px] font-semibold text-slate-900">Alerts</h2>{client.clinicalAlertsRestricted ? <Pill tone="default">clinical alerts restricted</Pill> : null}</div>
        <div className="mt-4 space-y-2">
          {(client.alerts ?? []).map((alert) => <article key={alert.id} className={`rounded-xl border px-3 py-3 ${alert.classification === 'clinical' ? 'border-rose-500/20 bg-rose-500/[0.04]' : 'border-slate-900/[0.06]'}`}>
            <div className="flex flex-wrap items-center gap-2"><strong className="text-[12.5px]">{alert.label}</strong><Pill tone={alert.classification === 'clinical' ? 'danger' : 'info'}>{alert.classification}</Pill></div>
            {alert.detail ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-slateink-500">{alert.detail}</p> : null}
          </article>)}
          {(client.alerts ?? []).length === 0 ? <p className="text-[12px] text-slateink-400">No visible active alerts.</p> : null}
        </div>
        <div className="mt-5 border-t border-slate-900/[0.05] pt-4"><h3 className="text-[12px] font-semibold">Active caseload assignments</h3><p className="mt-1 text-[11px] text-slateink-400">{assignments.length ? `${assignments.length} active assignment(s)` : 'No assignment recorded.'}</p></div>
      </section>
    </div> : null}

    {tab === 'contacts' ? <div className="space-y-4">
      <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[11.5px] leading-relaxed text-amber-900">This screen acknowledges synthetic-test mode for writes. Do not enter real patient or associated-contact information until live-mode approval gates are complete.</div>
      <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
        <section className="panel overflow-hidden" aria-labelledby="relationships-title"><div className="border-b border-slate-900/[0.05] px-5 py-4"><div className="flex items-center justify-between gap-3"><div><h2 id="relationships-title" className="text-[15px] font-semibold">Associated contacts</h2><p className="mt-1 text-[11px] text-slateink-400">Guardian, proxy, billing, emergency and referrer roles are explicit and independently verified.</p></div><Link href="/dashboard/intake" className="btn-quiet btn-sm">Directory</Link></div></div>
          <div className="divide-y divide-slate-900/[0.05]">{relationships.map((row) => <article key={row.id} className="px-5 py-4"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[12.5px] font-semibold">{row.contact?.name ?? row.relatedClient?.name ?? 'Linked record'}</h3><Pill tone={row.verified ? 'brand' : 'warn'}>{row.verified ? 'verified' : 'not verified'}</Pill></div><p className="mt-1 text-[11px] text-slateink-400">{row.relationshipType.replaceAll('_', ' ')}{row.contact?.email ? ` · ${row.contact.email}` : ''}{row.contact?.phone ? ` · ${row.contact.phone}` : ''}</p><div className="mt-2 flex flex-wrap gap-1.5">{row.guardian && <Pill tone="default">guardian</Pill>}{row.proxy && <Pill tone="default">proxy</Pill>}{row.billing && <Pill tone="info">billing</Pill>}{row.emergency && <Pill tone="warn">emergency</Pill>}{row.referrer && <Pill tone="brand">referrer</Pill>}</div></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void endRelationship(row)}>End</Button></div></article>)}{!relationships.length && <p className="px-5 py-8 text-center text-[12px] text-slateink-400">No active associated contacts.</p>}</div>
          <div className="border-t border-slate-900/[0.05] bg-slate-900/[0.015] p-5"><h3 className="text-[12.5px] font-semibold">Link a directory contact</h3><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="block text-[10.5px] font-medium text-slateink-500">Contact<select value={relationshipDraft.contactId} onChange={(event) => setRelationshipDraft((current) => ({ ...current, contactId: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">Choose…</option>{directoryContacts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="block text-[10.5px] font-medium text-slateink-500">Relationship<select value={relationshipDraft.relationshipType} onChange={(event) => setRelationshipDraft((current) => ({ ...current, relationshipType: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="emergency_contact">Emergency contact</option><option value="parent">Parent</option><option value="guardian">Guardian</option><option value="partner">Partner</option><option value="carer">Carer</option><option value="support_worker">Support worker</option><option value="employer">Employer</option><option value="referrer">Referrer</option><option value="payer">Payer</option><option value="other">Other</option></select></label></div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[10.5px]">{(['guardian', 'proxy', 'billing', 'emergency', 'referrer', 'verified'] as const).map((flag) => <label key={flag} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={relationshipDraft[flag]} onChange={(event) => setRelationshipDraft((current) => ({ ...current, [flag]: event.target.checked }))} /> {flag}</label>)}</div><Button className="mt-4 w-full" size="sm" disabled={busy || !relationshipDraft.contactId} onClick={() => void createRelationship()}>{busy ? 'Saving…' : 'Link contact'}</Button></div>
        </section>
        <section className="panel overflow-hidden" aria-labelledby="custom-fields-title"><div className="border-b border-slate-900/[0.05] px-5 py-4"><div className="flex items-center justify-between gap-3"><div><h2 id="custom-fields-title" className="text-[15px] font-semibold">Custom fields</h2><p className="mt-1 text-[11px] text-slateink-400">Typed values retain source and verification evidence. Restricted fields appear only with clinical access.</p></div><Link href="/dashboard/intake" className="btn-quiet btn-sm">Configure</Link></div></div><div className="divide-y divide-slate-900/[0.05]">{customFields.map((entry) => { const definition = entry.definition; const value = customDrafts[definition.id]; return <div key={definition.id} className="px-5 py-4"><div className="flex flex-wrap items-center gap-2"><label htmlFor={`custom-${definition.id}`} className="text-[11.5px] font-semibold">{definition.label}</label>{definition.required && <Pill tone="warn">required</Pill>}<Pill tone={definition.sensitivity === 'clinical' ? 'danger' : definition.sensitivity === 'sensitive' ? 'warn' : 'default'}>{definition.sensitivity}</Pill>{entry.value && <Pill tone={entry.value.verificationStatus === 'verified' ? 'brand' : 'warn'}>{entry.value.verificationStatus}</Pill>}</div><div className="mt-2 flex items-start gap-2">{definition.valueType === 'boolean' ? <select id={`custom-${definition.id}`} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(event) => setCustomDrafts((current) => ({ ...current, [definition.id]: event.target.value === '' ? '' : event.target.value === 'true' }))} className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option></select> : definition.valueType === 'single_choice' ? <select id={`custom-${definition.id}`} value={String(value ?? '')} onChange={(event) => setCustomDrafts((current) => ({ ...current, [definition.id]: event.target.value }))} className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">Choose…</option>{definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : definition.valueType === 'multiple_choice' ? <select id={`custom-${definition.id}`} multiple value={Array.isArray(value) ? value.map(String) : []} onChange={(event) => setCustomDrafts((current) => ({ ...current, [definition.id]: Array.from(event.target.selectedOptions, (option) => option.value) }))} className="min-h-24 min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]">{definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : definition.valueType === 'long_text' ? <textarea id={`custom-${definition.id}`} value={String(value ?? '')} onChange={(event) => setCustomDrafts((current) => ({ ...current, [definition.id]: event.target.value }))} className="min-h-20 min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" /> : <input id={`custom-${definition.id}`} type={definition.valueType === 'number' ? 'number' : definition.valueType === 'date' ? 'date' : 'text'} value={String(value ?? '')} onChange={(event) => setCustomDrafts((current) => ({ ...current, [definition.id]: event.target.value }))} className="min-w-0 flex-1 rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" />}<Button size="sm" disabled={busy} onClick={() => void saveCustomField(entry)}>Save</Button></div></div>; })}{!customFields.length && <p className="px-5 py-8 text-center text-[12px] text-slateink-400">No visible patient custom fields are configured.</p>}</div></section>
      </div>
      <section className="panel p-5" aria-labelledby="patient-address-title">
        <div className="mb-4"><h2 id="patient-address-title" className="text-[15px] font-semibold">Structured postal address</h2><p className="mt-1 text-[11px] text-slateink-400">Legacy text stays preserved until a staff member explicitly reviews the address components.</p></div>
        <StructuredAddressEditor value={client.structuredAddress} legacyAddress={client.address} busy={busy} onSave={saveAddress} idPrefix="patient-address" />
      </section>
    </div> : null}

    {tab === 'appointments' ? <section className="panel overflow-hidden" aria-labelledby="appointments-title"><h2 id="appointments-title" className="border-b border-slate-900/[0.05] px-5 py-4 text-[15px] font-semibold">Appointments</h2><div className="divide-y divide-slate-900/[0.05]">{(client.appointments ?? []).map((row) => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><div><p className="text-[12.5px] font-medium">{row.serviceName ?? row.service ?? 'Appointment'}</p><p className="mt-1 text-[11px] text-slateink-400">{fmtDate(row.startsAt)} · {row.durationMinutes} min · {row.providerName ?? 'Unassigned'}</p></div><Pill tone={row.status === 'cancelled' ? 'danger' : 'default'}>{row.status}</Pill></article>)}{(client.appointments ?? []).length === 0 ? <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No appointments.</p> : null}</div></section> : null}

    {tab === 'documents' && documents !== null ? <section className="panel overflow-hidden" aria-labelledby="record-documents-title"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-900/[0.05] px-5 py-4"><h2 id="record-documents-title" className="text-[15px] font-semibold">Documents</h2><Link className="btn-ghost btn-sm" href={`/dashboard/files?patientId=${encodeURIComponent(client.id)}`}><Icons.plus size={13} /> Upload or manage</Link></div><div className="divide-y divide-slate-900/[0.05]">{documents.map((row) => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><div><p className="text-[12.5px] font-medium">{row.title}</p><p className="mt-1 font-mono text-[10.5px] text-slateink-400">{row.category} · {row.versionCount} version(s)</p></div><div className="flex items-center gap-2"><Pill tone={row.currentScanStatus === 'clean' ? 'brand' : row.currentScanStatus === 'infected' ? 'danger' : 'warn'}>{row.status === 'metadata_only' ? 'metadata only' : row.currentScanStatus ?? 'pending'}</Pill>{row.currentScanStatus === 'clean' ? <a className="btn-quiet btn-sm" href={`/api/v1/documents/${encodeURIComponent(row.id)}/download`}>Download</a> : null}</div></article>)}{documents.length === 0 ? <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No document records linked to this client.</p> : null}</div></section> : null}

    {tab === 'access' && access !== null ? <section className="panel overflow-hidden" aria-labelledby="access-title"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 id="access-title" className="text-[15px] font-semibold">Append-only clinical access</h2><p className="mt-1 text-[11px] text-slateink-400">Newest 200 events are shown here; controlled export includes the complete uncapped stream.</p></div><div className="divide-y divide-slate-900/[0.05]">{access.map((row) => <article key={row.id} className="grid gap-1 px-5 py-3 sm:grid-cols-[180px_1fr_140px]"><span className="font-mono text-[10.5px] text-slateink-400">{new Date(row.occurredAt).toLocaleString('en-GB')}</span><span className="text-[12px]">{row.actorLabel ?? row.actorId} · {row.action} {row.resourceType}</span><span className="text-[10.5px] text-slateink-400">{row.purpose}</span></article>)}</div></section> : null}
  </div>;
}
