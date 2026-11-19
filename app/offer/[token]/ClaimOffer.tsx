'use client';

import * as React from 'react';

/**
 * The freed-slot page: one time, two buttons.
 *
 * Written for a phone held in one hand, like the appointment page it is a cousin
 * of. The offer is the largest thing on the screen, the claim is one tap, and
 * whatever the server answers is what the page says — "You are booked" only ever
 * appears after a booking exists.
 *
 * When the time has gone (the window closed, or somebody else got there first)
 * the page does not dead-end: it shows the live openings and the practice's own
 * phone number, because a person who wanted an appointment is a person to look
 * after.
 */

type Slot = { at: string; clock: string; with?: string; differentPerson: boolean };
type SlotDay = { date: string; day: string; slots: Slot[] };
type View = {
  name: string;
  firstName?: string;
  spoken: string;
  expiresWords: string;
  status: 'open' | 'claimed' | 'declined' | 'expired' | 'withdrawn';
  canTake: boolean;
  alreadyTaken: boolean;
  canPickAnother: boolean;
  service?: string;
  /**
   * A place in a class and a stretch of the diary are different promises: the
   * page says which one it is holding, because "Yes, book me in" is the wrong
   * sentence for a chair in somebody else's class.
   */
  kind?: 'slot' | 'class';
  className?: string;
  practice?: { name?: string; phone?: string };
  terms: { appointment: { one: string } };
  reference?: string;
  manageLink?: string;
  alternatives: { timezone: string; days: SlotDay[]; widened?: boolean };
  entryId: string;
};
type Payload = { view: View; offerId: string; message?: string; booking?: { reference?: string; startsAt?: string } };

async function read(token: string) {
  const res = await fetch(`/api/public/offer/${token}`, { headers: { accept: 'application/json' } });
  const payload = (await res.json().catch(() => ({}))) as Payload;
  return payload;
}

async function post(token: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/public/offer/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Payload & { error?: { message?: string } };
  if (!res.ok) throw new Error(payload?.error?.message || 'That did not work — please call the practice.');
  return payload;
}

export function ClaimOffer({ token }: { token: string }) {
  // The offer is read live on mount rather than rendered from the server pass: a
  // slot claimed in another tab, or one whose window closed while the text sat
  // unopened, would otherwise be shown as still open — and the whole point of the
  // page is that it says what is true right now.
  const [view, setView] = React.useState<View | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [note, setNote] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await read(token);
        if (live && payload.view) setView(payload.view);
      } catch {
        if (live) setProblem('We could not read this offer — please call the practice.');
      } finally {
        if (live) setChecking(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  async function take(startsAt?: string) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await post(token, startsAt ? { action: 'claim', startsAt } : { action: 'claim' });
      if (result.view) setView(result.view);
      setNote(result.message ?? 'You are booked.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work — please call the practice.');
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await post(token, { action: 'decline' });
      if (result.view) setView(result.view);
      setNote(result.message ?? 'Understood.');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work — please call the practice.');
    } finally {
      setBusy(false);
    }
  }

  if (checking || !view) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-[520px] px-5 py-10">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700">One moment</p>
        <h1 className="mt-2 text-[22px] font-semibold leading-snug text-slate-900">Checking your offer&hellip;</h1>
        {problem && <p className="mt-4 text-[13px] text-amber-800" role="alert">{problem}</p>}
      </main>
    );
  }

  const practice = view.practice?.name ?? 'The practice';
  const isClass = view.kind === 'class';
  const gone = ['expired', 'withdrawn'].includes(view.status);
  const claimed = view.status === 'claimed';
  const declined = view.status === 'declined';

  return (
    <main className="mx-auto min-h-screen w-full max-w-[520px] px-5 py-10">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-brand-700">{practice}</p>
      <h1 className="mt-2 text-[22px] font-semibold leading-snug text-slate-900">
        {claimed
          ? 'That one is yours'
          : declined
            ? 'No problem'
            : gone
              ? isClass
                ? 'That place has gone'
                : 'That time has gone'
              : view.firstName
                ? `${view.firstName}, a ${isClass ? 'place' : 'time'} has opened up`
                : `A ${isClass ? 'place' : 'time'} has opened up`}
      </h1>

      {!claimed && !declined && (
        <div className="mt-5 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.03] p-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-slateink-400">{isClass ? 'A place in' : 'Offered to you'}</div>
          <div className="mt-1.5 text-[19px] font-semibold leading-snug text-slate-900">{isClass ? view.className ?? view.service : view.spoken}</div>
          <div className="mt-3 space-y-1 text-[13px] text-slateink-300">
            {isClass ? <div>{view.spoken}</div> : view.service && <div>{view.service}</div>}
            {isClass && <div className="text-slateink-400">You were in line for this class. Taking it puts you in it.</div>}
            {!gone && view.canTake && <div className="text-slateink-400">The offer stands until {view.expiresWords}.</div>}
          </div>
        </div>
      )}

      {claimed && (
        <div className="mt-5 rounded-2xl border border-brand-500/25 bg-brand-500/[0.07] p-5">
          <div className="text-[19px] font-semibold leading-snug text-slate-900">{view.spoken}</div>
          <div className="mt-2 space-y-1 text-[13px] text-slateink-200">
            {view.service && <div>{view.service}</div>}
            {view.reference && <div className="font-mono text-[11.5px] text-slateink-300">Reference {view.reference}</div>}
            <div className="pt-1 text-[12.5px] text-slateink-300">A confirmation is on its way to your phone.</div>
          </div>
          {view.manageLink && (
            <a href={view.manageLink} className="mt-4 inline-flex rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.04] px-4 py-2.5 text-[13.5px] font-medium text-slate-900 transition hover:border-slate-900/[0.05]">
              Open the appointment
            </a>
          )}
        </div>
      )}

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

      {view.canTake && (
        <div className="mt-6 grid gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void take()}
            className="w-full rounded-xl bg-brand-500 px-4 py-3.5 text-[15px] font-semibold text-ink-950 transition disabled:opacity-50"
          >
            {isClass ? 'Yes, take my place' : 'Yes, book me in'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decline()}
            className="w-full rounded-xl border border-slate-900/[0.06] bg-slate-900/[0.04] px-4 py-3 text-[13.5px] font-medium text-slateink-200 transition hover:border-slate-900/[0.05] hover:text-slate-900 disabled:opacity-50"
          >
            No thanks, I will pass
          </button>
        </div>
      )}

      {view.canPickAnother && view.alternatives.days.length > 0 && (
        <section className="mt-6 rounded-2xl border border-slate-900/[0.035] bg-slate-900/[0.02] p-4">
          <h2 className="text-[14px] font-medium text-slate-900">{view.canTake ? 'Rather come another time?' : 'Here is what is free now'}</h2>
          <p className="mt-1 text-[12px] text-slateink-400">
            {view.alternatives.widened
              ? 'Nothing free in the next fortnight, so these are the first openings we have — booking happens the moment you choose one.'
              : 'Live openings — booking happens the moment you choose one.'}
          </p>
          <div className="mt-3 space-y-3">
            {view.alternatives.days.map((day) => (
              <div key={day.date}>
                <div className="text-[12px] font-medium text-slateink-300">{day.day}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {day.slots.map((slot) => (
                    <button
                      key={slot.at}
                      type="button"
                      disabled={busy}
                      onClick={() => void take(slot.at)}
                      title={slot.differentPerson && slot.with ? `With ${slot.with}` : undefined}
                      className="rounded-lg border border-slate-900/[0.06] bg-slate-900/[0.04] px-3 py-1.5 font-mono text-[12px] text-slate-900 transition hover:border-brand-500/40 hover:bg-brand-500/[0.10] disabled:opacity-50"
                    >
                      {slot.clock}
                      {slot.differentPerson && slot.with ? '*' : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {view.practice?.phone && (
        <p className="mt-6 text-[12.5px] leading-relaxed text-slateink-400">
          Anything else, call {practice} on{' '}
          <a href={`tel:${view.practice.phone}`} className="text-brand-700 hover:underline">
            {view.practice.phone}
          </a>
          . {isClass ? 'If you would rather not hear about places, say so and we will take you off the list.' : 'If you would rather not hear about freed slots, say so and we will take you off the list.'}
        </p>
      )}
    </main>
  );
}
