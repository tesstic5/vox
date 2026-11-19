'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';
import { CustomFieldEditor, draftsForCustomFields, type CustomFieldEntry } from '@/components/dash/CustomFieldEditor';
import { StructuredAddressEditor } from '@/components/dash/StructuredAddressEditor';
import type { StructuredAddress, StructuredAddressInput } from '@/lib/addresses';

type Contact = { id: string; kind: 'person' | 'organisation'; name: string; email?: string; phone?: string; address?: string; structuredAddress?: StructuredAddress; referrer: boolean; payer: boolean; active: boolean; revision: number };
type FieldType = 'text' | 'long_text' | 'number' | 'date' | 'boolean' | 'single_choice' | 'multiple_choice';
type CustomField = { id: string; targetType: 'client' | 'contact' | 'referral'; key: string; label: string; valueType: FieldType; options?: Array<{ value: string; label: string }>; sensitivity: 'administrative' | 'sensitive' | 'clinical'; required: boolean; active: boolean; order: number; revision: number };

const syntheticHeaders = { 'x-voxera-synthetic-data': '1' };
const TYPES: Array<{ value: FieldType; label: string }> = [
  { value: 'text', label: 'Short text' }, { value: 'long_text', label: 'Long text' }, { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' }, { value: 'boolean', label: 'Yes / no' }, { value: 'single_choice', label: 'Single choice' },
  { value: 'multiple_choice', label: 'Multiple choice' },
];

export default function IntakeAdministrationPage() {
  const [tab, setTab] = React.useState<'contacts' | 'fields'>('contacts');
  const [contacts, setContacts] = React.useState<Contact[]>([]);
  const [fields, setFields] = React.useState<CustomField[]>([]);
  const [selectedContactId, setSelectedContactId] = React.useState('');
  const [contactFields, setContactFields] = React.useState<CustomFieldEntry[]>([]);
  const [contactFieldsTargetId, setContactFieldsTargetId] = React.useState('');
  const [contactDrafts, setContactDrafts] = React.useState<Record<string, unknown>>({});
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [contact, setContact] = React.useState({ kind: 'person', name: '', email: '', phone: '', address: '', referrer: false, payer: false });
  const [definition, setDefinition] = React.useState({ targetType: 'client', key: '', label: '', valueType: 'text' as FieldType, options: '', sensitivity: 'administrative', required: false });

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [contactBody, fieldBody] = await Promise.all([
        api('/api/v1/contacts?active=true'),
        api('/api/v1/custom-fields?includeInactive=true'),
      ]);
      const loadedContacts = (contactBody.data ?? []) as Contact[];
      setContacts(loadedContacts); setFields(fieldBody.data ?? []);
      setSelectedContactId((current) => current && loadedContacts.some((row) => row.id === current) ? current : loadedContacts[0]?.id ?? '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Intake administration could not be loaded.'); }
    finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => { void load(); }, [load]);
  const selectedContact = contacts.find((row) => row.id === selectedContactId);
  const loadContactFields = React.useCallback(async (id: string) => {
    if (!id) { setContactFields([]); setContactFieldsTargetId(''); setContactDrafts({}); return; }
    try {
      const body = await api(`/api/v1/contacts/${encodeURIComponent(id)}/custom-fields`);
      const entries = (body.data ?? []) as CustomFieldEntry[];
      setContactFields(entries);
      setContactFieldsTargetId(id);
      setContactDrafts(draftsForCustomFields(entries));
    } catch (reason) {
      setContactFields([]); setContactFieldsTargetId(''); setContactDrafts({});
      setError(reason instanceof Error ? reason.message : 'Contact fields could not be loaded.');
    }
  }, [api]);
  React.useEffect(() => {
    setContactFields([]);
    setContactDrafts({});
    void loadContactFields(selectedContactId);
  }, [loadContactFields, selectedContactId]);

  const createContact = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/v1/contacts', {
        method: 'POST', headers: { 'content-type': 'application/json', ...syntheticHeaders },
        body: JSON.stringify({ ...contact, email: contact.email || undefined, phone: contact.phone || undefined, address: contact.address || undefined }),
      });
      setContact({ kind: 'person', name: '', email: '', phone: '', address: '', referrer: false, payer: false });
      setNotice('Contact added to the reusable practice directory.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Contact creation failed.'); }
    finally { setBusy(false); }
  };

  const deactivateContact = async (row: Contact) => {
    setBusy(true); setError('');
    try {
      await api(`/api/v1/contacts/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...syntheticHeaders },
        body: JSON.stringify({ expectedRevision: row.revision, patch: { active: false } }),
      });
      setNotice('Contact deactivated. Existing patient relationships remain as evidence.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Contact update failed.'); }
    finally { setBusy(false); }
  };

  const saveContactField = async (entry: CustomFieldEntry) => {
    if (!selectedContact) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/contacts/${encodeURIComponent(selectedContact.id)}/custom-fields`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...syntheticHeaders },
        body: JSON.stringify({ definitionId: entry.definition.id, value: contactDrafts[entry.definition.id], expectedRevision: entry.value?.revision ?? null }),
      });
      setNotice(`${entry.definition.label} saved for ${selectedContact.name}.`);
      await loadContactFields(selectedContact.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Contact field could not be saved.'); }
    finally { setBusy(false); }
  };

  const saveContactAddress = async (address: StructuredAddressInput) => {
    if (!selectedContact) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/contacts/${encodeURIComponent(selectedContact.id)}/address`, {
        method: 'PUT', headers: { 'content-type': 'application/json', ...syntheticHeaders },
        body: JSON.stringify({ expectedRevision: selectedContact.revision, address }),
      });
      setNotice(`Structured address reviewed for ${selectedContact.name}; legacy text remains preserved.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Contact address could not be saved.'); }
    finally { setBusy(false); }
  };

  const createField = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const options = ['single_choice', 'multiple_choice'].includes(definition.valueType)
        ? definition.options.split('\n').map((label) => label.trim()).filter(Boolean).map((label) => ({ value: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label }))
        : undefined;
      await api('/api/v1/custom-fields', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...definition, options }),
      });
      setDefinition({ targetType: 'client', key: '', label: '', valueType: 'text', options: '', sensitivity: 'administrative', required: false });
      setNotice('Typed custom field created. Its stable key cannot be renamed.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Custom-field creation failed.'); }
    finally { setBusy(false); }
  };

  const toggleField = async (row: CustomField) => {
    setBusy(true); setError('');
    try {
      await api(`/api/v1/custom-fields/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: row.revision, patch: { active: !row.active } }),
      });
      setNotice(row.active ? 'Field retired. Existing values remain preserved.' : 'Field reactivated.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Custom-field update failed.'); }
    finally { setBusy(false); }
  };

  return <div className="space-y-6">
    <PageHeader title="Intake administration" desc="Maintain reusable associated contacts and typed patient, referral and contact fields. Patient links and values are managed from the patient record." actions={<Link href="/dashboard/forms" className="btn-ghost btn-sm"><Icons.layers size={13} /> Form builder</Link>} />
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12px] leading-relaxed text-amber-900">Synthetic-test mode is acknowledged for contact writes on this screen. Do not enter real patient or associated-person information until all independent live-mode gates have passed.</section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}
    <div className="flex gap-2" role="tablist" aria-label="Intake administration sections">
      <button role="tab" aria-selected={tab === 'contacts'} onClick={() => setTab('contacts')} className={`rounded-xl px-4 py-2 text-[12px] font-semibold ${tab === 'contacts' ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.08] bg-white'}`}>Contact directory <span className="ml-1 opacity-70">{contacts.length}</span></button>
      <button role="tab" aria-selected={tab === 'fields'} onClick={() => setTab('fields')} className={`rounded-xl px-4 py-2 text-[12px] font-semibold ${tab === 'fields' ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.08] bg-white'}`}>Custom fields <span className="ml-1 opacity-70">{fields.length}</span></button>
    </div>

    {tab === 'contacts' && <div className="space-y-5"><div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)] xl:items-start">
      <section className="panel p-5"><h2 className="text-[15px] font-semibold">Add an associated contact</h2><p className="mt-1 text-[11.5px] text-slateink-400">This is a non-patient person or organisation. Link it to one or more patients from their record.</p><div className="mt-4 space-y-3">
        <label className="block text-[11px] font-medium text-slateink-500">Type<select value={contact.kind} onChange={(event) => setContact((current) => ({ ...current, kind: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="person">Person</option><option value="organisation">Organisation</option></select></label>
        <label className="block text-[11px] font-medium text-slateink-500">Name<input value={contact.name} onChange={(event) => setContact((current) => ({ ...current, name: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-[11px] font-medium text-slateink-500">Email<input type="email" value={contact.email} onChange={(event) => setContact((current) => ({ ...current, email: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="block text-[11px] font-medium text-slateink-500">Phone<input value={contact.phone} onChange={(event) => setContact((current) => ({ ...current, phone: event.target.value }))} placeholder="+44…" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label></div>
        <label className="block text-[11px] font-medium text-slateink-500">Address<textarea value={contact.address} onChange={(event) => setContact((current) => ({ ...current, address: event.target.value }))} className="mt-1.5 min-h-20 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <div className="flex flex-wrap gap-4 text-[11px]"><label className="flex items-center gap-2"><input type="checkbox" checked={contact.referrer} onChange={(event) => setContact((current) => ({ ...current, referrer: event.target.checked }))} /> Can refer</label><label className="flex items-center gap-2"><input type="checkbox" checked={contact.payer} onChange={(event) => setContact((current) => ({ ...current, payer: event.target.checked }))} /> Can pay</label></div>
        <Button className="w-full" size="sm" disabled={busy || contact.name.trim().length < 2} onClick={() => void createContact()}>{busy ? 'Saving…' : 'Add contact'}</Button>
      </div></section>
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Reusable directory</h2><p className="mt-1 text-[11.5px] text-slateink-400">Only active contacts are shown. Deactivation never deletes historical relationships.</p></div><div className="divide-y divide-slate-900/[0.05]">{contacts.map((row) => <article key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[12.5px] font-semibold">{row.name}</h3><Pill tone="default">{row.kind}</Pill>{row.referrer && <Pill tone="brand">referrer</Pill>}{row.payer && <Pill tone="info">payer</Pill>}</div><p className="mt-1 text-[11px] text-slateink-400">{[row.email, row.phone].filter(Boolean).join(' · ') || 'No email or phone'}</p></div><div className="flex gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelectedContactId(row.id)}>Manage</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void deactivateContact(row)}>Deactivate</Button></div></article>)}{!loading && !contacts.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No associated contacts yet.</p>}</div></section>
    </div>
    {selectedContact && <section className="panel overflow-hidden" aria-labelledby="contact-administration-title">
      <div className="border-b border-slate-900/[0.05] px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="contact-administration-title" className="text-[15px] font-semibold">Manage {selectedContact.name}</h2><p className="mt-1 text-[11px] text-slateink-400">Review the postal address and enter typed values configured for associated contacts.</p></div><Pill tone="default">{selectedContact.kind}</Pill></div></div>
      <div className="grid gap-0 xl:grid-cols-2 xl:divide-x xl:divide-slate-900/[0.05]">
        <div className="p-5"><h3 className="text-[12.5px] font-semibold">Structured postal address</h3><p className="mt-1 mb-4 text-[10.5px] text-slateink-400">The original free text remains available as review evidence.</p><StructuredAddressEditor value={selectedContact.structuredAddress} legacyAddress={selectedContact.address} busy={busy} onSave={saveContactAddress} idPrefix="contact-address" /></div>
        <div><div className="border-b border-slate-900/[0.05] px-5 py-4"><h3 className="text-[12.5px] font-semibold">Contact custom fields</h3><p className="mt-1 text-[10.5px] text-slateink-400">Restricted fields appear only to staff with clinical access.</p></div><CustomFieldEditor entries={contactFieldsTargetId === selectedContact.id ? contactFields : []} drafts={contactDrafts} setDrafts={setContactDrafts} busy={busy} onSave={saveContactField} idPrefix="contact-custom" emptyText="No visible associated-contact fields are configured." /></div>
      </div>
    </section>}
    </div>}

    {tab === 'fields' && <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)] xl:items-start">
      <section className="panel p-5"><h2 className="text-[15px] font-semibold">Create a typed field</h2><p className="mt-1 text-[11.5px] text-slateink-400">The stable key supports form mappings. Type and key are immutable after creation.</p><div className="mt-4 space-y-3">
        <label className="block text-[11px] font-medium text-slateink-500">Applies to<select value={definition.targetType} onChange={(event) => setDefinition((current) => ({ ...current, targetType: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="client">Patient</option><option value="contact">Associated contact</option><option value="referral">Referral</option></select></label>
        <label className="block text-[11px] font-medium text-slateink-500">Label<input value={definition.label} onChange={(event) => setDefinition((current) => ({ ...current, label: event.target.value, key: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64) }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
        <label className="block text-[11px] font-medium text-slateink-500">Stable key<input value={definition.key} onChange={(event) => setDefinition((current) => ({ ...current, key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[12px]" /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-[11px] font-medium text-slateink-500">Type<select value={definition.valueType} onChange={(event) => setDefinition((current) => ({ ...current, valueType: event.target.value as FieldType }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]">{TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="block text-[11px] font-medium text-slateink-500">Sensitivity<select value={definition.sensitivity} onChange={(event) => setDefinition((current) => ({ ...current, sensitivity: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="administrative">Administrative</option><option value="sensitive">Sensitive</option><option value="clinical">Clinical</option></select></label></div>
        {['single_choice', 'multiple_choice'].includes(definition.valueType) && <label className="block text-[11px] font-medium text-slateink-500">Choices, one per line<textarea value={definition.options} onChange={(event) => setDefinition((current) => ({ ...current, options: event.target.value }))} className="mt-1.5 min-h-24 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>}
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={definition.required} onChange={(event) => setDefinition((current) => ({ ...current, required: event.target.checked }))} /> Required when this field is collected</label>
        <Button className="w-full" size="sm" disabled={busy || definition.label.trim().length < 2 || definition.key.length < 2} onClick={() => void createField()}>{busy ? 'Saving…' : 'Create field'}</Button>
      </div></section>
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Field catalogue</h2><p className="mt-1 text-[11.5px] text-slateink-400">Retiring a field hides it from new entry and mappings without deleting values.</p></div><div className="divide-y divide-slate-900/[0.05]">{fields.map((row) => <article key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[12.5px] font-semibold">{row.label}</h3><Pill tone={row.active ? 'brand' : 'danger'}>{row.active ? 'active' : 'retired'}</Pill><Pill tone="default">{row.targetType}</Pill><Pill tone={row.sensitivity === 'clinical' ? 'danger' : row.sensitivity === 'sensitive' ? 'warn' : 'default'}>{row.sensitivity}</Pill></div><p className="mt-1 font-mono text-[10.5px] text-slateink-400">custom:{row.key} · {row.valueType.replaceAll('_', ' ')}</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleField(row)}>{row.active ? 'Retire' : 'Reactivate'}</Button></article>)}{!loading && !fields.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No custom fields yet.</p>}</div></section>
    </div>}
  </div>;
}
