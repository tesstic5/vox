'use client';

import * as React from 'react';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';
import type { FormFieldType, FormSchema } from '@/lib/forms-schema';

type Template = { id: string; name: string; category: string; state: 'draft' | 'published' | 'archived'; currentVersion: number; publishedVersion?: number; revision: number; updatedAt?: string; createdAt?: string };
type Assignment = { id: string; templateId: string; templateVersion: number; clientId?: string; status: string; expiresAt: string; sentAt?: string; submittedAt?: string; revision: number; createdAt?: string };
type ResponseRow = { id: string; assignmentId: string; templateId: string; clientId?: string; status: 'in_progress' | 'submitted' | 'reviewed'; submittedAt?: string; reviewedAt?: string; respondent: { relationship: string; name?: string }; revision: number; updatedAt?: string; createdAt?: string };
type FieldDraft = { id: string; key: string; label: string; type: FormFieldType; required: boolean; options: string; updateTarget: string };
type CustomFieldOption = { id: string; key: string; label: string; valueType: string; active: boolean; targetType: string };
type ResponseDetail = { response: ResponseRow; version?: { answers: Record<string, unknown>; createdAt: string }; suggestions: Array<{ id: string; fieldKey: string; target: string; oldValue?: string; proposedValue: string; status: string; revision: number }> };

const FIELD_TYPES: Array<{ id: FormFieldType; label: string }> = [
  { id: 'text', label: 'Short text' }, { id: 'long_text', label: 'Long text' }, { id: 'number', label: 'Number' },
  { id: 'date', label: 'Date' }, { id: 'yes_no', label: 'Yes / no' }, { id: 'single_choice', label: 'Single choice' },
  { id: 'multiple_choice', label: 'Multiple choice' }, { id: 'acknowledgement', label: 'Acknowledgement' }, { id: 'file', label: 'Secure file' },
];
const clinicalHeaders = { 'x-voxera-synthetic-data': '1' };
const field = (index: number): FieldDraft => ({ id: `field_${Date.now()}_${index}`, key: `question_${index}`, label: '', type: 'text', required: false, options: '', updateTarget: '' });
const canMapToCustomField = (formType: FormFieldType, valueType: string) => ({
  text: ['text', 'single_choice'], long_text: ['long_text', 'text'], number: ['number'], date: ['date'],
  boolean: ['yes_no', 'acknowledgement'], single_choice: ['single_choice'], multiple_choice: ['multiple_choice'],
}[valueType]?.includes(formType) ?? false);

export default function FormsPage() {
  const [tab, setTab] = React.useState<'templates' | 'assignments' | 'responses'>('templates');
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [assignments, setAssignments] = React.useState<Assignment[]>([]);
  const [responses, setResponses] = React.useState<ResponseRow[]>([]);
  const [customFields, setCustomFields] = React.useState<CustomFieldOption[]>([]);
  const [detail, setDetail] = React.useState<ResponseDetail>();
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [builder, setBuilder] = React.useState({ name: '', category: 'intake', description: '', fields: [field(1)] });
  const [assignment, setAssignment] = React.useState({ templateId: '', clientId: '', channel: 'email', to: '', send: true });

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [templateBody, assignmentBody, responseBody, customFieldBody] = await Promise.all([
        api('/api/v1/forms/templates'), api('/api/v1/forms/assignments'), api('/api/v1/forms/responses'),
        api('/api/v1/custom-fields?targetType=client'),
      ]);
      setTemplates(templateBody.data ?? []); setAssignments(assignmentBody.data ?? []); setResponses(responseBody.data ?? []); setCustomFields(customFieldBody.data ?? []);
      setAssignment((current) => ({ ...current, templateId: current.templateId || templateBody.data?.find((row: Template) => row.state === 'published')?.id || '' }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Forms could not be loaded.'); }
    finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => { void load(); }, [load]);

  const createTemplate = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const fields = builder.fields.map((item, index) => ({
        id: item.id, key: item.key.trim() || `question_${index + 1}`, label: item.label.trim(), type: item.type, required: item.required,
        sensitivity: 'clinical' as const,
        updateTarget: (item.updateTarget || undefined) as FormSchema['fields'][number]['updateTarget'],
        options: ['single_choice', 'multiple_choice'].includes(item.type)
          ? item.options.split('\n').map((option) => option.trim()).filter(Boolean).map((option) => ({ value: option.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label: option }))
          : undefined,
      }));
      const schema: FormSchema = { version: 1, title: builder.name, description: builder.description, emergencyNotice: 'Do not use this form for urgent or emergency medical concerns.', fields };
      const body = await api('/api/v1/forms/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: builder.name, category: builder.category, schema }) });
      setBuilder({ name: '', category: 'intake', description: '', fields: [field(1)] });
      setNotice(`Draft “${body.template.name}” created. Publish it when it is ready to send.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Template creation failed.'); }
    finally { setBusy(false); }
  };

  const stateTemplate = async (row: Template, action: 'publish' | 'archive') => {
    setBusy(true); setError('');
    try {
      await api(`/api/v1/forms/templates/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: row.revision }) });
      setNotice(action === 'publish' ? 'The version is now published and can be assigned.' : 'Template archived. Existing links remain governed by their own expiry or revocation.');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Template update failed.'); }
    finally { setBusy(false); }
  };

  const assign = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api('/api/v1/forms/assignments', { method: 'POST', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ ...assignment, channel: assignment.channel, to: assignment.to || undefined }) });
      if (!assignment.send && body.publicUrl) {
        await navigator.clipboard?.writeText(body.publicUrl);
        setNotice('Secure link created and copied. It will not be shown again after this screen is refreshed.');
      } else setNotice(body.message?.status === 'blocked' ? `Assignment created, but delivery was blocked: ${body.message.reason}` : 'Secure form assigned and queued through the workspace message path.');
      setAssignment((current) => ({ ...current, clientId: '', to: '' }));
      await load(); setTab('assignments');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The form could not be assigned.'); }
    finally { setBusy(false); }
  };

  const openResponse = async (row: ResponseRow) => {
    setBusy(true); setError('');
    try { setDetail(await api(`/api/v1/forms/responses/${row.id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Response could not be opened.'); }
    finally { setBusy(false); }
  };

  const reviewResponse = async () => {
    if (!detail) return;
    setBusy(true); setError('');
    try {
      await api(`/api/v1/forms/responses/${detail.response.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ expectedRevision: detail.response.revision, note: 'Reviewed in the forms workspace.' }) });
      setDetail(undefined); setNotice('Response marked reviewed. Demographic suggestions still require an explicit decision.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Response review failed.'); }
    finally { setBusy(false); }
  };

  const decideSuggestion = async (suggestion: ResponseDetail['suggestions'][number], accept: boolean) => {
    setBusy(true); setError('');
    try {
      await api(`/api/v1/forms/suggestions/${suggestion.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ accept, expectedRevision: suggestion.revision }) });
      if (detail) await openResponse(detail.response);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Suggestion review failed.'); }
    finally { setBusy(false); }
  };

  const tone = (status: string): 'default' | 'brand' | 'warn' | 'danger' => status === 'published' || status === 'reviewed' || status === 'submitted' ? 'brand' : status === 'expired' || status === 'revoked' || status === 'archived' ? 'danger' : status === 'in_progress' || status === 'sent' ? 'warn' : 'default';

  return <div className="space-y-6">
    <PageHeader title="Forms" desc="Build versioned forms, send secure patient links, review submissions and approve demographic changes without overwriting the record silently." />
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">Synthetic-test mode is acknowledged by this screen. Do not enter or send real patient information until every independent live-mode gate has passed.</section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}
    {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Forms workflow">{(['templates', 'assignments', 'responses'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`rounded-xl px-4 py-2 text-[12px] font-semibold capitalize ${tab === item ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.08] bg-white text-slateink-500'}`}>{item} <span className="ml-1 opacity-70">{item === 'templates' ? templates.length : item === 'assignments' ? assignments.length : responses.length}</span></button>)}</div>

    {tab === 'templates' && <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)] xl:items-start">
      <section className="panel p-5"><h2 className="text-[15px] font-semibold text-slate-900">New form template</h2><p className="mt-1 text-[11.5px] text-slateink-400">Each save creates an immutable version. Choice options go on separate lines.</p>
        <div className="mt-4 space-y-3"><label className="block text-[11px] font-medium text-slateink-500">Title<input value={builder.name} onChange={(event) => setBuilder((current) => ({ ...current, name: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" placeholder="New patient intake" /></label>
          <label className="block text-[11px] font-medium text-slateink-500">Category<select value={builder.category} onChange={(event) => setBuilder((current) => ({ ...current, category: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="intake">Intake</option><option value="screening">Screening</option><option value="consent">Consent</option><option value="outcome">Outcome</option><option value="administrative">Administrative</option><option value="referral">Referral</option></select></label>
          <label className="block text-[11px] font-medium text-slateink-500">Introduction<textarea value={builder.description} onChange={(event) => setBuilder((current) => ({ ...current, description: event.target.value }))} className="mt-1.5 min-h-20 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label>
          <div className="space-y-3">{builder.fields.map((item, index) => <div key={item.id} className="rounded-xl border border-slate-900/[0.07] bg-slate-900/[0.015] p-3"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Field {index + 1}</span>{builder.fields.length > 1 && <button onClick={() => setBuilder((current) => ({ ...current, fields: current.fields.filter((row) => row.id !== item.id) }))} className="text-[10px] font-medium text-red-600">Remove</button>}</div><input value={item.label} onChange={(event) => setBuilder((current) => ({ ...current, fields: current.fields.map((row) => row.id === item.id ? { ...row, label: event.target.value, key: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || row.key } : row) }))} placeholder="Question label" className="mt-2 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[12px]" /><div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><select value={item.type} onChange={(event) => setBuilder((current) => ({ ...current, fields: current.fields.map((row) => row.id === item.id ? { ...row, type: event.target.value as FormFieldType, updateTarget: '' } : row) }))} className="rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]">{FIELD_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select><label className="flex items-center gap-2 rounded-lg border border-slate-900/[0.08] px-2.5 text-[11px]"><input type="checkbox" checked={item.required} onChange={(event) => setBuilder((current) => ({ ...current, fields: current.fields.map((row) => row.id === item.id ? { ...row, required: event.target.checked } : row) }))} /> Required</label></div><label className="mt-2 block text-[10.5px] font-medium text-slateink-400">Reviewable patient update<select value={item.updateTarget} onChange={(event) => setBuilder((current) => ({ ...current, fields: current.fields.map((row) => row.id === item.id ? { ...row, updateTarget: event.target.value } : row) }))} className="mt-1 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]"><option value="">Do not map</option>{['text', 'long_text'].includes(item.type) && <><option value="name">Patient name</option><option value="email">Email</option><option value="phone">Phone</option><option value="address">Address</option></>}{customFields.filter((customField) => canMapToCustomField(item.type, customField.valueType)).map((customField) => <option key={customField.id} value={`custom:${customField.key}`}>{customField.label} (custom)</option>)}</select><span className="mt-1 block font-normal">Submissions only create a suggestion; staff must accept it.</span></label>{['single_choice', 'multiple_choice'].includes(item.type) && <textarea value={item.options} onChange={(event) => setBuilder((current) => ({ ...current, fields: current.fields.map((row) => row.id === item.id ? { ...row, options: event.target.value } : row) }))} placeholder={'Option one\nOption two'} className="mt-2 min-h-20 w-full rounded-lg border border-slate-900/[0.08] px-2.5 py-2 text-[11px]" />}</div>)}</div>
          <Button variant="ghost" size="sm" onClick={() => setBuilder((current) => ({ ...current, fields: [...current.fields, field(current.fields.length + 1)] }))}><Icons.plus size={13} /> Add field</Button><Button className="w-full" size="sm" disabled={busy || !builder.name.trim() || builder.fields.some((item) => !item.label.trim())} onClick={() => void createTemplate()}>{busy ? 'Creating…' : 'Create draft template'}</Button>
        </div></section>
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Template library</h2><p className="mt-1 text-[11.5px] text-slateink-400">Published assignments keep their exact template version even after a new draft is made.</p></div><div className="divide-y divide-slate-900/[0.05]">{templates.map((row) => <article key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-[13px] font-semibold">{row.name}</h3><Pill tone={tone(row.state)}>{row.state}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{row.id} · {row.category} · version {row.currentVersion}</p></div>{row.state !== 'published' && row.state !== 'archived' && <Button size="sm" disabled={busy} onClick={() => void stateTemplate(row, 'publish')}>Publish</Button>}{row.state !== 'archived' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void stateTemplate(row, 'archive')}>Archive</Button>}</article>)}{!loading && !templates.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No templates yet.</p>}</div></section>
    </div>}

    {tab === 'assignments' && <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)] xl:items-start"><section className="panel p-5"><h2 className="text-[15px] font-semibold">Assign a secure form</h2><div className="mt-4 space-y-3"><label className="block text-[11px] font-medium text-slateink-500">Published template<select value={assignment.templateId} onChange={(event) => setAssignment((current) => ({ ...current, templateId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="">Choose…</option>{templates.filter((row) => row.state === 'published').map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label className="block text-[11px] font-medium text-slateink-500">Patient ID<input value={assignment.clientId} onChange={(event) => setAssignment((current) => ({ ...current, clientId: event.target.value }))} placeholder="cli_…" className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[12px]" /></label><label className="flex items-center gap-2 text-[11px] font-medium"><input type="checkbox" checked={assignment.send} onChange={(event) => setAssignment((current) => ({ ...current, send: event.target.checked }))} /> Send through the message queue now</label>{assignment.send && <><label className="block text-[11px] font-medium text-slateink-500">Channel<select value={assignment.channel} onChange={(event) => setAssignment((current) => ({ ...current, channel: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="email">Email</option><option value="sms">SMS</option></select></label><label className="block text-[11px] font-medium text-slateink-500">Override destination <span className="font-normal text-slateink-300">optional</span><input value={assignment.to} onChange={(event) => setAssignment((current) => ({ ...current, to: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label></>}<Button className="w-full" size="sm" disabled={busy || !assignment.templateId || !assignment.clientId} onClick={() => void assign()}>{busy ? 'Creating…' : assignment.send ? 'Create & queue link' : 'Create & copy link'}</Button></div></section><section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Assignments</h2><p className="mt-1 text-[11.5px] text-slateink-400">Bearer tokens are never listed or stored in plaintext.</p></div><div className="divide-y divide-slate-900/[0.05]">{assignments.map((row) => <article key={row.id} className="flex items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><div className="flex gap-2"><p className="truncate text-[12.5px] font-semibold">{templates.find((template) => template.id === row.templateId)?.name ?? row.templateId}</p><Pill tone={tone(row.status)}>{row.status.replace('_', ' ')}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{row.id} · patient {row.clientId ?? 'unlinked'} · v{row.templateVersion}</p><p className="mt-1 text-[10.5px] text-slateink-400">Expires {new Date(row.expiresAt).toLocaleString('en-GB')}</p></div></article>)}{!loading && !assignments.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No form assignments yet.</p>}</div></section></div>}

    {tab === 'responses' && <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_440px] xl:items-start"><section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Submission inbox</h2><p className="mt-1 text-[11.5px] text-slateink-400">Answers are loaded only when an authorised reviewer opens one response.</p></div><div className="divide-y divide-slate-900/[0.05]">{responses.map((row) => <button key={row.id} onClick={() => void openResponse(row)} className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-900/[0.02]"><div className="min-w-0 flex-1"><div className="flex gap-2"><p className="truncate text-[12.5px] font-semibold">{templates.find((template) => template.id === row.templateId)?.name ?? row.templateId}</p><Pill tone={tone(row.status)}>{row.status.replace('_', ' ')}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{row.id} · patient {row.clientId ?? 'unlinked'} · respondent {row.respondent.relationship}</p></div><Icons.chevronRight size={14} /></button>)}{!loading && !responses.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No saved or submitted responses.</p>}</div></section><aside className="panel p-5 xl:sticky xl:top-6"><h2 className="text-[15px] font-semibold">Review</h2>{!detail ? <p className="mt-3 text-[12px] leading-relaxed text-slateink-400">Select a response to inspect its immutable answer version and any proposed patient-record changes.</p> : <div className="mt-4 space-y-4"><div><Pill tone={tone(detail.response.status)}>{detail.response.status}</Pill><p className="mt-2 font-mono text-[10px] text-slateink-400">{detail.response.id}</p></div><dl className="space-y-3">{Object.entries(detail.version?.answers ?? {}).map(([key, value]) => <div key={key} className="rounded-xl bg-slate-900/[0.025] p-3"><dt className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">{key.replaceAll('_', ' ')}</dt><dd className="mt-1 whitespace-pre-wrap text-[12px] text-slate-800">{Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value)}</dd></div>)}</dl>{detail.suggestions.length > 0 && <div><h3 className="text-[12px] font-semibold">Patient record suggestions</h3><div className="mt-2 space-y-2">{detail.suggestions.map((suggestion) => <div key={suggestion.id} className="rounded-xl border border-slate-900/[0.07] p-3"><p className="text-[11px] font-medium">{suggestion.target}: {suggestion.oldValue || 'empty'} → {suggestion.proposedValue}</p>{suggestion.status === 'pending' && <div className="mt-2 flex gap-2"><Button size="sm" disabled={busy} onClick={() => void decideSuggestion(suggestion, true)}>Accept</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void decideSuggestion(suggestion, false)}>Reject</Button></div>}</div>)}</div></div>}{detail.response.status === 'submitted' && <Button className="w-full" size="sm" disabled={busy} onClick={() => void reviewResponse()}>Mark reviewed</Button>}</div>}</aside></div>}
  </div>;
}
