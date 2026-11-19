'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { visibleFormFields, type FormAnswers, type FormField, type FormSchema } from '@/lib/forms-schema';

type ReferralPayload = {
  practice: { name: string };
  operatingMode: 'synthetic_test' | 'live';
  form: { id: string; name: string; privacyNotice: string; emergencyNotice: string; completionMessage: string };
  schema: FormSchema;
};
type ApiError = { error?: { message?: string } };
type DraftSession = { token: string; expiresAt: string };
const syntheticHeaders = { 'x-voxera-synthetic-data': '1' };
const storageKey = (slug: string) => `voxera:public-referral:${slug}`;

function answered(field: FormField, value: unknown) {
  if (field.type === 'acknowledgement') return value === true;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

function ReferralField({ field, value, disabled, onChange, onUpload }: {
  field: FormField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
  onUpload: (field: FormField, file: File) => Promise<void>;
}) {
  const id = `referral-${field.id}`;
  const input = 'mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-[16px] text-slate-950 outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-100 disabled:bg-slate-100';
  if (field.type === 'display') return <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">{field.displayText}</div>;
  if (field.type === 'long_text') return <textarea id={id} className={`${input} min-h-32 resize-y`} value={String(value ?? '')} placeholder={field.placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  if (field.type === 'number' || field.type === 'date' || field.type === 'text') return <input id={id} className={input} type={field.type === 'text' ? 'text' : field.type} inputMode={field.type === 'number' ? 'decimal' : undefined} value={String(value ?? '')} placeholder={field.placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  if (field.type === 'single_choice') return <div className="mt-3 grid gap-2">{field.options?.map((option) => <label key={option.value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="radio" name={id} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} className="h-5 w-5 accent-teal-700" /><span>{option.label}</span></label>)}</div>;
  if (field.type === 'multiple_choice') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return <div className="mt-3 grid gap-2">{field.options?.map((option) => <label key={option.value} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="checkbox" checked={selected.includes(option.value)} disabled={disabled} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} className="h-5 w-5 rounded accent-teal-700" /><span>{option.label}</span></label>)}</div>;
  }
  if (field.type === 'yes_no') return <div className="mt-3 grid grid-cols-2 gap-3">{([['Yes', true], ['No', false]] as const).map(([label, option]) => <label key={label} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="radio" name={id} checked={value === option} disabled={disabled} onChange={() => onChange(option)} className="h-5 w-5 accent-teal-700" /><span>{label}</span></label>)}</div>;
  if (field.type === 'acknowledgement') return <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50"><input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 rounded accent-teal-700" /><span className="leading-6">I acknowledge and agree</span></label>;
  if (field.type === 'file') {
    const files = Array.isArray(value) ? value.map(String) : [];
    return <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-4"><input id={id} type="file" accept=".pdf,.jpg,.jpeg,.png,.txt,.docx" disabled={disabled || files.length >= 10} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-teal-50 file:px-3 file:py-2 file:font-semibold file:text-teal-800 hover:file:bg-teal-100" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(field, file); event.currentTarget.value = ''; }} /><p className="mt-2 text-xs leading-5 text-slate-500">PDF, JPEG, PNG, text or DOCX · up to 10 MB · held in quarantine until malware scanning reports it clean</p>{files.length > 0 && <p className="mt-2 text-sm font-medium text-emerald-700">{files.length} secure file{files.length === 1 ? '' : 's'} attached</p>}</div>;
  }
  return null;
}

export function PublicReferral({ slug }: { slug: string }) {
  const [payload, setPayload] = useState<ReferralPayload>();
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [draft, setDraft] = useState<DraftSession>();
  const [phase, setPhase] = useState<'loading' | 'intro' | 'starting' | 'ready' | 'submitting' | 'complete' | 'unavailable'>('loading');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState('');
  const [message, setMessage] = useState('');
  const [reference, setReference] = useState('');
  const changed = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveGeneration = useRef(0);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch(`/api/public/referrals/${encodeURIComponent(slug)}`, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', ...syntheticHeaders },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown> & ApiError;
    if (!response.ok) throw new Error(data.error?.message ?? 'The referral request could not be completed.');
    return data;
  }, [slug]);

  const resume = useCallback(async (stored: DraftSession) => {
    try {
      const data = await post({ action: 'resume', draftToken: stored.token });
      if (data.status === 'submitted') {
        sessionStorage.removeItem(storageKey(slug));
        setPhase('complete');
        return;
      }
      if (data.status !== 'draft') throw new Error('This saved referral is no longer available.');
      const next = { token: stored.token, expiresAt: String(data.expiresAt ?? stored.expiresAt) };
      setDraft(next);
      setAnswers(data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers) ? data.answers as FormAnswers : {});
      setPhase('ready');
    } catch {
      sessionStorage.removeItem(storageKey(slug));
      setDraft(undefined);
      setAnswers({});
      setPhase('intro');
      setMessage('Your previous draft could not be resumed. Start a new referral when you are ready.');
    }
  }, [post, slug]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/public/referrals/${encodeURIComponent(slug)}`, { cache: 'no-store' });
        const body = await response.json() as ReferralPayload & ApiError;
        if (!response.ok) throw new Error(body.error?.message ?? 'This referral form is unavailable.');
        if (!active) return;
        setPayload(body);
        let stored: DraftSession | undefined;
        try {
          const raw = sessionStorage.getItem(storageKey(slug));
          if (raw) stored = JSON.parse(raw) as DraftSession;
        } catch { sessionStorage.removeItem(storageKey(slug)); }
        if (stored?.token && Date.parse(stored.expiresAt) > Date.now()) await resume(stored);
        else { sessionStorage.removeItem(storageKey(slug)); setPhase('intro'); }
      } catch (error) {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : 'This referral form is unavailable.');
        setPhase('unavailable');
      }
    })();
    return () => { active = false; };
  }, [resume, slug]);

  const start = async () => {
    setPhase('starting'); setMessage('');
    try {
      const data = await post({ action: 'start' });
      const next = { token: String(data.draftToken), expiresAt: String(data.expiresAt) };
      sessionStorage.setItem(storageKey(slug), JSON.stringify(next));
      setDraft(next); setAnswers({}); setPhase('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A referral draft could not be started.');
      setPhase('intro');
    }
  };

  const save = useCallback(async (nextAnswers: FormAnswers, generation = saveGeneration.current) => {
    if (!draft || phase === 'submitting') return false;
    setSaving(true);
    try {
      await post({ action: 'save', draftToken: draft.token, answers: nextAnswers });
      if (generation === saveGeneration.current) {
        changed.current = false;
        setMessage('Draft saved securely');
      }
      return true;
    } catch (error) {
      if (generation === saveGeneration.current) setMessage(error instanceof Error ? error.message : 'Your draft could not be saved.');
      return false;
    } finally {
      if (generation === saveGeneration.current) setSaving(false);
    }
  }, [draft, phase, post]);

  useEffect(() => {
    if (!draft || !changed.current || phase !== 'ready' || uploading) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const generation = saveGeneration.current;
    saveTimer.current = setTimeout(() => { void save(answers, generation); }, 1_400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [answers, draft, phase, save, uploading]);

  const fields = useMemo(() => payload ? visibleFormFields(payload.schema, answers) : [], [answers, payload]);
  const required = fields.filter((field) => field.required && field.type !== 'display');
  const completed = required.filter((field) => answered(field, answers[field.key])).length;
  const progress = required.length ? Math.round(completed / required.length * 100) : 100;

  const change = (field: FormField, value: unknown) => {
    saveGeneration.current += 1;
    changed.current = true;
    setAnswers((current) => ({ ...current, [field.key]: value }));
    setMessage('');
  };

  const upload = async (field: FormField, file: File) => {
    if (!draft) return;
    if (file.size > 10 * 1024 * 1024) { setMessage('That file is larger than 10 MB.'); return; }
    if (!file.size) { setMessage('That file is empty.'); return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setUploading(field.key); setMessage(`Securing ${file.name}…`);
    try {
      const response = await fetch(`/api/public/referrals/${encodeURIComponent(slug)}/uploads`, {
        method: 'PUT', body: file,
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-voxera-file-name': encodeURIComponent(file.name),
          'x-voxera-form-field': field.key,
          'x-voxera-referral-draft': draft.token,
          ...syntheticHeaders,
        },
      });
      const body = await response.json() as { documentId?: string; error?: { message?: string } };
      if (!response.ok || !body.documentId) throw new Error(body.error?.message ?? 'The file could not be uploaded.');
      const current = Array.isArray(answers[field.key]) ? answers[field.key] as unknown[] : [];
      const next = { ...answers, [field.key]: [...current, body.documentId] };
      saveGeneration.current += 1;
      const generation = saveGeneration.current;
      changed.current = true;
      setAnswers(next);
      setUploading('');
      setMessage(`${file.name} is attached securely.`);
      await save(next, generation);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The file could not be uploaded.');
      setUploading('');
    }
  };

  const submit = async () => {
    if (!payload || !draft) return;
    const missing = required.find((field) => !answered(field, answers[field.key]));
    if (missing) {
      setMessage(`${missing.label} is required.`);
      document.getElementById(`referral-${missing.id}`)?.focus();
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveGeneration.current += 1;
    changed.current = false;
    setPhase('submitting'); setSaving(false); setMessage('');
    try {
      const data = await post({ action: 'submit', draftToken: draft.token, answers });
      sessionStorage.removeItem(storageKey(slug));
      setReference(String(data.reference ?? ''));
      setMessage(String(data.completionMessage ?? payload.form.completionMessage));
      setPhase('complete');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The referral could not be submitted.');
      setPhase('ready');
    }
  };

  if (phase === 'loading') return <main className="min-h-screen bg-slate-50 px-4 py-12"><div className="mx-auto max-w-2xl animate-pulse rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"><div className="h-5 w-32 rounded bg-slate-200" /><div className="mt-6 h-10 w-3/4 rounded bg-slate-200" /><div className="mt-8 h-40 rounded bg-slate-100" /></div></main>;
  if (phase === 'unavailable' || !payload) return <main className="grid min-h-screen place-items-center bg-slate-50 px-4"><section className="max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm"><p className="text-sm font-extrabold uppercase tracking-[0.16em] text-teal-700">Secure referrals</p><h1 className="mt-3 text-2xl font-bold text-slate-950">This referral form is unavailable</h1><p className="mt-3 leading-7 text-slate-600">{message}</p><p className="mt-5 text-sm text-slate-500">Contact the practice using its published details if you need help.</p></section></main>;
  if (phase === 'complete') return <main className="grid min-h-screen place-items-center bg-slate-50 px-4"><section className="max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 text-center shadow-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl font-bold text-emerald-700">✓</div><h1 className="mt-5 text-2xl font-bold text-slate-950">Referral received</h1><p className="mt-3 leading-7 text-slate-600">{message || payload.form.completionMessage}</p>{reference && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 font-mono text-sm text-slate-700">Reference ending {reference}</p>}<p className="mt-5 text-sm leading-6 text-slate-500">Submission does not mean the referral has been accepted or clinically triaged. For urgent help, follow the practice’s published advice or contact emergency services.</p></section></main>;

  return <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
    <div className="mx-auto max-w-2xl">
      <header className="mb-5 flex items-center justify-between gap-4 px-1"><div><p className="text-sm font-extrabold tracking-tight text-teal-800">VOXERA</p><p className="text-xs text-slate-500">Secure referral for {payload.practice.name}</p></div>{draft && <div className="text-right text-xs text-slate-500"><p>{saving ? 'Saving…' : 'Encrypted in transit'}</p><p>Draft expires {new Date(draft.expiresAt).toLocaleString('en-GB')}</p></div>}</header>
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-6 sm:p-8"><p className="text-sm font-semibold text-teal-800">{payload.practice.name}</p><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{payload.schema.title || payload.form.name}</h1>{payload.schema.description && <p className="mt-3 leading-7 text-slate-600">{payload.schema.description}</p>}{payload.operatingMode === 'synthetic_test' && <div className="mt-5 rounded-xl border-2 border-rose-400 bg-rose-50 p-4 text-sm font-semibold leading-6 text-rose-950"><strong className="block uppercase tracking-wide">Test form — no real person information</strong>This workspace is in synthetic-test mode. Use invented test details only. Do not enter information about a real patient, referrer or care need.</div>}<div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-medium leading-6 text-amber-950"><strong className="block">Not for emergency or continuously monitored contact</strong>{payload.form.emergencyNotice}</div></div>

        {(phase === 'intro' || phase === 'starting') ? <div className="p-6 sm:p-8"><h2 className="text-lg font-bold text-slate-950">Before you begin</h2><div className="mt-3 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm leading-7 text-slate-700">{payload.form.privacyNotice}</div><ul className="mt-5 space-y-2 text-sm leading-6 text-slate-600"><li>• Have the patient and referrer details requested by the practice ready.</li><li>• Your draft lasts 24 hours in this browser tab.</li><li>• Submission creates an administrative referral for staff review; it does not confirm care or urgency.</li></ul>{message && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{message}</p>}<button type="button" disabled={phase === 'starting'} onClick={() => void start()} className="mt-6 w-full rounded-xl bg-teal-800 px-5 py-3.5 font-bold text-white transition hover:bg-teal-900 disabled:cursor-wait disabled:bg-slate-400">{phase === 'starting' ? 'Starting securely…' : 'Start secure referral'}</button></div> : <>
          <div className="border-b border-slate-200 px-6 py-4 sm:px-8"><div className="mb-2 flex justify-between text-xs font-medium text-slate-600"><span>Required fields</span><span>{completed} of {required.length}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-700 transition-all" style={{ width: `${progress}%` }} /></div></div>
          <form className="grid gap-7 p-6 sm:p-8" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <fieldset disabled={phase === 'submitting'} className="grid gap-7">{fields.map((field) => <div key={field.id}>{field.type !== 'display' && <label htmlFor={`referral-${field.id}`} className="block text-[15px] font-semibold text-slate-950">{field.label}{field.required && <span className="ml-1 text-rose-600" aria-label="required">*</span>}</label>}{field.help && <p className="mt-1 text-sm leading-6 text-slate-500">{field.help}</p>}<ReferralField field={field} value={answers[field.key]} disabled={phase === 'submitting' || Boolean(uploading)} onChange={(value) => change(field, value)} onUpload={upload} /></div>)}</fieldset>
            {message && <p role="status" aria-live="polite" className={`rounded-xl p-3 text-sm ${/saved|attached securely/i.test(message) ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>{message}</p>}
            <div className="sticky bottom-3 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur"><button type="submit" disabled={phase === 'submitting' || Boolean(uploading)} className="w-full rounded-xl bg-teal-800 px-5 py-3.5 font-bold text-white transition hover:bg-teal-900 disabled:cursor-not-allowed disabled:bg-slate-400">{phase === 'submitting' ? 'Submitting securely…' : uploading ? 'Securing attachment…' : payload.schema.submitLabel ?? 'Submit referral securely'}</button><p className="mt-2 text-center text-xs leading-5 text-slate-500">Draft answers save after you pause. The practice will review the referral before making any care decision.</p></div>
          </form>
        </>}
      </section>
      <footer className="px-4 py-6 text-center text-xs leading-5 text-slate-500">This page is not an emergency service. If someone is in immediate danger in the UK, call 999 or attend A&amp;E.</footer>
    </div>
  </main>;
}
