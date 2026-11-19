'use client';

import * as React from 'react';
import { useToast } from '../ui';
import { Icons } from '../icons';
import { cn } from '@/lib/utils';

const GOALS = ['Customer support', 'Appointment administration', 'Contractor enquiries', 'Payment-status administration', 'Custom / other'];
const VOLUMES = ['Controlled pilot', 'Under 1k minutes/mo', '1k–10k minutes/mo', '10k+ minutes/mo — load review required', 'Not known yet'];
const REQUIREMENTS = ['Independent security review', 'Privacy / legal review', 'Healthcare / clinical review', 'Data-residency requirement', 'Retention requirement', 'Identity / SSO requirement'];

export function SalesForm() {
  const toast = useToast();
  const [step, setStep] = React.useState(0);
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({
    name: '',
    email: '',
    company: '',
    role: '',
    goal: GOALS[0],
    volume: VOLUMES[1],
    requirements: [] as string[],
    timeline: 'This quarter',
    phone: '',
    notes: '',
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const valid0 = form.name.length > 1 && form.email.includes('@') && form.company.length > 1;

  // The form posts to /api/public/sales-lead, which stores the enquiry as
  // a lead the sales inbox works. It used to only show this thank-you —
  // the enquiry itself went nowhere, which is the worst kind of form bug:
  // the one the sender can never see.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/public/sales-lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new Error(data?.error?.message ?? 'Something went wrong sending that. Please try again.');
      setSent(true);
      toast('Request saved for the deployment operator.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong sending that. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="panel p-8 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-brand-500/25 bg-brand-500/[0.1] text-brand-700">
          <Icons.check size={22} />
        </span>
        <h2 className="h3 mt-5">Thanks, {form.name.split(' ')[0]}.</h2>
        <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-slateink-400">
          The server saved your deployment enquiry for the operator, with <span className="text-slate-900">{form.email}</span> as the requested reply address. No response time or quote is implied by this confirmation.
        </p>
        <div className="mt-7 grid gap-3 rounded-xl border border-slate-900/[0.045] bg-ink-900/60 p-4 text-left">
          {[
            ['Use case', form.goal],
            ['Volume', form.volume],
            ['Requirements', form.requirements.join(', ') || 'None specified'],
            ['Timeline', form.timeline],
          ].map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-4">
              <span className="text-[12px] text-slateink-400">{k}</span>
              <span className="text-right text-[12.5px] text-slate-900">{v}</span>
            </div>
          ))}
        </div>
        <button onClick={() => setSent(false)} className="btn-ghost mt-6">
          <Icons.refresh size={15} /> Submit another request
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel overflow-hidden p-0">
      {/* Honeypot: hidden from people, filled in by bots. The endpoint
          answers as if it worked and stores nothing. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <div className="flex items-center gap-3 border-b border-slate-900/[0.04] px-6 py-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-slateink-400">
          Step {step + 1} of 2
        </span>
        <span className="flex flex-1 gap-1.5">
          {[0, 1].map((i) => (
            <span key={i} className={cn('h-1 flex-1 rounded-full transition-colors', i <= step ? 'bg-brand-400' : 'bg-slate-900/[0.08]')} />
          ))}
        </span>
      </div>

      <div className="p-6">
        {step === 0 ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Full name *</label>
                <input className="field" placeholder="Jordan Reyes" value={form.name} onChange={(e) => set('name', e.target.value)} required />
              </div>
              <div>
                <label className="label">Work email *</label>
                <input className="field" type="email" placeholder="jordan@company.com" value={form.email} onChange={(e) => set('email', e.target.value)} required />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Company *</label>
                <input className="field" placeholder="Northwind Inc." value={form.company} onChange={(e) => set('company', e.target.value)} required />
              </div>
              <div>
                <label className="label">Your role</label>
                <input className="field" placeholder="Head of Support" value={form.role} onChange={(e) => set('role', e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Phone</label>
              <input className="field" placeholder="+1 415 555 0142" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="label">Primary use case</label>
              <div className="flex flex-wrap gap-1.5">
                {GOALS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => set('goal', g)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                      form.goal === g ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] bg-slate-900/[0.02] text-slateink-400 hover:text-slate-900'
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Expected volume</label>
              <select className="field" value={form.volume} onChange={(e) => set('volume', e.target.value)}>
                {VOLUMES.map((v) => (
                  <option key={v} value={v} className="bg-ink-900">
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Requirements needing external evidence</label>
              <p className="mb-2 text-[11.5px] leading-relaxed text-slateink-400">Selecting one records a requirement; it does not mean this deployment currently satisfies it.</p>
              <div className="flex flex-wrap gap-1.5">
                {REQUIREMENTS.map((r) => {
                  const on = form.requirements.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() =>
                        set('requirements', on ? form.requirements.filter((x) => x !== r) : [...form.requirements, r])
                      }
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                        on ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] bg-slate-900/[0.02] text-slateink-400 hover:text-slate-900'
                      )}
                    >
                      {on && <Icons.check size={12} />}
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="label">Timeline</label>
              <div className="flex flex-wrap gap-1.5">
                {['ASAP', 'This quarter', 'Next quarter', 'Exploring'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set('timeline', t)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                      form.timeline === t ? 'border-brand-500/40 bg-brand-500/10 text-brand-700' : 'border-slate-900/[0.035] bg-slate-900/[0.02] text-slateink-400 hover:text-slate-900'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Anything we should know</label>
              <textarea
                className="field min-h-[96px] resize-y"
                placeholder="Which calls are you moving, and what systems do they touch?"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="border-t border-rose-400/20 bg-rose-500/[0.08] px-6 py-3 text-[12.5px] text-rose-700">
          {error} Your answers are still here — nothing was sent.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-slate-900/[0.04] px-6 py-4">
        <p className="text-[11.5px] leading-snug text-slateink-400">
          This creates a lead record. Do not include credentials or sensitive personal data.
        </p>
        <div className="flex shrink-0 gap-2">
          {step === 1 && (
            <button type="button" onClick={() => setStep(0)} className="btn-ghost btn-sm">
              Back
            </button>
          )}
          {step === 0 ? (
            <button
              type="button"
              onClick={() => valid0 && setStep(1)}
              disabled={!valid0}
              className="btn-brand btn-sm"
            >
              Continue <Icons.arrowRight size={14} />
            </button>
          ) : (
            <button type="submit" disabled={busy} className="btn-brand btn-sm disabled:opacity-60">
              Send request <Icons.send size={14} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
