'use client';

import * as React from 'react';
import { PageHeader } from '@/components/dash/Shell';
import { Button, Pill } from '@/components/ui';
import { Icons } from '@/components/icons';

type Template = { id: string; name: string; category: string; state: 'draft' | 'published' | 'archived'; currentVersion: number; publishedVersion?: number; requiresApproval: boolean; revision: number };
type Letter = { id: string; templateId: string; templateVersion: number; clientId?: string; referralId?: string; bookingId?: string; status: 'draft' | 'awaiting_approval' | 'approved' | 'finalised' | 'queued' | 'sent' | 'failed' | 'cancelled' | 'corrected'; currentVersion: number; requiresApproval: boolean; snapshot: { recipient: { name: string; email?: string }; patient?: { name: string } }; artifactHash?: string; finalisedAt?: string; correctsLetterId?: string; correctedByLetterId?: string; correctionReason?: string; revision: number; createdAt?: string; updatedAt?: string };
type Version = { subject: string; body: string; footer?: string; contentHash: string; version: number };
type LetterDetail = { letter: Letter; version: Version };
const clinicalHeaders = { 'x-voxera-synthetic-data': '1' };

export default function LettersPage() {
  const [tab, setTab] = React.useState<'letters' | 'templates'>('letters');
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [letters, setLetters] = React.useState<Letter[]>([]);
  const [detail, setDetail] = React.useState<LetterDetail>();
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [templateDraft, setTemplateDraft] = React.useState({ name: '', category: 'clinical', subject: 'Regarding {{patient.name}}', body: 'Dear {{recipient.name}},\n\nThank you for your recent contact with {{practice.name}}.\n\nYours sincerely,\n{{author.name}}', footer: '{{practice.name}}', requiresApproval: true });
  const [draft, setDraft] = React.useState({ templateId: '', clientId: '', referralId: '', bookingId: '', recipientName: '', recipientEmail: '' });
  const [edit, setEdit] = React.useState({ subject: '', body: '', footer: '' });
  const [sendTo, setSendTo] = React.useState('');
  const [correctionReason, setCorrectionReason] = React.useState('');

  const api = React.useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? 'The request failed.');
    return body;
  }, []);
  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [templateBody, letterBody] = await Promise.all([api('/api/v1/letters/templates'), api('/api/v1/letters')]);
      setTemplates(templateBody.data ?? []); setLetters(letterBody.data ?? []);
      setDraft((current) => ({ ...current, templateId: current.templateId || templateBody.data?.find((row: Template) => row.state === 'published')?.id || '' }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Letters could not be loaded.'); }
    finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => { void load(); }, [load]);

  const createTemplate = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api('/api/v1/letters/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(templateDraft) });
      setNotice(`Draft template “${body.template.name}” created. Publish it after checking merge fields.`); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Template creation failed.'); }
    finally { setBusy(false); }
  };
  const setTemplateState = async (row: Template, action: 'publish' | 'archive') => {
    setBusy(true); setError('');
    try { await api(`/api/v1/letters/templates/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedRevision: row.revision }) }); setNotice(action === 'publish' ? 'Template published.' : 'Template archived; existing letters keep their snapshot.'); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Template update failed.'); }
    finally { setBusy(false); }
  };
  const createLetter = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = await api('/api/v1/letters', { method: 'POST', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ templateId: draft.templateId, clientId: draft.clientId || undefined, referralId: draft.referralId || undefined, bookingId: draft.bookingId || undefined, recipient: draft.recipientName ? { name: draft.recipientName, email: draft.recipientEmail || undefined } : undefined }) });
      setNotice('Letter created from a point-in-time data snapshot. Later patient edits will not silently change it.'); setDraft((current) => ({ ...current, clientId: '', referralId: '', bookingId: '', recipientName: '', recipientEmail: '' })); await load(); await open(body.letter.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Letter creation failed.'); }
    finally { setBusy(false); }
  };
  const open = React.useCallback(async (id: string) => {
    setBusy(true); setError('');
    try { const body = await api(`/api/v1/letters/${id}`); setDetail(body); setEdit({ subject: body.version.subject, body: body.version.body, footer: body.version.footer ?? '' }); setSendTo(body.letter.snapshot.recipient.email ?? ''); setCorrectionReason(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Letter could not be opened.'); }
    finally { setBusy(false); }
  }, [api]);
  const patch = async (body: Record<string, unknown>, success: string) => {
    if (!detail) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/v1/letters/${detail.letter.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...clinicalHeaders }, body: JSON.stringify({ expectedRevision: detail.letter.revision, ...body }) });
      setNotice(success); await load(); await open(detail.letter.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Letter update failed.'); }
    finally { setBusy(false); }
  };
  const revise = () => patch({ action: 'revise', ...edit }, 'A new immutable draft version was saved.');
  const action = (name: 'submit' | 'approve' | 'finalise' | 'cancel') => patch({ action: name }, name === 'finalise' ? 'Letter finalised. Its PDF and evidence hash are now fixed.' : `Letter ${name === 'submit' ? 'submitted for approval' : `${name}d`}.`);
  const email = () => patch({ action: 'email', to: sendTo || undefined }, 'Finalised correspondence queued through the controlled message path.');
  const correct = async () => {
    if (!detail) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(`/api/v1/letters/${detail.letter.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...clinicalHeaders },
        body: JSON.stringify({ action: 'correct', expectedRevision: detail.letter.revision, reason: correctionReason }),
      });
      setNotice('Linked correction draft created. The original final evidence remains downloadable and is marked corrected.');
      await load(); await open(result.letter.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Correction draft could not be created.'); }
    finally { setBusy(false); }
  };
  const tone = (status: string): 'default' | 'brand' | 'warn' | 'danger' => ['approved', 'finalised', 'sent'].includes(status) ? 'brand' : ['awaiting_approval', 'queued', 'corrected'].includes(status) ? 'warn' : ['failed', 'cancelled', 'archived'].includes(status) ? 'danger' : 'default';

  return <div className="space-y-6">
    <PageHeader title="Letters" desc="Compose from approved merge templates, freeze source data into a snapshot, approve, finalise a deterministic PDF and queue delivery with evidence." />
    <section className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-amber-900">Synthetic-test mode is acknowledged by this screen. Finalisation proves content integrity inside Voxera; it is not a clinical signature or external delivery confirmation.</section>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-700">{error}</div>}{notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[12px] text-emerald-800">{notice}</div>}
    <div className="flex gap-2" role="tablist"><button role="tab" aria-selected={tab === 'letters'} onClick={() => setTab('letters')} className={`rounded-xl px-4 py-2 text-[12px] font-semibold ${tab === 'letters' ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.08]'}`}>Letters {letters.length}</button><button role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')} className={`rounded-xl px-4 py-2 text-[12px] font-semibold ${tab === 'templates' ? 'bg-slate-900 text-white' : 'border border-slate-900/[0.08]'}`}>Templates {templates.length}</button></div>

    {tab === 'templates' && <div className="grid gap-5 xl:grid-cols-[430px_minmax(0,1fr)] xl:items-start"><section className="panel p-5"><h2 className="text-[15px] font-semibold">New merge template</h2><p className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">Safe fields include patient, referral, appointment, practice, author and recipient. Unknown fields are rejected server-side.</p><div className="mt-4 space-y-3"><label className="block text-[11px] font-medium text-slateink-500">Name<input value={templateDraft.name} onChange={(event) => setTemplateDraft((row) => ({ ...row, name: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="block text-[11px] font-medium text-slateink-500">Category<select value={templateDraft.category} onChange={(event) => setTemplateDraft((row) => ({ ...row, category: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="clinical">Clinical</option><option value="referral">Referral</option><option value="administrative">Administrative</option><option value="finance">Finance</option></select></label><label className="block text-[11px] font-medium text-slateink-500">Subject<input value={templateDraft.subject} onChange={(event) => setTemplateDraft((row) => ({ ...row, subject: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px]" /></label><label className="block text-[11px] font-medium text-slateink-500">Body<textarea value={templateDraft.body} onChange={(event) => setTemplateDraft((row) => ({ ...row, body: event.target.value }))} className="mt-1.5 min-h-56 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px] leading-relaxed" /></label><label className="block text-[11px] font-medium text-slateink-500">Footer<input value={templateDraft.footer} onChange={(event) => setTemplateDraft((row) => ({ ...row, footer: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px]" /></label><label className="flex items-center gap-2 text-[11px] font-medium"><input type="checkbox" checked={templateDraft.requiresApproval} onChange={(event) => setTemplateDraft((row) => ({ ...row, requiresApproval: event.target.checked }))} /> Require a separate approval step</label><Button className="w-full" size="sm" disabled={busy || !templateDraft.name.trim()} onClick={() => void createTemplate()}>Create draft template</Button></div></section><section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Template library</h2></div><div className="divide-y divide-slate-900/[0.05]">{templates.map((row) => <article key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><div className="flex gap-2"><p className="truncate text-[13px] font-semibold">{row.name}</p><Pill tone={tone(row.state)}>{row.state}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{row.id} · {row.category} · version {row.currentVersion} · {row.requiresApproval ? 'approval required' : 'author finalises'}</p></div>{row.state === 'draft' && <Button size="sm" disabled={busy} onClick={() => void setTemplateState(row, 'publish')}>Publish</Button>}{row.state !== 'archived' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void setTemplateState(row, 'archive')}>Archive</Button>}</article>)}{!loading && !templates.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No letter templates yet.</p>}</div></section></div>}

    {tab === 'letters' && <div className="grid gap-5 xl:grid-cols-[340px_minmax(360px,0.8fr)_minmax(420px,1.2fr)] xl:items-start"><section className="panel p-5"><h2 className="text-[15px] font-semibold">Compose from snapshot</h2><p className="mt-1 text-[11.5px] leading-relaxed text-slateink-400">Link a patient, referral or appointment. At least one linked record or an explicit recipient is required by the template data.</p><div className="mt-4 space-y-3"><label className="block text-[11px] font-medium text-slateink-500">Published template<select value={draft.templateId} onChange={(event) => setDraft((row) => ({ ...row, templateId: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]"><option value="">Choose…</option>{templates.filter((row) => row.state === 'published').map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{[['clientId', 'Patient ID', 'cli_…'], ['referralId', 'Referral ID', 'ref_…'], ['bookingId', 'Appointment ID', 'bkg_…']] .map(([key, label, placeholder]) => <label key={key} className="block text-[11px] font-medium text-slateink-500">{label}<input value={draft[key as keyof typeof draft] as string} onChange={(event) => setDraft((row) => ({ ...row, [key]: event.target.value }))} placeholder={placeholder} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 font-mono text-[11px]" /></label>)}<label className="block text-[11px] font-medium text-slateink-500">Recipient name <span className="font-normal text-slateink-300">optional override</span><input value={draft.recipientName} onChange={(event) => setDraft((row) => ({ ...row, recipientName: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="block text-[11px] font-medium text-slateink-500">Recipient email<input value={draft.recipientEmail} onChange={(event) => setDraft((row) => ({ ...row, recipientEmail: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><Button className="w-full" size="sm" disabled={busy || !draft.templateId || (!draft.clientId && !draft.referralId && !draft.recipientName)} onClick={() => void createLetter()}>Create letter</Button></div></section>
      <section className="panel overflow-hidden"><div className="border-b border-slate-900/[0.05] px-5 py-4"><h2 className="text-[15px] font-semibold">Correspondence queue</h2></div><div className="divide-y divide-slate-900/[0.05]">{letters.map((row) => <button key={row.id} onClick={() => void open(row.id)} className={`flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-900/[0.02] ${detail?.letter.id === row.id ? 'bg-brand-500/[0.045]' : ''}`}><div className="min-w-0 flex-1"><div className="flex gap-2"><p className="truncate text-[12.5px] font-semibold">{row.snapshot.recipient.name}</p><Pill tone={tone(row.status)}>{row.status.replace('_', ' ')}</Pill></div><p className="mt-1 truncate text-[11px] text-slateink-400">{row.snapshot.patient?.name || row.snapshot.recipient.email || 'Unlinked recipient'}</p><p className="mt-1 font-mono text-[10px] text-slateink-300">{row.id} · v{row.currentVersion}</p></div><Icons.chevronRight size={14} /></button>)}{!loading && !letters.length && <p className="px-5 py-12 text-center text-[12px] text-slateink-400">No letters yet.</p>}</div></section>
      <section className="panel min-h-[520px] p-5 xl:sticky xl:top-6">{!detail ? <div className="grid min-h-[460px] place-items-center text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-900/[0.04]"><Icons.book size={20} /></span><h2 className="mt-4 text-[15px] font-semibold">Select a letter</h2><p className="mt-2 max-w-sm text-[12px] leading-relaxed text-slateink-400">Draft content is editable. Finalised content is immutable and downloadable with its evidence hash.</p></div></div> : <div className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex gap-2"><h2 className="text-[17px] font-semibold">{detail.letter.snapshot.recipient.name}</h2><Pill tone={tone(detail.letter.status)}>{detail.letter.status.replace('_', ' ')}</Pill></div><p className="mt-1 font-mono text-[10px] text-slateink-400">{detail.letter.id} · template v{detail.letter.templateVersion} · draft v{detail.version.version}</p></div>{detail.letter.artifactHash && <a href={`/api/v1/letters/${detail.letter.id}/pdf`} className="btn-ghost btn-sm"><Icons.download size={13} /> PDF</a>}</div>
        {detail.letter.status === 'draft' ? <><label className="block text-[11px] font-medium text-slateink-500">Subject<input value={edit.subject} onChange={(event) => setEdit((row) => ({ ...row, subject: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px]" /></label><label className="block text-[11px] font-medium text-slateink-500">Body<textarea value={edit.body} onChange={(event) => setEdit((row) => ({ ...row, body: event.target.value }))} className="mt-1.5 min-h-64 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[12px] leading-relaxed" /></label><label className="block text-[11px] font-medium text-slateink-500">Footer<input value={edit.footer} onChange={(event) => setEdit((row) => ({ ...row, footer: event.target.value }))} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] px-3 py-2 text-[11px]" /></label><div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void revise()}>Save new version</Button><Button size="sm" disabled={busy} onClick={() => void action('submit')}>{detail.letter.requiresApproval ? 'Submit for approval' : 'Ready to finalise'}</Button><Button variant="danger" size="sm" disabled={busy} onClick={() => void action('cancel')}>Cancel</Button></div></> : <div className="rounded-xl bg-slate-900/[0.02] p-4"><h3 className="text-[14px] font-semibold">{detail.version.subject}</h3><div className="mt-4 whitespace-pre-wrap text-[12px] leading-6 text-slate-700">{detail.version.body}</div>{detail.version.footer && <p className="mt-6 border-t border-slate-200 pt-3 text-[10.5px] text-slateink-400">{detail.version.footer}</p>}</div>}
        {detail.letter.status === 'awaiting_approval' && <Button className="w-full" size="sm" disabled={busy} onClick={() => void action('approve')}>Approve this exact version</Button>}{detail.letter.status === 'approved' && <Button className="w-full" size="sm" disabled={busy} onClick={() => void action('finalise')}>Finalise & generate PDF</Button>}{detail.letter.artifactHash && <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.04] p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Immutable artifact evidence</p><p className="mt-1 break-all font-mono text-[9.5px] text-slate-600">{detail.letter.artifactHash}</p></div>}{detail.letter.status === 'finalised' && <div className="rounded-xl border border-slate-900/[0.07] p-3"><label className="block text-[11px] font-medium text-slateink-500">Email destination<input value={sendTo} onChange={(event) => setSendTo(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-900/[0.08] bg-white px-3 py-2 text-[12px]" /></label><Button className="mt-2 w-full" size="sm" disabled={busy || !sendTo.trim()} onClick={() => void email()}>Queue controlled email</Button></div>}
        {detail.letter.correctsLetterId && <div className="rounded-xl border border-slate-900/[0.07] p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-slateink-300">Correction chain</p><p className="mt-1 text-[11px] text-slate-600">Corrects <span className="font-mono">{detail.letter.correctsLetterId}</span></p><p className="mt-1 text-[10.5px] text-slateink-400">{detail.letter.correctionReason}</p></div>}
        {detail.letter.correctedByLetterId && <div className="rounded-xl border border-amber-300/50 bg-amber-50 p-3"><p className="text-[11px] font-semibold text-amber-950">Superseded by linked correction</p><button className="mt-1 font-mono text-[10px] text-amber-800 underline" onClick={() => void open(detail.letter.correctedByLetterId!)}>{detail.letter.correctedByLetterId}</button></div>}
        {['finalised', 'sent', 'failed'].includes(detail.letter.status) && !detail.letter.correctedByLetterId && <div className="rounded-xl border border-amber-300/50 bg-amber-50/70 p-3"><h3 className="text-[11px] font-semibold text-amber-950">Create a correction</h3><p className="mt-1 text-[10.5px] leading-relaxed text-amber-800">Final evidence is never edited. This creates a linked draft and marks this exact artifact as corrected.</p><textarea value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="Why is a correction required?" className="mt-2 min-h-20 w-full rounded-xl border border-amber-300 bg-white px-3 py-2 text-[11px]" /><Button variant="ghost" className="mt-2 w-full" size="sm" disabled={busy || correctionReason.trim().length < 10} onClick={() => void correct()}>Create linked correction draft</Button></div>}
      </div>}</section>
    </div>}
  </div>;
}
