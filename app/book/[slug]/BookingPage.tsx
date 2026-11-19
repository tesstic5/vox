'use client';

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { Button } from '@/components/ui';
import { Icons } from '@/components/icons';
import type { Terms } from '@/lib/terms';
import { ClassJoin } from './ClassJoin';

/**
 * The public booking page.
 *
 * Five steps, one page, no account: service → who → when → details → done.
 *
 * Deliberate choices, each for a reason:
 *
 *  - **The steps are shown, not hidden.** People abandon a form that springs an
 *    extra question on them at the end; seeing "Details" waiting two steps away
 *    is what makes them finish.
 *  - **Nothing personal is stored in the browser.** The chosen slot and service
 *    live in component state, so a shared machine in a waiting room keeps
 *    nothing after the tab closes.
 *  - **A taken slot is not an error page.** If the slot goes while the form is
 *    being filled, the page says so and reloads the times — the visitor loses a
 *    minute, not the booking.
 */

type PublicService = {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price: number;
  providerNames: string[];
};

type PublicProvider = { id: string; name: string; title?: string };
type PublicSite = { id: string; name: string; address?: string; timezone: string };

type PublicClass = {
  sessionId: string;
  serviceId: string;
  serviceName: string;
  instructor?: string;
  site?: string;
  room?: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  seatsLeft: number;
  local: { date: string; start: string; end: string; spoken: string; timezone: string };
};

type WorkspacePayload = {
  workspace: { slug: string; name: string; terms: Terms; timezone: string };
  booking: { enabled: boolean; showProviders: boolean; minNoticeMinutes: number; maxAdvanceDays: number; slotStepMinutes: number };
  services: PublicService[];
  providers: PublicProvider[];
  sites: PublicSite[];
  /** Group sessions with places left (A8) — offered beside the services. */
  classes?: PublicClass[];
  notice?: string;
};

type DaySlots = { date: string; slots: { startsAt: string; label: string; providerId: string; providerName: string }[] };

type Receipt = {
  booking: { id: string; reference: string; startsAt: string; service: string; providerName?: string; siteName?: string; timezone: string; local: string };
  client: { name: string; firstName?: string };
  confirmation: { channel: string; status: string; reason?: string; queued: boolean };
  calendar: string;
};

const STEPS = ['Service', 'Time', 'Details', 'Booked'] as const;

export function BookingPage({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const [step, setStep] = React.useState(0);
  const [data, setData] = React.useState<WorkspacePayload | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [serviceId, setServiceId] = React.useState('');
  const [locationId, setLocationId] = React.useState('');
  const [providerId, setProviderId] = React.useState('');
  const [day, setDay] = React.useState('');
  const [slot, setSlot] = React.useState<{ startsAt: string; label: string; providerName: string } | null>(null);
  const [days, setDays] = React.useState<DaySlots[]>([]);
  const [slotsLoading, setSlotsLoading] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', number: '', email: '', notes: '', consentSms: true, consentEmail: false });
  const [sending, setSending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<Receipt | null>(null);

  const service = data?.services.find((s) => s.id === serviceId);
  const terms = data?.workspace.terms;

  React.useEffect(() => {
    let live = true;
    request<WorkspacePayload>('GET', `/api/public/workspaces/${slug}/booking`)
      .then((payload) => {
        if (!live) return;
        setData(payload);
        setServiceId(payload.services[0]?.id ?? '');
        setLocationId(payload.sites[0]?.id ?? '');
      })
      .catch((err) => live && setLoadError(err instanceof ApiError ? err.message : 'This booking page could not be loaded.'));
    return () => {
      live = false;
    };
  }, [slug]);

  const loadSlots = React.useCallback(async () => {
    if (!serviceId) return;
    setSlotsLoading(true);
    setProblem(null);
    try {
      const params = new URLSearchParams({ serviceId, days: '14', limit: '80' });
      if (providerId) params.set('providerId', providerId);
      if (locationId) params.set('locationId', locationId);
      const result = await request<{ days: DaySlots[] }>('GET', `/api/public/workspaces/${slug}/availability?${params.toString()}`);
      setDays(result.days);
      setDay((current) => (result.days.some((d) => d.date === current) ? current : result.days[0]?.date ?? ''));
    } catch {
      setDays([]);
      setProblem('We could not load the times just now. Please refresh, or call and we will book you in.');
    } finally {
      setSlotsLoading(false);
    }
  }, [slug, serviceId, providerId, locationId]);

  React.useEffect(() => {
    if (step === 1) void loadSlots();
  }, [step, loadSlots]);

  async function submit() {
    if (!slot) return;
    setSending(true);
    setProblem(null);
    try {
      const result = await request<Receipt>('POST', `/api/public/workspaces/${slug}/booking`, {
        startsAt: slot.startsAt,
        serviceId,
        providerId: providerId || undefined,
        locationId: locationId || undefined,
        name: form.name,
        number: form.number,
        email: form.email || undefined,
        notes: form.notes || undefined,
        consentSms: form.consentSms,
        consentEmail: form.consentEmail,
      });
      setReceipt(result);
      setStep(3);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'That did not go through. Please try again or call us.';
      setProblem(message);
      // The slot went while they were typing: send them back to the times with
      // fresh availability rather than making them guess what changed.
      if (err instanceof ApiError && err.status === 409) {
        setSlot(null);
        setStep(1);
        void loadSlots();
      }
    } finally {
      setSending(false);
    }
  }

  if (loadError) {
    return (
      <Shell workspaceName={workspaceName}>
        <p className="text-[14px] text-slateink-300">{loadError}</p>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell workspaceName={workspaceName}>
        <div className="flex items-center gap-3 text-[13.5px] text-slateink-400">
          <Icons.refresh size={15} className="animate-spin" /> Loading times…
        </div>
      </Shell>
    );
  }

  if (!data.booking.enabled) {
    return (
      <Shell workspaceName={data.workspace.name}>
        <h1 className="h3">Online booking is closed</h1>
        <p className="mt-2 text-[14px] text-slateink-300">{data.notice ?? 'Please call the practice and we will find you a time.'}</p>
      </Shell>
    );
  }

  return (
    <Shell workspaceName={data.workspace.name}>
      {/* ------------------------------------------------------- the steps */}
      <ol className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px] uppercase tracking-[0.14em]">
        {STEPS.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                index === step
                  ? 'flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[10px] text-ink-950'
                  : index < step
                    ? 'flex h-5 w-5 items-center justify-center rounded-full bg-brand-500/20 text-[10px] text-brand-700'
                    : 'flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/[0.06] text-[10px] text-slateink-400'
              }
            >
              {index < step ? '✓' : index + 1}
            </span>
            <span className={index === step ? 'text-slate-900' : 'text-slateink-400'}>{label}</span>
            {index < STEPS.length - 1 && <span className="hidden text-slateink-600 sm:inline">—</span>}
          </li>
        ))}
      </ol>

      {problem && (
        <div className="mb-5 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3 text-[13px] text-amber-800">{problem}</div>
      )}

      {/* ------------------------------------------------------ 1. service */}
      {step === 0 && (
        <section>
          <h2 className="h3">What do you need?</h2>
          <p className="mt-1 text-[13.5px] text-slateink-400">
            Pick one and you will see the first times we can do. Nothing is confirmed until the last step.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {data.services.map((option) => (
              <button
                key={option.id}
                onClick={() => setServiceId(option.id)}
                className={
                  'rounded-2xl border p-4 text-left transition-colors ' +
                  (option.id === serviceId ? 'border-brand-500/60 bg-brand-500/[0.08]' : 'border-slate-900/[0.035] bg-ink-900/40 hover:border-slate-900/[0.09]')
                }
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-[14.5px] font-medium text-slate-900">{option.name}</span>
                  {option.price > 0 && <span className="font-mono text-[12px] text-slateink-300">{formatMoney(option.price)}</span>}
                </div>
                {option.description && <p className="mt-1 text-[12.5px] leading-snug text-slateink-400">{option.description}</p>}
                <p className="mt-2 text-[11.5px] text-slateink-500">
                  {option.durationMinutes} minutes
                  {option.providerNames.length > 0 && ` · ${option.providerNames.join(', ')}`}
                </p>
              </button>
            ))}
          </div>

          {data.sites.length > 1 && (
            <div className="mt-5">
              <label className="label" htmlFor="site">
                {terms?.location.One ?? 'Location'}
              </label>
              <select id="site" className="field mt-1.5 text-[13.5px]" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {data.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                    {site.address ? ` — ${site.address}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            <Button variant="brand" size="sm" disabled={!serviceId} onClick={() => setStep(1)}>
              See times <Icons.chevronRight size={14} />
            </Button>
            {service && (
              <span className="text-[12.5px] text-slateink-400">
                {service.durationMinutes} minutes · {formatMoney(service.price)}
              </span>
            )}
          </div>

          {/* Classes are offered here rather than inside the slot picker: a place
              in something that is happening is a different request from an hour
              of somebody's time (A8). */}
          <ClassJoin slug={slug} classes={data.classes ?? []} />
        </section>
      )}

      {/* --------------------------------------------------------- 2. time */}
      {step === 1 && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="h3">{terms?.appointment.One ?? 'Appointment'}: pick a time</h2>
              <p className="mt-1 text-[13.5px] text-slateink-400">
                {service?.name} · {service?.durationMinutes} minutes
                {data.sites.length === 1 ? ` · ${data.sites[0].name}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
              <Icons.chevronDown size={13} className="rotate-90" /> Change
            </Button>
          </div>

          {data.booking.showProviders && data.providers.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setProviderId('')}
                className={
                  'rounded-full border px-3 py-1.5 text-[12.5px] ' +
                  (providerId === '' ? 'border-brand-500/60 bg-brand-500/[0.10] text-slate-900' : 'border-slate-900/[0.04] text-slateink-300 hover:border-slate-900/[0.05]')
                }
              >
                First available
              </button>
              {data.providers.map((person) => (
                <button
                  key={person.id}
                  onClick={() => setProviderId(person.id)}
                  className={
                    'rounded-full border px-3 py-1.5 text-[12.5px] ' +
                    (providerId === person.id ? 'border-brand-500/60 bg-brand-500/[0.10] text-slate-900' : 'border-slate-900/[0.04] text-slateink-300 hover:border-slate-900/[0.05]')
                  }
                >
                  {person.name}
                  {person.title ? ` · ${person.title}` : ''}
                </button>
              ))}
            </div>
          )}

          {slotsLoading && (
            <div className="mt-6 flex items-center gap-3 text-[13px] text-slateink-400">
              <Icons.refresh size={14} className="animate-spin" /> Checking the diary…
            </div>
          )}

          {!slotsLoading && days.length === 0 && (
            <div className="mt-6 rounded-2xl border border-slate-900/[0.035] bg-ink-900/40 p-5">
              <p className="text-[13.5px] text-slate-900">Nothing free in the next two weeks.</p>
              <p className="mt-1 text-[12.5px] text-slateink-400">
                Ring the practice and we will find you something — there is usually a cancellation worth having.
              </p>
            </div>
          )}

          {!slotsLoading && days.length > 0 && (
            <>
              <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
                {days.map((d) => (
                  <button
                    key={d.date}
                    onClick={() => setDay(d.date)}
                    className={
                      'shrink-0 rounded-xl border px-3 py-2 text-left ' +
                      (d.date === day ? 'border-brand-500/60 bg-brand-500/[0.10]' : 'border-slate-900/[0.035] hover:border-slate-900/[0.09]')
                    }
                  >
                    <span className="block text-[12.5px] text-slate-900">{dayLabel(d.date)}</span>
                    <span className="block font-mono text-[10.5px] text-slateink-400">
                      {d.slots.length} {d.slots.length === 1 ? 'time' : 'times'}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {(days.find((d) => d.date === day)?.slots ?? []).map((option) => (
                  <button
                    key={option.startsAt}
                    onClick={() => {
                      setSlot({ startsAt: option.startsAt, label: option.label, providerName: option.providerName });
                      setProblem(null);
                      setStep(2);
                    }}
                    className="rounded-xl border border-slate-900/[0.04] px-3 py-2 text-[13px] text-slate-900 hover:border-brand-500/60 hover:bg-brand-500/[0.08]"
                    title={providerId ? undefined : `with ${option.providerName}`}
                  >
                    {option.label}
                    {!providerId && <span className="ml-2 text-[11px] text-slateink-400">{option.providerName.split(' ')[0]}</span>}
                  </button>
                ))}
              </div>
              <p className="mt-4 text-[11.5px] text-slateink-500">
                Times are shown in {data.workspace.timezone}
                {data.booking.minNoticeMinutes > 0 && ` · book at least ${data.booking.minNoticeMinutes} minutes ahead`}.
              </p>
            </>
          )}
        </section>
      )}

      {/* ------------------------------------------------------ 3. details */}
      {step === 2 && slot && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="h3">Your details</h2>
              <p className="mt-1 text-[13.5px] text-slateink-400">
                {service?.name} · {slot.label}
                {providerId ? ` with ${slot.providerName}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
              <Icons.chevronDown size={13} className="rotate-90" /> Change time
            </Button>
          </div>

          <div className="mt-5 grid max-w-xl gap-4">
            <div>
              <label className="label" htmlFor="name">
                Your name
              </label>
              <input
                id="name"
                className="field mt-1.5 text-[14px]"
                autoComplete="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="First and last name"
              />
            </div>
            <div>
              <label className="label" htmlFor="number">
                Phone number
              </label>
              <input
                id="number"
                className="field mt-1.5 text-[14px]"
                type="tel"
                autoComplete="tel"
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
                placeholder="So we can reach you about this appointment"
              />
            </div>
            <div>
              <label className="label" htmlFor="email">
                Email <span className="text-slateink-500">(optional)</span>
              </label>
              <input
                id="email"
                className="field mt-1.5 text-[14px]"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="notes">
                Anything we should know? <span className="text-slateink-500">(optional)</span>
              </label>
              <textarea
                id="notes"
                className="field mt-1.5 min-h-[76px] text-[13.5px]"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Parking, access needs, a preferred practitioner…"
              />
            </div>

            <fieldset className="rounded-2xl border border-slate-900/[0.035] p-4">
              <legend className="px-1 text-[12.5px] text-slateink-300">How may we contact you about this appointment?</legend>
              <label className="mt-2 flex items-start gap-2.5 text-[13.5px] text-slateink-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.consentSms}
                  onChange={(e) => setForm({ ...form, consentSms: e.target.checked })}
                />
                <span>
                  Text me a confirmation and a reminder
                  <span className="block text-[11.5px] text-slateink-500">We will only text about your appointments. Reply STOP any time.</span>
                </span>
              </label>
              <label className="mt-2.5 flex items-start gap-2.5 text-[13.5px] text-slateink-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.consentEmail}
                  onChange={(e) => setForm({ ...form, consentEmail: e.target.checked })}
                  disabled={!form.email}
                />
                <span>
                  Email me as well
                  {!form.email && <span className="block text-[11.5px] text-slateink-500">Add an email address first.</span>}
                </span>
              </label>
              <p className="mt-3 border-t border-slate-900/[0.04] pt-3 text-[11.5px] leading-relaxed text-slateink-500">
                Unticking these does not cancel your appointment — it only stops the messages. If the practice records calls,
                they will ask you separately.
              </p>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="brand" size="sm" disabled={sending || form.name.trim().length < 2 || form.number.replace(/\D/g, '').length < 7} onClick={() => void submit()}>
                {sending ? 'Booking…' : 'Confirm booking'}
              </Button>
              <span className="text-[12px] text-slateink-400">Confirmed straight away — no waiting for a call back.</span>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- 4. booked */}
      {step === 3 && receipt && (
        <section>
          <div className="flex items-center gap-2 text-brand-700">
            <Icons.check size={18} />
            <span className="font-mono text-[11.5px] uppercase tracking-[0.16em]">Appointment booked</span>
          </div>
          <h2 className="h3 mt-3">You are in, {receipt.client.firstName ?? receipt.client.name}.</h2>
          <div className="mt-4 max-w-xl rounded-2xl border border-slate-900/[0.035] bg-ink-900/40 p-5">
            <dl className="grid gap-3 text-[13.5px] sm:grid-cols-2">
              <Row label="When" value={receipt.booking.local} />
              <Row label="What" value={receipt.booking.service} />
              {receipt.booking.providerName && <Row label="Who" value={receipt.booking.providerName} />}
              {receipt.booking.siteName && <Row label="Where" value={receipt.booking.siteName} />}
              <Row label="Reference" value={receipt.booking.reference} />
            </dl>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-900/[0.04] pt-4">
              <a className="btn-ghost btn-sm" href={receipt.calendar}>
                <Icons.calendar size={13} /> Add to calendar
              </a>
              <span className="text-[12.5px] text-slateink-400">
                {receipt.confirmation.queued
                  ? `A confirmation is on its way to your phone.`
                  : receipt.confirmation.status === 'blocked'
                    ? 'No confirmation text will be sent — you asked us not to. Your appointment is still booked.'
                    : 'Your appointment is booked.'}
              </span>
            </div>
          </div>
          <p className="mt-4 text-[12.5px] text-slateink-400">
            Need to change it? Call the practice and quote {receipt.booking.reference}. You can also ring the line and the
            assistant will find the booking by your number.
          </p>
        </section>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------- small pieces */

function Shell({ workspaceName, children }: { workspaceName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ink-950 text-slate-900">
      <header className="border-b border-slate-900/[0.045]">
        <div className="container-wide flex items-center justify-between py-5">
          <span className="text-[15px] font-semibold tracking-tight">{workspaceName}</span>
          <a className="text-[12.5px] text-slateink-400 hover:text-slate-900" href="/">
            Powered by Voxera
          </a>
        </div>
      </header>
      <main id="main-content" className="container-wide max-w-3xl py-10">
        {children}
      </main>
      <footer className="container-wide max-w-3xl pb-12 text-[11.5px] leading-relaxed text-slateink-500">
        This page books directly into the practice's own diary. Your details are used to run this appointment and are kept
        with the practice's records, not in your browser.
      </footer>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slateink-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{value}</dd>
    </div>
  );
}

function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatMoney(value: number) {
  return value % 1 === 0 ? `$${value}` : `$${value.toFixed(2)}`;
}
