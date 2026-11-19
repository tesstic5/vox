'use client';

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';
import type { FormField, FormSchema } from '@/lib/forms-schema';

type MappingKey = 'patientName' | 'dateOfBirth' | 'email' | 'phone' | 'address' | 'reason' | 'notes' | 'consent' | 'referrerName' | 'referrerEmail' | 'referrerPhone' | 'referrerOrganisation' | 'referrerRole';
type Mapping = Record<MappingKey, string>;
type Routing = { priority: 'routine' | 'soon' | 'urgent'; serviceId: string; locationId: string; practitionerId: string; ownerId: string };
type ReferralForm = { id: string; name: string; slug: string; templateId: string; templateVersion: number; mapping: Partial<Mapping>; routing: Partial<Routing>; privacyNotice: string; emergencyNotice: string; completionMessage: string; active: boolean; revision: number; publicPath: string };
type Template = { id: string; name: string; category: string; state: string; publishedVersion?: number };
type Option = { id: string; name: string; active?: boolean };
type Member = { id: string; name: string; email?: string; active?: boolean };
type Editor = { name: string; slug: string; templateId: string; mapping: Mapping; routing: Routing; privacyNotice: string; emergencyNotice: string; completionMessage: string; active: boolean };

const emptyMapping = (): Mapping => ({ patientName: '', dateOfBirth: '', email: '', phone: '', address: '', reason: '', notes: '', consent: '', referrerName: '', referrerEmail: '', referrerPhone: '', referrerOrganisation: '', referrerRole: '' });
const emptyRouting = (): Routing => ({ priority: 'routine', serviceId: '', locationId: '', practitionerId: '', ownerId: '' });
const blank = (): Editor => ({
  name: '', slug: '', templateId: '', mapping: emptyMapping(), routing: emptyRouting(), active: false,
  privacyNotice: 'Information submitted through this form is used by the practice to review and administer the referral. Contact the practice for its full privacy notice and your data-protection rights.',
  emergencyNotice: 'This form is not continuously monitored and must not be used for urgent or emergency concerns. Use the practice’s published urgent-contact advice or emergency services.',
  completionMessage: 'Thank you. The practice has received this referral for administrative review. Submission does not confirm acceptance or clinical triage.',
});

const MAPPINGS: Array<{ key: MappingKey; label: string; required?: boolean; types: FormField['type'][]; note?: string }> = [
  { key: 'patientName', label: 'Patient name', required: true, types: ['text'] },
  { key: 'dateOfBirth', label: 'Date of birth', types: ['date'] },
  { key: 'email', label: 'Patient email', types: ['text'] },
  { key: 'phone', label: 'Patient phone', types: ['text'] },
  { key: 'address', label: 'Patient address', types: ['text', 'long_text'] },
  { key: 'reason', label: 'Reason for referral', required: true, types: ['text', 'long_text'] },
  { key: 'notes', label: 'Additional notes', types: ['text', 'long_text'] },
  { key: 'consent', label: 'Consent / acknowledgement', types: ['yes_no', 'acknowledgement'], note: 'If mapped, the answer must be Yes / acknowledged.' },
  { key: 'referrerName', label: 'Referrer name', types: ['text'] },
  { key: 'referrerEmail', label: 'Referrer email', types: ['text'] },
  { key: 'referrerPhone', label: 'Referrer phone', types: ['text'] },
  { key: 'referrerOrganisation', label: 'Referrer organisation', types: ['text'] },
  { key: 'referrerRole', label: 'Referrer role', types: ['text'] },
];

export default function ReferralFormsPage() {
  const [rows, setRows] = React.useState<ReferralForm[]>([]);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [schema, setSchema] = React.useState<FormSchema>();
  const [services, setServices] = React.useState<Option[]>([]);
  const [locations, setLocations] = React.useState<Option[]>([]);
  const [practitioners, setPractitioners] = React.useState<Option[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [editor, setEditor] = React.useState<Editor>(blank);
  const [editing, setEditing] = React.useState<ReferralForm>();
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);

  const loadTemplate = React.useCallback(async (templateId: string) => {
    if (!templateId) { setSchema(undefined); return; }
    const body = await api(`/api/v1/forms/templates/${encodeURIComponent(templateId)}`);
    setSchema(body.version?.schema);
  }, [api]);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [formBody, templateBody, serviceBody, locationBody, practitionerBody, teamBody] = await Promise.all([
        api('/api/v1/referral-forms'), api('/api/v1/forms/templates'), api('/api/v1/services'), api('/api/v1/locations'), api('/api/v1/providers'), api('/api/v1/team?view=members'),
      ]);
      setRows(formBody.data ?? []);
      setTemplates((templateBody.data ?? []).filter((row: Template) => row.category === 'referral' && row.state === 'published'));
      setServices(serviceBody.data ?? []); setLocations(locationBody.data ?? []); setPractitioners(practitionerBody.data ?? []); setMembers(teamBody.members ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Referral forms could not be loaded.'); }
    finally { setLoading(false); }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  const chooseTemplate = async (templateId: string) => {
    setEditor((current) => ({ ...current, templateId, mapping: emptyMapping() }));
    setError('');
    try { await loadTemplate(templateId); }
    catch (reason) { setSchema(undefined); setError(reason instanceof Error ? reason.message : 'The template could not be loaded.'); }
  };

  const beginEdit = async (row: ReferralForm) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api(`/api/v1/referral-forms/${encodeURIComponent(row.id)}`);
      const form = body.form as ReferralForm;
      setEditing(form); setSchema(body.version?.schema);
      setEditor({
        name: form.name, slug: form.slug, templateId: form.templateId,
        mapping: { ...emptyMapping(), ...form.mapping },
        routing: { ...emptyRouting(), ...form.routing },
        privacyNotice: form.privacyNotice, emergencyNotice: form.emergencyNotice,
        completionMessage: form.completionMessage, active: form.active,
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The referral form could not be opened.'); }
    finally { setBusy(false); }
  };

  const reset = () => { setEditing(undefined); setEditor(blank()); setSchema(undefined); setError(''); };
  const slugFrom = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    const payload = {
      name: editor.name, slug: editor.slug, templateId: editor.templateId,
      mapping: Object.fromEntries(Object.entries(editor.mapping).filter(([, value]) => value)),
      routing: Object.fromEntries(Object.entries(editor.routing).filter(([key, value]) => key === 'priority' || value)),
      privacyNotice: editor.privacyNotice, emergencyNotice: editor.emergencyNotice,
      completionMessage: editor.completionMessage, active: editor.active,
    };
    try {
      if (editing) {
        await api(`/api/v1/referral-forms/${encodeURIComponent(editing.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: editing.revision, patch: { ...payload, slug: undefined } }) });
        setNotice(`“${editor.name}” was updated${editor.active ? ' and is publicly available' : ' and remains disabled'}.`);
      } else {
        const created = await api('/api/v1/referral-forms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setNotice(`“${created.name}” was created${created.active ? ' and is publicly available' : ' as a disabled draft'}. Its public address is now immutable.`);
      }
      setEditing(undefined); setEditor(blank()); setSchema(undefined); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The referral form could not be saved.'); }
    finally { setBusy(false); }
  };

  const toggle = async (row: ReferralForm) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/referral-forms/${encodeURIComponent(row.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: row.revision, patch: { active: !row.active } }) });
      setNotice(row.active ? `“${row.name}” is disabled. Existing submitted referrals remain in the inbox.` : `“${row.name}” is now public. Its emergency and privacy wording should be kept under review.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The referral form could not be updated.'); }
    finally { setBusy(false); }
  };

  const copy = async (row: ReferralForm) => {
    const url = `${window.location.origin}${row.publicPath}`;
    try { await navigator.clipboard.writeText(url); setNotice('Public referral link copied.'); }
    catch { setNotice(url); }
  };

  const fieldsFor = (types: FormField['type'][]) => (schema?.fields ?? []).filter((field) => types.includes(field.type));
  const invalidRequiredMapping = !editor.mapping.patientName || !editor.mapping.reason;
  const duplicateMapping = Object.values(editor.mapping).filter(Boolean).length !== new Set(Object.values(editor.mapping).filter(Boolean)).size;
  const referrerDependency = !editor.mapping.referrerName && [editor.mapping.referrerEmail, editor.mapping.referrerPhone, editor.mapping.referrerOrganisation, editor.mapping.referrerRole].some(Boolean);
  const canSave = Boolean(editor.name.trim().length >= 2 && editor.slug.length >= 4 && editor.templateId && schema && editor.privacyNotice.trim().length >= 20 && editor.emergencyNotice.trim().length >= 20 && editor.completionMessage.trim().length >= 10 && !invalidRequiredMapping && !duplicateMapping && !referrerDependency);

  return <div className="space-y-6">
    <PageHeader title="Public referral forms" desc="Publish a secure referral address backed by an immutable form version, explicit field mapping and deterministic queue routing." actions={<Link href="/dashboard/referrals" className="btn-ghost btn-sm"><Icons.chevronRight size={13} className="rotate-180" /> Referral inbox</Link>} />
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">Public forms create administrative referrals only. Priority changes queue ordering; Voxera does not diagnose, score symptoms or promise continuous monitoring. This screen is for synthetic-test configuration until every independent live-data gate has passed.</section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}

    <div className="grid gap-5 2xl:grid-cols-[minmax(420px,0.85fr)_minmax(560px,1.15fr)] 2xl:items-start">
      <section className="panel p-5 2xl:sticky 2xl:top-20">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-[15px] font-semibold">{editing ? 'Edit referral form' : 'Create referral form'}</h2><p className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">The public slug cannot be changed after creation. Updating a template repins only after an explicit save.</p></div>{editing && <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>}</div>
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-[11px] font-medium text-slateink-500">Configuration name<input value={editor.name} onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value, slug: editing ? current.slug : slugFrom(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" placeholder="Website self-referral" /></label><label className="text-[11px] font-medium text-slateink-500">Public address<input value={editor.slug} disabled={Boolean(editing)} onChange={(event) => setEditor((current) => ({ ...current, slug: slugFrom(event.target.value) }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[12px] disabled:bg-slate-100" placeholder="physio-referral" /><span className="mt-1 block font-normal text-slateink-300">/refer/{editor.slug || 'your-address'}</span></label></div>
          <label className="block text-[11px] font-medium text-slateink-500">Published referral template<select value={editor.templateId} onChange={(event) => void chooseTemplate(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="">Choose…</option>{templates.map((row) => <option key={row.id} value={row.id}>{row.name} · version {row.publishedVersion}</option>)}</select></label>
          {!templates.length && !loading && <p className="rounded-xl bg-slate-50 p-3 text-[11.5px] leading-relaxed text-slateink-500">No published referral template exists. <Link href="/dashboard/forms" className="font-semibold text-brand-700 underline">Build and publish one in Forms</Link> first.</p>}

          {schema && <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Field mapping</h3><p className="mt-1 text-[11px] leading-relaxed text-slateink-400">Required identity and reason mappings must point to required template fields. One template field may have only one purpose.</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{MAPPINGS.map((item) => <label key={item.key} className="text-[10.5px] font-medium text-slateink-500">{item.label}{item.required && <span className="ml-1 text-red-600">*</span>}<select value={editor.mapping[item.key]} onChange={(event) => setEditor((current) => ({ ...current, mapping: { ...current.mapping, [item.key]: event.target.value } }))} className="mt-1 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">Not mapped</option>{fieldsFor(item.types).map((field) => <option key={field.key} value={field.key}>{field.label}{field.required ? ' · required' : ''}</option>)}</select>{item.note && <span className="mt-1 block font-normal text-slateink-300">{item.note}</span>}</label>)}</div>{duplicateMapping && <p className="mt-2 text-[11px] text-red-700">Each template field can be mapped only once.</p>}{referrerDependency && <p className="mt-2 text-[11px] text-red-700">Map referrer name before mapping other referrer details.</p>}</div>}

          <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slateink-300">Queue routing</h3><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-[10.5px] font-medium text-slateink-500">Default priority<select value={editor.routing.priority} onChange={(event) => setEditor((current) => ({ ...current, routing: { ...current.routing, priority: event.target.value as Routing['priority'] } }))} className="mt-1 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent queue marker</option></select></label><RoutingSelect label="Service" value={editor.routing.serviceId} options={services} onChange={(value) => setEditor((current) => ({ ...current, routing: { ...current.routing, serviceId: value } }))} /><RoutingSelect label="Location" value={editor.routing.locationId} options={locations} onChange={(value) => setEditor((current) => ({ ...current, routing: { ...current.routing, locationId: value } }))} /><RoutingSelect label="Practitioner" value={editor.routing.practitionerId} options={practitioners} onChange={(value) => setEditor((current) => ({ ...current, routing: { ...current.routing, practitionerId: value } }))} /><RoutingSelect label="Inbox owner" value={editor.routing.ownerId} options={members} onChange={(value) => setEditor((current) => ({ ...current, routing: { ...current.routing, ownerId: value } }))} /></div><p className="mt-2 text-[10.5px] leading-relaxed text-slateink-400">The server verifies that the selected practitioner works at the location and provides the service. No clinical urgency is inferred from answers.</p></div>

          <label className="block text-[11px] font-medium text-slateink-500">Privacy notice<textarea value={editor.privacyNotice} onChange={(event) => setEditor((current) => ({ ...current, privacyNotice: event.target.value }))} className="mt-1.5 min-h-28 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
          <label className="block text-[11px] font-medium text-slateink-500">Emergency / monitoring notice<textarea value={editor.emergencyNotice} onChange={(event) => setEditor((current) => ({ ...current, emergencyNotice: event.target.value }))} className="mt-1.5 min-h-24 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
          <label className="block text-[11px] font-medium text-slateink-500">Completion message<textarea value={editor.completionMessage} onChange={(event) => setEditor((current) => ({ ...current, completionMessage: event.target.value }))} className="mt-1.5 min-h-24 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
          <label className="flex items-start gap-3 rounded-xl border border-slate-900/[0.08] p-3 text-[11.5px] leading-relaxed"><input type="checkbox" checked={editor.active} onChange={(event) => setEditor((current) => ({ ...current, active: event.target.checked }))} className="mt-0.5" /><span><strong className="block text-slate-900">Make this address public</strong>I have reviewed the template mapping, privacy wording and emergency limitation. Disabling later stops new and in-progress public referrals; submitted records remain.</span></label>
          <Button className="w-full" size="sm" disabled={busy || !canSave} onClick={() => void save()}>{busy ? 'Saving…' : editing ? 'Save referral form' : 'Create referral form'}</Button>
        </div>
      </section>

      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Configured public addresses</h2><p className="mt-1 text-[11.5px] text-slateink-400">Bearer draft tokens are hashed and never listed. Public slugs are platform-wide and immutable.</p></div><div className="divide-y divide-slate-900/[0.05]">{rows.map((row) => <article key={row.id} className="p-5"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[13px] font-semibold">{row.name}</h3><Pill tone={row.active ? 'brand' : 'default'}>{row.active ? 'public' : 'disabled'}</Pill><Pill tone={row.routing.priority === 'urgent' ? 'warn' : 'default'}>{row.routing.priority ?? 'routine'}</Pill></div><p className="mt-1 font-mono text-[10.5px] text-slateink-400">{row.publicPath} · template v{row.templateVersion}</p><p className="mt-2 text-[11px] leading-relaxed text-slateink-400">{row.active ? 'Accepting new 24-hour referral drafts.' : 'New referrals and draft resume are unavailable.'}</p></div><div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void beginEdit(row)}>Edit</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void copy(row)}>Copy link</Button>{row.active && <a href={row.publicPath} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Open <Icons.arrowUpRight size={12} /></a>}<Button variant={row.active ? 'ghost' : 'primary'} size="sm" disabled={busy} onClick={() => void toggle(row)}>{row.active ? 'Disable' : 'Publish'}</Button></div></div></article>)}{!loading && !rows.length && <div className="px-5 py-14 text-center"><p className="text-[12px] text-slateink-400">No public referral forms configured.</p><p className="mt-1 text-[10.5px] text-slateink-300">Create one only after its published template and notices have been reviewed.</p></div>}</div></section>
    </div>
  </div>;
}

function RoutingSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<Option | Member>; onChange: (value: string) => void }) {
  return <label className="text-[10.5px] font-medium text-slateink-500">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">No fixed {label.toLowerCase()}</option>{options.filter((row) => row.active !== false).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
}
