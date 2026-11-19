'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { visibleFormFields, type FormAnswers, type FormField, type FormSchema } from '@/lib/forms-schema';

type PublicPayload = {
  form: FormSchema;
  assignment: { id: string; status: string; expiresAt: string };
  response?: { status: string; respondent?: { relationship: 'self' | 'guardian' | 'proxy' | 'referrer'; name?: string }; answers?: FormAnswers };
};

type ApiError = { error?: { message?: string } };
const syntheticHeaders = { 'x-voxera-synthetic-data': '1' };

function isAnswered(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '' && value !== false;
}

function FieldControl({ field, value, onChange, disabled, onUpload }: {
  field: FormField; value: unknown; onChange: (value: unknown) => void; disabled: boolean;
  onUpload: (field: FormField, file: File) => Promise<void>;
}) {
  const id = `form-${field.id}`;
  if (field.type === 'display') return <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">{field.displayText}</div>;
  const common = 'mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-[16px] text-slate-950 outline-none transition focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-100';
  if (field.type === 'long_text') return <textarea id={id} className={`${common} min-h-32 resize-y`} value={String(value ?? '')} placeholder={field.placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  if (field.type === 'number' || field.type === 'date' || field.type === 'text') return <input id={id} className={common} type={field.type === 'text' ? 'text' : field.type} value={String(value ?? '')} placeholder={field.placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  if (field.type === 'single_choice') return <div className="mt-3 grid gap-2">{field.options?.map((option) => <label key={option.value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="radio" name={id} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} className="h-4 w-4 accent-indigo-600" /><span>{option.label}</span></label>)}</div>;
  if (field.type === 'multiple_choice') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return <div className="mt-3 grid gap-2">{field.options?.map((option) => <label key={option.value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="checkbox" checked={selected.includes(option.value)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} className="h-4 w-4 rounded accent-indigo-600" /><span>{option.label}</span></label>)}</div>;
  }
  if (field.type === 'yes_no') return <div className="mt-3 flex gap-3">{[['Yes', true], ['No', false]].map(([label, option]) => <label key={String(option)} className="flex min-w-28 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="radio" name={id} checked={value === option} disabled={disabled} onChange={() => onChange(option)} className="h-4 w-4 accent-indigo-600" /><span>{String(label)}</span></label>)}</div>;
  if (field.type === 'acknowledgement') return <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50"><input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 rounded accent-indigo-600" /><span>I acknowledge this statement</span></label>;
  if (field.type === 'file') {
    const files = Array.isArray(value) ? value.map(String) : [];
    return <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-4"><input id={id} type="file" disabled={disabled || files.length >= 10} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(field, file); event.currentTarget.value = ''; }} /><p className="mt-2 text-xs text-slate-500">PDF, image, text or Office file · up to 10 MB · scanned before staff can open it</p>{files.length > 0 && <p className="mt-2 text-sm font-medium text-emerald-700">{files.length} secure file{files.length === 1 ? '' : 's'} attached</p>}</div>;
  }
  return null;
}

export function PublicForm({ token }: { token: string }) {
  const [payload, setPayload] = useState<PublicPayload>();
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [respondent, setRespondent] = useState<{ relationship: 'self' | 'guardian' | 'proxy' | 'referrer'; name?: string }>({ relationship: 'self' });
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'submitting' | 'complete' | 'unavailable'>('loading');
  const [message, setMessage] = useState('');
  const changed = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/public/forms/${encodeURIComponent(token)}`, { cache: 'no-store' });
      const body = await response.json() as PublicPayload & ApiError;
      if (!response.ok) throw new Error(body.error?.message ?? 'This form is unavailable.');
      setPayload(body);
      setAnswers(body.response?.answers ?? {});
      if (body.response?.respondent) setRespondent(body.response.respondent);
      if (body.response?.status === 'submitted' || body.assignment.status === 'submitted') setState('complete');
      else setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'This form is unavailable.');
      setState('unavailable');
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (nextAnswers: FormAnswers, submit = false) => {
    if (!payload) return false;
    setState(submit ? 'submitting' : 'saving');
    setMessage('');
    try {
      const response = await fetch(`/api/public/forms/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...syntheticHeaders },
        body: JSON.stringify({ answers: nextAnswers, submit, respondent }),
      });
      const body = await response.json() as { status?: string; completionMessage?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? 'Your form could not be saved.');
      changed.current = false;
      if (submit) {
        setMessage(body.completionMessage ?? payload.form.completionMessage ?? 'Thank you. Your response has been received.');
        setState('complete');
      } else {
        setMessage('Saved securely');
        setState('ready');
      }
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your form could not be saved.');
      setState('ready');
      return false;
    }
  }, [payload, respondent, token]);

  useEffect(() => {
    if (!payload || !changed.current || state === 'submitting') return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save(answers, false); }, 1_200);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [answers, payload, save, state]);

  const fields = useMemo(() => payload ? visibleFormFields(payload.form, answers) : [], [answers, payload]);
  const required = fields.filter((field) => field.required && field.type !== 'display');
  const completed = required.filter((field) => isAnswered(answers[field.key])).length;
  const progress = required.length ? Math.round(completed / required.length * 100) : 100;

  const change = (field: FormField, value: unknown) => {
    changed.current = true;
    setAnswers((current) => ({ ...current, [field.key]: value }));
    setMessage('');
  };

  const upload = async (field: FormField, file: File) => {
    if (file.size > 10 * 1024 * 1024) { setMessage('That file is larger than 10 MB.'); return; }
    setState('saving');
    setMessage(`Uploading ${file.name}…`);
    try {
      const response = await fetch(`/api/public/forms/${encodeURIComponent(token)}/uploads`, {
        method: 'PUT', body: file,
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-voxera-file-name': encodeURIComponent(file.name), 'x-voxera-form-field': field.key, ...syntheticHeaders },
      });
      const body = await response.json() as { documentId?: string; error?: { message?: string } };
      if (!response.ok || !body.documentId) throw new Error(body.error?.message ?? 'The file could not be uploaded.');
      const next = { ...answers, [field.key]: [...(Array.isArray(answers[field.key]) ? answers[field.key] as unknown[] : []), body.documentId] };
      setAnswers(next);
      changed.current = true;
      await save(next, false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The file could not be uploaded.');
      setState('ready');
    }
  };

  if (state === 'loading') return <main className="min-h-screen bg-slate-50 px-4 py-16"><div className="mx-auto max-w-2xl animate-pulse rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"><div className="h-5 w-28 rounded bg-slate-200" /><div className="mt-6 h-9 w-3/4 rounded bg-slate-200" /><div className="mt-8 h-32 rounded bg-slate-100" /></div></main>;
  if (state === 'unavailable' || !payload) return <main className="grid min-h-screen place-items-center bg-slate-50 px-4"><section className="max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><p className="text-sm font-bold uppercase tracking-widest text-indigo-600">Voxera secure forms</p><h1 className="mt-3 text-2xl font-bold text-slate-950">This form is unavailable</h1><p className="mt-3 text-slate-600">{message}</p><p className="mt-5 text-sm text-slate-500">Please contact the practice that sent you the link.</p></section></main>;
  if (state === 'complete') return <main className="grid min-h-screen place-items-center bg-slate-50 px-4"><section className="max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 text-center shadow-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div><h1 className="mt-5 text-2xl font-bold text-slate-950">Form received</h1><p className="mt-3 leading-7 text-slate-600">{message || payload.form.completionMessage}</p><p className="mt-5 text-sm text-slate-500">You can close this window. Do not send urgent medical information through this form.</p></section></main>;

  return <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
    <div className="mx-auto max-w-2xl">
      <header className="mb-5 flex items-center justify-between gap-4 px-1"><div><p className="text-sm font-extrabold tracking-tight text-indigo-700">VOXERA</p><p className="text-xs text-slate-500">Secure form</p></div><div className="text-right text-xs text-slate-500"><p>Encrypted in transit</p><p>Expires {new Date(payload.assignment.expiresAt).toLocaleDateString('en-GB')}</p></div></header>
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-6 sm:p-8"><h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{payload.form.title}</h1>{payload.form.description && <p className="mt-3 leading-7 text-slate-600">{payload.form.description}</p>}{payload.form.emergencyNotice && <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium leading-6 text-amber-950">{payload.form.emergencyNotice}</div>}<div className="mt-6"><div className="mb-2 flex justify-between text-xs font-medium text-slate-600"><span>Required fields</span><span>{completed} of {required.length}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} /></div></div></div>
        <form className="grid gap-7 p-6 sm:p-8" onSubmit={(event) => { event.preventDefault(); if (saveTimer.current) clearTimeout(saveTimer.current); void save(answers, true); }}>
          <fieldset disabled={state === 'submitting'} className="grid gap-7">
            <div className="rounded-2xl bg-slate-50 p-4"><label htmlFor="respondent" className="text-sm font-semibold text-slate-900">Who is completing this form?</label><select id="respondent" value={respondent.relationship} onChange={(event) => { changed.current = true; setRespondent({ relationship: event.target.value as typeof respondent.relationship }); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base"><option value="self">The patient</option><option value="guardian">Parent or guardian</option><option value="proxy">Someone supporting the patient</option><option value="referrer">The referrer</option></select>{respondent.relationship !== 'self' && <input aria-label="Your name" value={respondent.name ?? ''} onChange={(event) => { changed.current = true; setRespondent((current) => ({ ...current, name: event.target.value })); }} placeholder="Your full name" className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base" />}</div>
            {fields.map((field) => <div key={field.id}>{field.type !== 'display' && <label htmlFor={`form-${field.id}`} className="block text-[15px] font-semibold text-slate-950">{field.label}{field.required && <span className="ml-1 text-rose-600" aria-label="required">*</span>}</label>}{field.help && <p className="mt-1 text-sm leading-6 text-slate-500">{field.help}</p>}<FieldControl field={field} value={answers[field.key]} onChange={(value) => change(field, value)} disabled={state === 'submitting'} onUpload={upload} /></div>)}
          </fieldset>
          {message && <p role="status" className={`rounded-xl p-3 text-sm ${message.toLowerCase().includes('saved') ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{message}</p>}
          <div className="sticky bottom-3 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur"><button type="submit" disabled={state === 'submitting' || state === 'saving'} className="w-full rounded-xl bg-indigo-700 px-5 py-3.5 font-bold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-slate-400">{state === 'submitting' ? 'Submitting securely…' : payload.form.submitLabel ?? 'Submit securely'}</button><p className="mt-2 text-center text-xs text-slate-500">Drafts save automatically. Staff review changes before any patient details are updated.</p></div>
        </form>
      </section>
      <footer className="px-4 py-6 text-center text-xs leading-5 text-slate-500">Do not use this form for emergencies. Contact emergency services or your care team using their published number.</footer>
    </div>
  </main>;
}
