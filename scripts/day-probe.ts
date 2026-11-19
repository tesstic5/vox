#!/usr/bin/env npx tsx
/**
 * A6 — the day view, exercised against the live store.
 *
 * The day view's interesting behaviour is not the rendering, it is the rules:
 * who a login resolves to, what a login without a practitioner record is told,
 * which colleague's day an owner may read, and what happens when two logins
 * want the same record. None of that is visible from a unit test of a pure
 * function, so this probe drives the real module against the real workspace.
 *
 *   npx tsx scripts/day-probe.ts           # run it, then put everything back
 *   npx tsx scripts/day-probe.ts --json    # the same, machine-readable
 *
 * Nothing is created. The only writes are the link state (restored in a
 * `finally`) and the audit lines saying a link did or did not happen — which
 * are true, and are the point.
 */
import { list } from '../lib/server/db';
import { dayViewFor, linkProviderToUser, providerForUser } from '../lib/server/day';
import { practiceProfile } from '../lib/server/practice';
import { dateStrIn, zonedToUtc } from '../lib/server/availability';

const ORG = process.env.VOXERA_ORG ?? 'org_3b5dd38bbd095dd5';
const JSON_OUT = process.argv.includes('--json');

type UserRow = { id: string; email: string; role: string; name?: string; orgId?: string };
type ProviderRow = { id: string; name: string; active?: boolean; userId?: string | null; orgId?: string };

const users = list<UserRow>('users', (u) => u.orgId === ORG);
const providers = list<ProviderRow>('providers', (p) => p.orgId === ORG && p.active !== false);
const owner = users.find((u) => u.role === 'owner') ?? users[0];
const desk = users.find((u) => u.role === 'receptionist') ?? users.find((u) => u.id !== owner?.id);
const mine = providers.find((p) => /Priya/.test(p.name)) ?? providers[0];
const theirs = providers.find((p) => p.id !== mine?.id);
if (!owner || !desk || !mine || !theirs) {
  console.error('probe needs an owner, a receptionist and two practitioners in this workspace');
  process.exit(2);
}

const before = list<ProviderRow>('providers', (p) => p.orgId === ORG).map((p) => ({ id: p.id, userId: p.userId ?? null }));
const today = dateStrIn('America/New_York', Date.now());
const profile = practiceProfile(ORG);

const out: Record<string, unknown> = {};
const say = (label: string, value: unknown) => {
  out[label] = value;
  if (!JSON_OUT) console.log(`${label}: ${JSON.stringify(value)}`);
};

/** Put the workspace's link state back exactly as it was found. */
function restore() {
  for (const row of before) {
    const live = list<ProviderRow>('providers', (p) => p.id === row.id)[0];
    if (!live) continue;
    const nowUserId = live.userId ?? null;
    if (nowUserId === row.userId) continue;
    if (nowUserId) {
      // detach whatever holds it (the module's unlink is by login, not by record)
      linkProviderToUser(ORG, { providerId: null, userId: nowUserId, actor: 'day-probe', actorRole: 'owner' });
    }
    if (row.userId) {
      linkProviderToUser(ORG, { providerId: row.id, userId: row.userId, actor: 'day-probe', actorRole: 'owner' });
    }
  }
}

try {
  say('org', ORG);
  say('date', today);
  say('logins', users.map((u) => `${u.email} (${u.role})`));
  say('practitioners', providers.map((p) => `${p.name}${p.userId ? ` → ${p.userId}` : ''}`));
  say('hints', {
    minNoticeMinutes: profile.minNoticeMinutes,
    slotStepMinutes: profile.slotStepMinutes,
    maxAdvanceDays: profile.maxAdvanceDays,
  });

  // 1. a login with no practitioner record: honest degradation, never somebody else's diary
  const unlinked = dayViewFor(ORG, {
    userId: desk?.id,
    email: desk?.email,
    role: desk?.role,
    auth: 'session',
    actor: desk?.email,
    date: today,
    days: 3,
  });
  say('unlinked login', {
    linked: unlinked.linked,
    provider: unlinked.provider?.name ?? null,
    rows: unlinked.rows.length,
    candidates: unlinked.link?.candidates.map((c) => `${c.name}${c.taken ? ' (taken)' : ''}`),
    canLink: unlinked.link?.canLink,
  });

  // 2. an API key has no practitioner identity — and says so instead of guessing
  const keyed = dayViewFor(ORG, { auth: 'key', role: undefined, actor: 'api-key', date: today, days: 1 });
  say('API key, no providerId', {
    linked: keyed.linked,
    keyed: keyed.viewer.keyed,
    rows: keyed.rows.length,
    canLink: keyed.link?.canLink,
  });

  // 3. …but with a providerId it is a usable read, for integrations
  const keyedOne = dayViewFor(ORG, { auth: 'key', role: undefined, actor: 'api-key', providerId: mine.id, date: today, days: 1 });
  say('API key with providerId', {
    provider: keyedOne.provider?.name ?? null,
    allowed: keyedOne.requested?.allowed,
    rows: keyedOne.rows.map((r) => ({
      date: r.date,
      working: r.working,
      hoursFrom: r.hoursFrom,
      hours: r.hours ? `${r.hours.from}–${r.hours.to}` : null,
      appointments: r.appointments.length,
      freeMinutes: r.free.freeMinutes,
      bookableMinutes: r.free.bookableMinutes,
      pastMinutes: r.free.pastMinutes,
    })),
  });

  // 4. link the owner to the practitioner they are — self-link, whatever the role
  say('link mine', linkProviderToUser(ORG, { providerId: mine.id, userId: owner.id, actor: owner.email, actorId: owner.id, actorRole: owner.role }));

  const priv = dayViewFor(ORG, {
    userId: owner.id,
    email: owner.email,
    role: owner.role,
    auth: 'session',
    actor: owner.email,
    date: today,
    days: 3,
  });
  const lunch = priv.rows[0]?.breaks?.[0];
  say('my day', {
    provider: priv.provider?.name,
    linked: priv.linked,
    viewer: priv.viewer,
    rows: priv.rows.map((r) => ({
      date: r.date,
      weekday: r.weekday,
      working: r.working,
      hoursFrom: r.hoursFrom,
      hours: r.hours ? `${r.hours.from}–${r.hours.to}` : null,
      now: r.nowLocal,
      appointments: r.appointments.length,
      counts: r.counts,
      bookedMinutes: r.bookedMinutes,
      gaps: r.free.gaps.map((g) => ({
        at: `${g.local}–${g.endsLocal}`,
        minutes: g.minutes,
        bookable: g.bookable,
        reason: g.reason,
        shortByMinutes: g.shortByMinutes,
        past: g.past,
      })),
      freeMinutes: r.free.freeMinutes,
      bookableMinutes: r.free.bookableMinutes,
      pastMinutes: r.free.pastMinutes,
      conflicts: r.conflicts.length,
      alerts: r.alerts.map((a) => a.label),
    })),
    totals: priv.totals,
    week: priv.week.map((w) => `${w.date}${w.working ? ` ${w.hours?.from}–${w.hours?.to}` : ' off'} (${w.appointments})`),
  });

  // 5. the lunch break is not free time — the whole point of reading the rota properly.
  //    Compared as instants, never as clock strings: `"11:59 AM" < "1:00 PM"` is
  //    false in JavaScript and true in the day a clinic actually runs.
  const minutesOfClock = (clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return h * 60 + m;
  };
  const instant = (date: string, clock: string, tz: string) => {
    const [y, mo, d] = date.split('-').map(Number);
    return zonedToUtc(y, mo, d, Math.floor(minutesOfClock(clock) / 60), minutesOfClock(clock) % 60, tz);
  };
  const breakCheck = priv.rows
    .filter((r) => r.working)
    .map((r) => {
      const breakSpans = r.breaks.map((b) => [instant(r.date, b.from, r.timezone), instant(r.date, b.to, r.timezone)] as const);
      const intoBreak = r.free.gaps.filter((g) => {
        const from = Date.parse(g.startsAt);
        const to = Date.parse(g.endsAt);
        return breakSpans.some(([bs, be]) => from < be && bs < to);
      });
      const windowMinutes = r.hours
        ? minutesOfClock(r.hours.to) - minutesOfClock(r.hours.from)
        : 0;
      const breakMinutes = r.breaks.reduce((n, b) => n + (minutesOfClock(b.to) - minutesOfClock(b.from)), 0);
      return {
        date: r.date,
        windowMinutes,
        breakMinutes,
        bookedMinutes: r.bookedMinutes,
        freeMinutes: r.free.freeMinutes,
        // free == open hours − breaks − what is booked, and nothing else
        arithmeticAddsUp: r.free.freeMinutes + r.bookedMinutes + breakMinutes === windowMinutes,
        gapsInsideTheBreak: intoBreak.length,
      };
    });
  say('break honoured', {
    break: lunch ? `${lunch.from}–${lunch.to} ${lunch.label ?? ''}`.trim() : null,
    rows: breakCheck,
    everyRowAddsUp: breakCheck.every((r) => r.arithmeticAddsUp && r.gapsInsideTheBreak === 0),
  });

  // 6. a colleague's day: the desk is refused, the owner is allowed — and both are told
  const asDesk = dayViewFor(ORG, {
    userId: desk?.id,
    email: desk?.email,
    role: desk?.role,
    auth: 'session',
    actor: desk?.email,
    providerId: theirs?.id,
    date: today,
    days: 1,
  });
  say('receptionist asks for a colleague', {
    provider: asDesk.provider?.name ?? null,
    requested: asDesk.requested,
    rows: asDesk.rows.length,
  });
  const asOwner = dayViewFor(ORG, {
    userId: owner.id,
    email: owner.email,
    role: owner.role,
    auth: 'session',
    actor: owner.email,
    providerId: theirs?.id,
    date: today,
    days: 1,
  });
  say('owner asks for a colleague', {
    provider: asOwner.provider?.name ?? null,
    requested: asOwner.requested,
    rows: asOwner.rows.map((r) => ({ date: r.date, appointments: r.appointments.length, alerts: r.alerts.length })),
  });

  // 7. a record another login holds cannot be taken silently, by anyone
  say('second login tries to claim a held record', linkProviderToUser(ORG, {
    providerId: mine.id,
    userId: desk.id,
    actor: desk.email,
    actorId: desk.id,
    actorRole: desk.role,
  }));

  // 8. …but a login may attach a free record to itself, and detach it again
  const selfLink = linkProviderToUser(ORG, { providerId: theirs.id, userId: desk.id, actor: desk.email, actorId: desk.id, actorRole: desk.role });
  say('desk attaches a free record to itself', selfLink);
  say('desk now resolves to', providerForUser(ORG, desk.id, desk.email)?.name ?? null);
  say('and its day is now real', dayViewFor(ORG, { userId: desk.id, email: desk.email, role: desk.role, auth: 'session', actor: desk.email, date: today, days: 1 }).rows.map((r) => ({ date: r.date, appointments: r.appointments.length })));
  const off1 = linkProviderToUser(ORG, { providerId: null, userId: desk.id, actor: desk.email, actorId: desk.id, actorRole: desk.role });
  const off2 = linkProviderToUser(ORG, { providerId: null, userId: desk.id, actor: desk.email, actorId: desk.id, actorRole: desk.role });
  say('unlink', { first: off1, second: off2, resolvesTo: providerForUser(ORG, desk.id, desk.email)?.name ?? null });
} finally {
  restore();
  const after = list<ProviderRow>('providers', (p) => p.orgId === ORG).map((p) => ({ id: p.id, userId: p.userId ?? null }));
  const key = (rows: { id: string; userId: string | null }[]) => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  const same = key(before) === key(after);
  say('link state restored', same);
  if (JSON_OUT) console.log(JSON.stringify(out, null, 1));
  if (!same) {
    console.error('link state NOT restored — inspect providers.userId');
    process.exitCode = 1;
  }
}
