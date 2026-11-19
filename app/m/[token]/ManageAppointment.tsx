'use client';

import * as React from 'react';

/**
 * The two things a client came here to do.
 *
 * Written for a phone held in one hand: the appointment first and in the largest
 * type in the product, then two buttons, then the slots. Everything the page
 * says about a change is what the server actually did — "Moved to Tuesday 20
 * October at 3:00pm" is the booking the server returned, not an optimistic hope.
 */

type View = {
  reference: string;
  status: string;
  statusWords: string;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
  service?: string;
  provider?: string;
  site?: string;
  address?: string;
  spoken: string;
  canChange: boolean;
  canCancel: boolean;
  isClassSeat: boolean;
  classNote?: string;
  packNote?: string;
  canCheckIn: boolean;
  checkInNote?: string;
  reason?: string;
  clientFirstName?: string;
  calendar?: string;
  practice?: { name: string; phone?: string };
  terms: { appointment: { one: string }; provider: { one: string }; location: { one: string } };
};

type SlotDay = {
  date: string;
  day: string;
  slots: { at: string; clock: string; with?: string; differentPerson: boolean; providerId?: string; locationId?: string }[];
};
type Slots = { timezone: string; days: SlotDay[] };

type Payload = { view: View; slots: Slots };

async function post(token: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/public/manage/${token}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { view?: View; slots?: Slots; message?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(payload?.error?.message || 'That did not work — please call the practice.');
  return payload;
}

export function ManageAppointment({ token, initial }: { token: string; initial: Payload }) {
  const [view, setView] = React.useState(initial.view);
  const [slots, setSlots] = React.useState(initial.slots);
  const [mode, setMode] = React.useState<'idle' | 'move' | 'cancel'>('idle');
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const settled = ['cancelled', 'completed', 'no_show'].includes(view.status);

  async function moveTo(startsAt: string, providerId?: string, locationId?: string) {
    setBusy(true);
    setProblem(null);
    try {
      // The slot's own practitioner travels with the time — an opening offered
      // under somebody else's name is only free for that somebody.
      const result = await post(token, { action: 'move', startsAt, providerId, locationId });
      if (result.view) setView(result.view);
      if (result.slots) setSlots(result.slots);
      setNote(result.message ?? 'Moved.');
      setMode('idle');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That time was not available.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(reason: string) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await post(token, { action: 'cancel', reason });
      if (result.view) setView(result.view);
      setNote(result.message ?? 'Cancelled.');
      setMode('idle');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work — please call the practice.');
    } finally {
      setBusy(false);
    }
  }

  async function checkIn() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await post(token, { action: 'check_in' });
      if (result.view) setView(result.view);
      setNote(result.message ?? 'You are checked in.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work — please tell the desk when you arrive.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await post(token, { action: 'confirm' });
      if (result.view) setView(result.view);
      setNote(result.message ?? 'Confirmed.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-[520px] px-5 py-10">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700">{view.practice?.name ?? 'Your appointment'}</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-snug text-slate-900">
        {settled ? 'Your appointment has been settled' : view.clientFirstName ? `${view.clientFirstName}, here is your appointment` : 'Here is your appointment'}
      </h1>

      <div className="mt-5 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.03] p-5">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-slateink-400">{view.terms.appointment.one}</div>
        <div className="mt-1.5 text-[19px] font-semibold leading-snug text-slate-900">{view.spoken}</div>
        <div className="mt-3 space-y-1 text-[13px] text-slateink-300">
          {view.service && <div>{view.service} · {view.durationMinutes} minutes</div>}
          {view.provider && <div>with {view.provider}</div>}
          {view.site && (
            <div>
              at {view.site}
              {view.address ? ` · ${view.address}` : ''}
            </div>
          )}
          <div className="pt-1 font-mono text-[11.5px] text-slateink-400">Reference {view.reference}</div>
        </div>
        {/* The file the diary would otherwise have to be retyped from. It is a
            download, not a redirect, so it works in the phone's own browser. */}
        {view.calendar && (
          <a
            href={view.calendar}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-2 text-[12.5px] font-medium text-slate-900 transition hover:border-slate-900/[0.05]"
          >
            Add to calendar
          </a>
        )}
        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-slate-900/[0.05] bg-slate-900/[0.04] px-2.5 py-1 text-[11.5px] text-slateink-200">
          <span className={`h-1.5 w-1.5 rounded-full ${view.status === 'confirmed' ? 'bg-emerald-400' : view.status === 'pending' ? 'bg-amber-400' : 'bg-slateink-500'}`} />
          {view.statusWords}
        </div>
      </div>

      {note && (
        <p className="mt-4 rounded-xl border border-brand-500/25 bg-brand-500/[0.07] px-3.5 py-2.5 text-[13px] text-brand-700" role="status">
          {note}
        </p>
      )}
      {problem && (
        <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3.5 py-2.5 text-[13px] text-amber-800" role="alert">
          {problem}
        </p>
      )}

      {view.canCheckIn || view.status === 'arrived' ? (
        <div className="mt-4 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.03] p-4">
          <div className="text-[13.5px] font-medium text-slate-900">{view.status === 'arrived' ? 'You are checked in' : 'Arrived?'}</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-slateink-300">{view.checkInNote ?? 'Tell the desk you are here.'}</p>
          {view.canCheckIn && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void checkIn()}
              className="mt-3 w-full rounded-xl bg-brand-500 px-4 py-3 text-[14px] font-medium text-ink-950 transition disabled:opacity-50"
            >
              I&rsquo;m here — check in
            </button>
          )}
        </div>
      ) : null}

      {!settled && view.status === 'pending' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="mt-4 w-full rounded-xl bg-brand-500 px-4 py-3 text-[14px] font-medium text-ink-950 transition disabled:opacity-50"
        >
          Yes, I&rsquo;ll be there
        </button>
      )}

      {view.canChange || view.canCancel ? (
        mode === 'idle' ? (
          <>
            {view.packNote ? (
              <p className="mt-4 rounded-xl border border-brand-400/25 bg-brand-400/[0.06] px-3.5 py-2.5 text-[13px] text-brand-800">{view.packNote}</p>
            ) : null}
            {view.classNote ? (
              <p className="mt-4 rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.03] px-3.5 py-2.5 text-[13px] text-slateink-300">{view.classNote}</p>
            ) : null}
            <div className={`mt-4 grid gap-2.5 ${view.canChange ? 'sm:grid-cols-2' : ''}`}>
              {view.canChange ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setMode('move')}
                  className="rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.04] px-4 py-3 text-[13.5px] font-medium text-slate-900 transition hover:border-slate-900/[0.05] disabled:opacity-50"
                >
                  Move it
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode('cancel')}
                className="rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.04] px-4 py-3 text-[13.5px] font-medium text-slateink-200 transition hover:border-slate-900/[0.05] hover:text-slate-900 disabled:opacity-50"
              >
                {view.isClassSeat ? 'Give my place up' : 'Cancel it'}
              </button>
            </div>
          </>
        ) : mode === 'move' ? (
          <section className="mt-4 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-medium text-slate-900">Pick a new time</h2>
              <button type="button" className="text-[12.5px] text-slateink-400 hover:text-slate-900" onClick={() => setMode('idle')}>
                Keep mine
              </button>
            </div>
            <p className="mt-1 text-[12px] text-slateink-400">Real openings at {view.site ?? 'the practice'}, booked the moment you choose one.</p>
            {slots.days.length === 0 ? (
              <p className="mt-3 text-[13px] text-slateink-300">
                Nothing is open in the next fortnight{view.practice?.phone ? ` — call ${view.practice.phone} and they will find you a time.` : '.'}
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                {slots.days.map((day) => (
                  <div key={day.date}>
                    <div className="text-[12px] font-medium text-slateink-300">{day.day}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {day.slots.map((slot) => (
                        <button
                          key={slot.at}
                          type="button"
                          disabled={busy}
                          onClick={() => void moveTo(slot.at, slot.providerId, slot.locationId)}
                          title={slot.differentPerson && slot.with ? `With ${slot.with}` : undefined}
                          className="rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-1.5 font-mono text-[12px] text-slate-900 transition hover:border-brand-500/40 hover:bg-brand-500/[0.10] disabled:opacity-50"
                        >
                          {slot.clock}
                          {slot.differentPerson && slot.with ? <span className="ml-1.5 font-sans text-[10.5px] text-slateink-400">{slot.with.split(/\s+/)[0]}</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="mt-4 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-medium text-slate-900">{view.isClassSeat ? 'Give your place up?' : 'Cancel this appointment?'}</h2>
              <button type="button" className="text-[12.5px] text-slateink-400 hover:text-slate-900" onClick={() => setMode('idle')}>
                Keep it
              </button>
            </div>
            <p className="mt-1 text-[12px] text-slateink-400">
              {view.isClassSeat
                ? 'Your place goes back to the class and the practice is told straight away.'
                : 'No charge applies and the practice is told straight away.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {['Something came up', 'I am unwell', 'I need a different day', 'Other'].map((reason) => (
                <button
                  key={reason}
                  type="button"
                  disabled={busy}
                  onClick={() => void cancel(reason)}
                  className="rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-1.5 text-[12.5px] text-slateink-200 transition hover:border-red-400/40 hover:text-slate-900 disabled:opacity-50"
                >
                  {reason}
                </button>
              ))}
            </div>
          </section>
        )
      ) : (
        !settled && (
          <p className="mt-4 rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.03] px-3.5 py-2.5 text-[13px] text-slateink-300">
            {view.reason}
            {view.practice?.phone ? (
              <>
                {' '}
                Call{' '}
                <a className="text-brand-700 underline underline-offset-2" href={`tel:${view.practice.phone}`}>
                  {view.practice.phone}
                </a>
                .
              </>
            ) : null}
          </p>
        )
      )}

      <p className="mt-8 text-[11.5px] leading-relaxed text-slateink-500">
        This page is yours alone — it shows only this appointment, and the practice sees whatever you change here as though you had rung them. Nobody else can open it.
      </p>
    </main>
  );
}
