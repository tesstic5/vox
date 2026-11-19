'use client';

/**
 * Joining a class from the public page (A8).
 *
 * A class is not a time to pick — it is a thing that is happening, with places
 * left. So it is offered beside the services rather than inside the slot picker:
 * "Thursday evening yoga, 3 places left, with Priya in Studio 2". If you want a
 * *slot*, the steps below do that; if you want a *place*, this does.
 *
 * Three choices worth keeping:
 *
 *  - **Seats left are shown, and a full class is offered as a queue.** A page that
 *    hides a full class is honest only if the visitor has no way to ask for a
 *    place; this one keeps the class visible, says it is full, and puts them in
 *    line — with their position, because a queue you cannot see is one nobody
 *    trusts. The server decides all of it, and decides again on the write.
 *  - **Joining needs a name and a number, nothing else.** The practice already has
 *    the rest if it knows them, and this form is on a phone in a corridor.
 *  - **The place is confirmed like any booking**, because it *is* one: the same
 *    confirmation text, the same link to give it up.
 */

import * as React from 'react';
import { ApiError, request } from '@/lib/server-sync';
import { Button } from '@/components/ui';
import { Icons } from '@/components/icons';

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
  full?: boolean;
  local: { date: string; start: string; end: string; spoken: string; timezone: string };
};

type Waited = { position: number; already: boolean; className: string; spoken: string };

type Joined = {
  class: { sessionId: string; serviceName: string; instructor?: string; site?: string; room?: string; seatsLeft: number; capacity: number; local: PublicClass['local'] };
  booking: { id: string; reference: string; startsAt: string; status: string };
  client: { name: string };
  already: boolean;
  confirmation: { channel: string; status: string; reason?: string; queued: boolean };
  calendar: string;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Built from the payload's own `YYYY-MM-DD`, never from a parsed instant. */
function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

export function ClassJoin({ slug, classes }: { slug: string; classes: PublicClass[] }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ name: '', number: '', email: '', consentSms: true });
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [joined, setJoined] = React.useState<Joined | null>(null);
  const [waited, setWaited] = React.useState<Waited | null>(null);

  if (!classes.length) return null;

  const waitForPlace = async (sessionId: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await request<{ wait: Waited }>('POST', `/api/public/workspaces/${slug}/booking`, {
        sessionId,
        wait: true,
        name: form.name,
        number: form.number,
        email: form.email || undefined,
        consentSms: form.consentSms,
      });
      setWaited(result.wait);
      setOpenId(null);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'That did not go through. Please try again or call us.');
    } finally {
      setBusy(false);
    }
  };

  const join = async (sessionId: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await request<Joined>('POST', `/api/public/workspaces/${slug}/booking`, {
        sessionId,
        name: form.name,
        number: form.number,
        email: form.email || undefined,
        consentSms: form.consentSms,
      });
      setJoined(result);
      setOpenId(null);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'That did not go through. Please try again or call us.');
    } finally {
      setBusy(false);
    }
  };

  if (waited) {
    return (
      <section className="mt-8 rounded-2xl border border-brand-500/30 bg-brand-500/[0.06] p-5">
        <div className="flex items-center gap-2 text-[13px] uppercase tracking-[0.14em] text-brand-700">
          <Icons.check size={14} /> {waited.already ? 'You were already in line' : 'You are in line'}
        </div>
        <h2 className="mt-2 text-[17px] font-medium text-slate-900">
          {waited.className}
          <span className="text-slateink-300"> · {waited.spoken}</span>
        </h2>
        <p className="mt-1 text-[13px] text-slateink-300">
          {waited.position === 1 ? 'You are first in line' : `You are ${waited.position}${waited.position === 2 ? 'nd' : waited.position === 3 ? 'rd' : 'th'} in line`} for a
          place in this class. A place comes free, and we text you a link to take it — the first to take it
          gets it, and nothing is charged for waiting.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="text-[12.5px] text-slateink-300 hover:text-slate-900" onClick={() => setWaited(null)}>
            Back to the page
          </button>
        </div>
      </section>
    );
  }

  if (joined) {
    return (
      <section className="mt-8 rounded-2xl border border-brand-500/30 bg-brand-500/[0.06] p-5">
        <div className="flex items-center gap-2 text-[13px] uppercase tracking-[0.14em] text-brand-700">
          <Icons.check size={14} /> {joined.already ? 'You were already in' : 'Place booked'}
        </div>
        <h2 className="mt-2 text-[17px] font-medium text-slate-900">
          {joined.class.serviceName}
          <span className="text-slateink-300"> · {joined.class.local.spoken}</span>
        </h2>
        <p className="mt-1 text-[13px] text-slateink-300">
          {[joined.class.instructor, joined.class.site, joined.class.room].filter(Boolean).join(' · ')}
          {' — '}
          {joined.class.seatsLeft === 0 ? 'that was the last place' : `${joined.class.seatsLeft} place(s) left in the class`}.
        </p>
        <p className="mt-2 text-[13px] text-slateink-300">
          {joined.confirmation.queued
            ? `A text is on its way to confirm it, with a link to give your place up if you cannot make it.`
            : joined.confirmation.reason ?? 'Your place is booked.'}{' '}
          Reference <span className="font-mono text-slate-900">{joined.booking.reference}</span>.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <a className="text-[12.5px] text-brand-700 underline underline-offset-2" href={joined.calendar}>
            Add it to your calendar
          </a>
          <button type="button" className="text-[12.5px] text-slateink-300 hover:text-slate-900" onClick={() => setJoined(null)}>
            Back to the page
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <h2 className="h3">Classes you can join</h2>
      <p className="mt-1 text-[13.5px] text-slateink-400">
        Group sessions with places left. Book a place here and you get the same confirmation, and the same link to change your mind.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {classes.map((row) => (
          <div key={row.sessionId} className="rounded-2xl border border-slate-900/[0.035] bg-ink-900/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <span className="text-[14.5px] font-medium text-slate-900">{row.serviceName}</span>
              <span
                className={
                  row.seatsLeft > 0
                    ? 'whitespace-nowrap rounded-full border border-brand-600/35 bg-brand-500/[0.08] px-2 py-0.5 font-mono text-[11px] text-brand-800'
                    : 'whitespace-nowrap rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 font-mono text-[11px] text-amber-800'
                }
              >
                {row.seatsLeft > 0 ? `${row.seatsLeft} place${row.seatsLeft === 1 ? '' : 's'} left` : 'Full — join the wait list'}
              </span>
            </div>
            <p className="mt-1.5 text-[12.5px] text-slateink-300">
              {dayLabel(row.local.date)} at {row.local.start}–{row.local.end} · {row.durationMinutes} minutes
            </p>
            <p className="mt-0.5 text-[12px] text-slateink-400">
              {[row.instructor, row.site, row.room].filter(Boolean).join(' · ') || 'At the practice'}
            </p>

            {openId === row.sessionId ? (
              <div className="mt-3 space-y-2">
                <input
                  className="field w-full text-[13px]"
                  placeholder="Your name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                <input
                  className="field w-full text-[13px]"
                  placeholder="Mobile number"
                  value={form.number}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                />
                <input
                  className="field w-full text-[13px]"
                  placeholder="Email (optional)"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                <label className="flex items-start gap-2 text-[12px] text-slateink-300">
                  <input type="checkbox" checked={form.consentSms} onChange={(e) => setForm({ ...form, consentSms: e.target.checked })} className="mt-0.5" />
                  Text me about this class — {row.seatsLeft > 0 ? 'the confirmation, and anything that changes' : 'and tell me when a place comes free'}.
                </label>
                {problem ? <p className="text-[12.5px] text-amber-800">{problem}</p> : null}
                <div className="flex items-center gap-2">
                  <Button
                    variant="brand"
                    size="sm"
                    disabled={busy || form.name.trim().length < 2 || form.number.replace(/\D/g, '').length < 7}
                    onClick={() => void (row.seatsLeft > 0 ? join(row.sessionId) : waitForPlace(row.sessionId))}
                  >
                    {busy ? (row.seatsLeft > 0 ? 'Taking your place…' : 'Adding you to the line…') : row.seatsLeft > 0 ? 'Take a place' : 'Join the wait list'}
                  </Button>
                  <button
                    type="button"
                    className="text-[12.5px] text-slateink-300 hover:text-slate-900"
                    onClick={() => {
                      setOpenId(null);
                      setProblem(null);
                    }}
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setOpenId(row.sessionId);
                  setProblem(null);
                }}
              >
                {row.seatsLeft > 0 ? 'Take a place' : 'Join the wait list'}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
