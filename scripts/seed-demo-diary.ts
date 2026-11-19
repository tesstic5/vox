/**
 * seed-demo-diary.ts — the demo workspace, made to look like a practice
 * that has been running for a month.
 *
 * PRACTICE.md §10, Risk 3 ("demo coherence"): every phase built real screens,
 * and the demo they opened onto was written before any of them existed. The
 * seeded diary was a single week in the past with no site and no room, so a
 * clinic owner opening Northwind saw: an empty calendar today, a two-site
 * switcher that filtered to nothing, rooms that were never used, a utilisation
 * figure of 0%, and revenue with no rhythm in it. The screens were honest; the
 * *data* was the part that was not.
 *
 * This script gives the demo the thing it was missing: a live workspace.
 *
 *   - appointments that already exist but carry no site get one, chosen from
 *     the practitioner's own rota (and a room at that site, if one is free);
 *   - a month of visits is built on both sites — the four weeks behind and the
 *     ten days ahead — placed *through the diary's own rules* (`windowVerdict`
 *     via `isFree`, `freeRoomFor` for the room), so the demo can never show a
 *     visit on a closed day, outside the rota, or two people in one room;
 *   - statuses follow the clock: what has happened is completed (a few did not
 *     turn up, one or two were cancelled), what is happening is arriving, and
 *     what is ahead is booked;
 *   - work that was done is billed and mostly paid, so revenue, attendance and
 *     utilisation are all computed from rows that exist;
 *   - every visit names its source (phone, web page, front desk, integration),
 *     which is what makes the attribution report a comparison rather than a
 *     single bar.
 *
 * It is deterministic (the same day and practitioner always produce the same
 * diary), idempotent (it refuses to run twice: the rows it writes carry its own
 * tag), never deletes anything, and prints what it would do before doing it.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-diary.ts                 # dry run (default)
 *   npx tsx scripts/seed-demo-diary.ts --apply
 *   npx tsx scripts/seed-demo-diary.ts --apply --org org_1234
 *
 * Run it with the app stopped, like the other data scripts: the store is a file
 * and a running server would be reading it while this writes.
 */

import { flushNow, get, list, type Doc } from '../lib/server/db';
import { addDays, dateStrIn, isFree, windowsForDate, zoneParts, zonedToUtc } from '../lib/server/availability';
import { createService, locationsFor, providersFor, servicesFor, updateProvider, type LocationDoc, type ProviderDoc, type ServiceDoc } from '../lib/server/practice';
import { bookingsFor, upsertBooking, type BookingDoc } from '../lib/server/bookings';
import { clientsFor, type ClientDoc } from '../lib/server/clients';
import { invoiceFromBooking, issueInvoice, moneySettingsFor, recordPayment } from '../lib/server/money';
import { freeRoomFor } from '../lib/server/rooms';
import { createClassSession, joinClassSession, classSessionsFor, seatsFor } from '../lib/server/classes';
import { classWaiters, joinClassWaitList, MAX_CLASS_WAITERS } from '../lib/server/class-waitlist';
import { seedTemplatesForOrg } from '../lib/server/templates';

const apply = process.argv.includes('--apply');
const orgArgIndex = process.argv.indexOf('--org');
const ORG_ARG = orgArgIndex >= 0 ? process.argv[orgArgIndex + 1] : undefined;

/** Stamped on everything this script writes, so a second run is a no-op. */
const RUN_TAG = 'demo-diary-v1';

const DAYS_BEHIND = 27;
const DAYS_AHEAD = 10;
/**
 * How hard each practitioner's day is worked.
 *
 * Roughly one visit per 90 minutes of rota, capped — a clinic looks *busy*, not
 * full, and the gap between appointments is what makes a calendar readable. A
 * back-to-back diary would also flatter every utilisation figure on the reports
 * screen, which is the opposite of what a demo should do.
 */
const MINUTES_PER_VISIT = 90;
/** A day a visitor opens should read as a day: at least this many live visits. */
const TODAY_MIN_VISITS = 5;
const MAX_VISITS_PER_WINDOW = 4;
const JITTER_MINUTES = 20;
/** Sources a real diary actually fills up from, weighted the way one does. */
const SOURCES: [string, number][] = [
  ['call', 0.34],
  ['online', 0.26],
  ['dashboard', 0.26],
  ['client_api', 0.14],
];

type Report = {
  sitedAppointments: number;
  classSessions: number;
  classSeats: number;
  classSeatPlan?: number;
  todayAdded: number;
  /** Seats and waiters written for the demo's full class (phase 3b). */
  classQueue?: number;
  /** Appointments that were sitting outside every rota and were moved into one. */
  relocated: number;
  roomsGiven: number;
  created: number;
  byStatus: Record<string, number>;
  invoiced: number;
  paid: number;
  byDay: Map<string, number>;
  skippedDays: string[];
};

/* ------------------------------------------------------------------ helpers */

/** Deterministic PRNG: the same workspace always gets the same diary. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rows: [T, number][], roll: number): T {
  let total = 0;
  for (const [, weight] of rows) total += weight;
  let at = roll * total;
  for (const [value, weight] of rows) {
    at -= weight;
    if (at <= 0) return value;
  }
  return rows[rows.length - 1][0];
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const parseClock = (value: string) => {
  const [h, m] = String(value).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * The first hour this practitioner is actually working at this site, searching
 * forward from a date. `isFree` does the thinking: it knows the rota, the lunch
 * break, one-off days off and everything already booked, so an appointment moved
 * here cannot collide with one placed a moment earlier.
 */
function firstLegalStart(input: {
  orgId: string;
  providerId: string;
  site: LocationDoc;
  from: string;
  durationMinutes: number;
  serviceId?: string;
  ignoreBookingId?: string;
}): number | undefined {
  for (let day = 0; day < 10; day += 1) {
    const date = addDays(input.from, day);
    const [y, m, d] = date.split('-').map(Number);
    for (const window of windowsForDate(input.orgId, input.providerId, input.site.id, date)) {
      const from = parseClock(window.start);
      const to = parseClock(window.end);
      for (let cursor = from; cursor + input.durationMinutes <= to; cursor += 15) {
        const startsAt = new Date(zonedToUtc(y, m, d, Math.floor(cursor / 60), cursor % 60, input.site.timezone)).toISOString();
        if (isFree({
          orgId: input.orgId,
          providerId: input.providerId,
          locationId: input.site.id,
          startsAt,
          durationMinutes: input.durationMinutes,
          ignoreBookingId: input.ignoreBookingId,
        }).free) {
          return Date.parse(startsAt);
        }
      }
    }
  }
  return undefined;
}

function siteOf(provider: ProviderDoc, orgId: string): LocationDoc[] {
  return locationsFor(orgId).filter((l) => l.active !== false && provider.locationIds?.includes(l.id));
}

/* --------------------------------------------------------------------- main */

async function main() {
  const demoUser = ORG_ARG
    ? undefined
    : list<Doc & { email?: string; orgId?: string }>('users', (u) => u.email === 'jordan@northwind.dev')[0];
  const orgId = ORG_ARG ?? (demoUser?.orgId as string | undefined);
  if (!orgId) {
    console.error('Could not work out which workspace to seed. Pass --org <orgId>.');
    process.exit(1);
  }
  const org = get<Doc & { name?: string }>('orgs', orgId);
  if (!org) {
    console.error(`No workspace with id ${orgId}.`);
    process.exit(1);
  }
  const report: Report = {
    sitedAppointments: 0,
    classSessions: 0,
    classSeats: 0,
    todayAdded: 0,
    relocated: 0,
    roomsGiven: 0,
    created: 0,
    byStatus: {},
    invoiced: 0,
    paid: 0,
    byDay: new Map(),
    skippedDays: [],
  };

  const providers = providersFor(orgId).filter((p) => p.active !== false);
  const services = servicesFor(orgId).filter((s) => s.active !== false);
  /**
   * The practice's clients — minus anything a check script left behind.
   *
   * The verification scripts create records with names like "Import Probe 12":
   * harmless in themselves, but a demo diary that books 'Probe Web Booked' in for
   * a service reads as unfinished. The tidy sweeps them; this makes sure the
   * seeder does not build new history on top of them in the meantime.
   */
  const clients = clientsFor(orgId).filter((c) => !/\bprobe\b|^practice check|^practice client|^import probe|^locum/i.test(String(c.name ?? '')));
  const money = moneySettingsFor(orgId);

  console.log(`${apply ? 'Seeding' : 'Would seed'} "${org.name ?? orgId}" (${orgId})`);
  console.log(`  ${providers.length} practitioner(s), ${services.length} service(s), ${clients.length} client(s), ${money.currency}`);
  if (!providers.length || !services.length || !clients.length) {
    console.error('  This workspace has no practitioners, services or clients to build a diary from.');
    process.exit(1);
  }

  /**
   * Idempotence, per step rather than for the whole run.
   *
   * The month of visits is only built once (its rows carry the tag), but the two
   * jobs that fix what was *already here* — giving appointments a site, moving
   * the ones seeded on the server's clock into working hours — are checks rather
   * than inserts: they skip anything that is already right and do nothing at all
   * the second time. Guarding the whole script would have left the workspace
   * half-correct and unreachable by the very script meant to fix it.
   */
  const already = bookingsFor(orgId, (b) => String((b.metadata as { demoDiary?: string } | undefined)?.demoDiary ?? '') === RUN_TAG);
  if (already.length) {
    console.log(`  ${already.length} appointment(s) already carry the ${RUN_TAG} tag — the month will not be built again.`);
  }

  /* --- 1. the appointments that were already here, given a site ------------ */

  /**
   * The appointments that were already here.
   *
   * They were written by the original seeder on the *server's* clock — 9am UTC,
   * which is 2am in San Francisco — so the demo carried visits in the middle of
   * the night, at hours no rota covers. Giving them a site is therefore not
   * enough: each one also has to land inside the hours its practitioner actually
   * works at that site, or the workspace is still telling a story that could
   * never have happened. A visit that is already legal is left exactly where it
   * is; one that is not keeps its day, client, service and status, and moves to
   * the first hour that is free.
   */
  // Everything the *old* seeder wrote, whether or not it has a site yet, plus
  // anything with no site at all. The rows this script creates are already legal
  // and are left alone, and a real booking made by the desk is never moved by
  // this script — only the demo's own history is.
  const orphaned = bookingsFor(
    orgId,
    (b) => String((b as { source?: string }).source ?? '') === 'seed' || !(b as { locationId?: string }).locationId
  );
  for (const booking of orphaned) {
    if (!booking.providerId) continue;
    const provider = providers.find((p) => p.id === booking.providerId);
    if (!provider) continue;
    const sites = siteOf(provider, orgId);
    if (!sites.length) continue;

    const at = new Date(String(booking.startsAt)).getTime();
    const localClock = (tz: string) => {
      const parts = zoneParts(at, tz);
      return parts.hh * 60 + parts.mm;
    };
    const durationMinutes = Number((booking as { durationMinutes?: number }).durationMinutes ?? 30);
    const offers = (site: LocationDoc, date: string) =>
      windowsForDate(orgId, provider.id, site.id, date).some((w) => {
        const clock = localClock(site.timezone);
        return clock >= parseClock(w.start) && clock + durationMinutes <= parseClock(w.end);
      });

    // The site whose rota covers that moment, or the first one they work at —
    // and an appointment that already names a site keeps it.
    const named = (booking as { locationId?: string }).locationId
      ? sites.find((candidate) => candidate.id === (booking as { locationId?: string }).locationId)
      : undefined;
    const site = named ?? sites.find((candidate) => offers(candidate, dateStrIn(candidate.timezone, at))) ?? sites[0];
    const service = booking.serviceId ? services.find((x) => x.id === booking.serviceId) : undefined;

    let startsAt = new Date(at).toISOString();
    if (!offers(site, dateStrIn(site.timezone, at))) {
      const legal = firstLegalStart({
        orgId,
        providerId: provider.id,
        site,
        from: dateStrIn(site.timezone, at),
        durationMinutes,
        serviceId: service?.id,
        ignoreBookingId: booking.id,
      });
      if (legal) {
        startsAt = new Date(legal).toISOString();
        report.relocated += 1;
      }
    }

    const room = freeRoomFor(orgId, {
      locationId: site.id,
      startsAt,
      durationMinutes,
      serviceId: service?.id,
      ignoreBookingId: booking.id,
    });
    report.sitedAppointments += 1;
    if (room) report.roomsGiven += 1;
    if (apply) upsertBooking({
      orgId,
      externalId: booking.externalId,
      customer: booking.customer,
      service: booking.service,
      startsAt,
      durationMinutes,
      status: booking.status,
      providerId: provider.id,
      serviceId: service?.id,
      locationId: site.id,
      roomId: room?.id,
      clientId: (booking as { clientId?: string }).clientId,
      source: (booking as { source?: string }).source as never,
      metadata: booking.metadata,
    });
  }

  /* --- 2. a month of visits, on both sites, inside the rota ---------------- */

  const today = dateStrIn(locationsFor(orgId)[0]?.timezone ?? 'UTC');
  const days: string[] = [];
  for (let i = -DAYS_BEHIND; i <= DAYS_AHEAD; i += 1) days.push(addDays(today, i));

  const usedToday = new Map<string, number>(); // `${date}|${clientId}` → starts, clash guard
  const dayPattern: [string, number][] = [
    ['completed', 0.9],
    ['no_show', 0.06],
    ['cancelled', 0.04],
  ];

  for (const date of already.length ? [] : days) {
    const isPast = date < today;
    const isToday = date === today;
    let placed = 0;

    for (const provider of providers) {
      const offered = services.filter((s) => !provider.serviceIds?.length || provider.serviceIds.includes(s.id));
      if (!offered.length) continue;

      for (const site of siteOf(provider, orgId)) {
        const windows = windowsForDate(orgId, provider.id, site.id, date);
        const localNow = parseClock(
          new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: site.timezone, hour12: false })
        );

        for (const window of windows) {
          const roll = rng(`${RUN_TAG}|${provider.id}|${site.id}|${date}|${window.start}`);
          const from = parseClock(window.start);
          const to = parseClock(window.end);
          const span = to - from;
          // Spread the visits through the window rather than stacking them at
          // nine o'clock: a real day has a shape.
          const target = Math.max(1, Math.min(MAX_VISITS_PER_WINDOW, Math.floor(span / MINUTES_PER_VISIT)));

          for (let i = 1; i <= target; i += 1) {
            const jitter = Math.round((roll() * 2 - 1) * JITTER_MINUTES);
            const cursor = Math.max(from, Math.min(to - 15, from + Math.round((span * i) / (target + 1)) + jitter));
            const service = offered[Math.floor(roll() * offered.length) % offered.length];
            const duration = Number(service.durationMinutes ?? 30);
            if (cursor + duration > to) continue;

            const [y, m, d] = date.split('-').map(Number);
            const startsAt = new Date(zonedToUtc(y, m, d, Math.floor(cursor / 60), cursor % 60, site.timezone)).toISOString();
            if (!isFree({ orgId, providerId: provider.id, locationId: site.id, startsAt, durationMinutes: duration, service }).free) continue;

            // A client, not a stranger: the practice's own list, rotated so the
            // same person is seen again — which is what a client timeline is.
            let clientIndex = Math.floor(roll() * clients.length) % clients.length;
            let client: ClientDoc | undefined;
            for (let attempt = 0; attempt < clients.length; attempt += 1) {
              const candidate = clients[(clientIndex + attempt) % clients.length];
              const taken = usedToday.get(`${date}|${candidate.id}`);
              if (taken === undefined || Math.abs(taken - cursor) >= 120) {
                client = candidate;
                break;
              }
            }
            client ??= clients[clientIndex];
            usedToday.set(`${date}|${client.id}`, cursor);

            /**
             * The status follows the clock, because that is what a real diary
             * looks like at any moment: the morning is written up, somebody is in
             * the room now, the afternoon is booked, and a few visits did not
             * happen the way they were planned.
             */
            const finalStatus = isPast
              ? pickWeighted(dayPattern, roll())
              : isToday
                ? cursor + duration <= localNow
                  ? 'completed'
                  : cursor <= localNow + 45
                    ? 'arrived'
                    : 'confirmed'
                : roll() < 0.06
                  ? 'pending'
                  : 'confirmed';

            const billable = finalStatus === 'completed' && Number(service.price ?? 0) > 0;
            const settles = billable && roll() < 0.78;
            const source = pickWeighted(SOURCES, roll());

            report.created += 1;
            report.byStatus[finalStatus] = (report.byStatus[finalStatus] ?? 0) + 1;
            report.byDay.set(date, (report.byDay.get(date) ?? 0) + 1);
            if (billable) report.invoiced += 1;
            if (settles) report.paid += 1;
            placed += 1;

            if (!apply) continue;

            const created = upsertBooking({
              orgId,
              externalId: `NW-${date.replace(/-/g, '')}-${clock(cursor).replace(':', '')}-${provider.name.split(' ')[1] ?? provider.id.slice(-4)}`,
              customer: { name: client.name, number: client.number, email: client.email },
              clientId: client.id,
              service: service.name,
              serviceId: service.id,
              providerId: provider.id,
              locationId: site.id,
              startsAt,
              durationMinutes: duration,
              value: service.price,
              status: finalStatus as BookingDoc['status'],
              source: source as never,
              metadata: { demoDiary: RUN_TAG },
            });

            // Work that was done gets billed, and most of it gets paid: the money
            // screens should read like a practice's books, not a plan.
            if (!billable) continue;
            const raised = invoiceFromBooking({ orgId, bookingId: created.booking.id, actor: 'seed', actorName: 'Demo diary (seed)' });
            if (!raised.ok) continue;
            const issued = issueInvoice({ orgId, id: raised.value.id, issueDate: date, actor: 'seed', actorName: 'Demo diary (seed)' });
            if (!issued.ok) continue;
            if (settles) {
              recordPayment({
                orgId,
                clientId: client.id,
                invoiceId: raised.value.id,
                method: roll() < 0.6 ? 'card' : roll() < 0.5 ? 'cash' : 'bank_transfer',
                reference: issued.value.number,
                source: 'seed' as never,
                actor: 'seed',
                actorName: 'Demo diary (seed)',
                at: new Date(new Date(startsAt).getTime() + 3_600_000).toISOString(),
              });
            }
          }
        }
      }
    }
    if (!placed) report.skippedDays.push(date);
  }

  /* --- 2b. today is alive --------------------------------------------------- */

  /**
   * A demo has an awkward physics problem: it is seeded on one day and opened on
   * another. The month behind is written relative to the seeding date, so a day
   * later "today" is yesterday — and the screen a visitor actually opens (the
   * day's diary) is thin or empty. That is the same dishonesty this script exists
   * to fix, just on a delay.
   *
   * So every run tops *today* up to a readable day: at least `TODAY_MIN_VISITS`
   * live visits across the sites, placed through `isFree` like everything else,
   * deterministically per (date, provider, site, window), with statuses that
   * follow the clock. It is idempotent: a day that already has the visits gets
   * nothing, so running the script twice changes nothing, and running it again
   * tomorrow fills tomorrow.
   */
  {
    const target = TODAY_MIN_VISITS;
    let liveToday = 0;
    const siteList = locationsFor(orgId).filter((l) => l.active !== false);
    for (const site of siteList) {
      const date = dateStrIn(site.timezone);
      const rows = bookingsFor(orgId, (b) => (b as { locationId?: string }).locationId === site.id && dateStrIn(site.timezone, Date.parse(String(b.startsAt))) === date && b.status !== 'cancelled');
      liveToday += rows.length;
    }
    if (liveToday < target) {
      let placed = 0;
      const wanted = target - liveToday;
      for (const site of siteList) {
        if (placed >= wanted) break;
        const date = dateStrIn(site.timezone);
        const localNow = parseClock(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: site.timezone, hour12: false }));
        for (const provider of providers) {
          if (placed >= wanted) break;
          if (!siteOf(provider, orgId).some((s) => s.id === site.id)) continue;
          const offered = services.filter((s) => !provider.serviceIds?.length || provider.serviceIds.includes(s.id));
          if (!offered.length) continue;
          for (const window of windowsForDate(orgId, provider.id, site.id, date)) {
            if (placed >= wanted) break;
            const roll = rng(`${RUN_TAG}|today|${provider.id}|${site.id}|${date}|${window.start}`);
            const from = parseClock(window.start);
            const to = parseClock(window.end);
            for (let cursor = from; cursor + 30 <= to && placed < wanted; cursor += 30) {
              // Later in the day first: a demo opened in the morning should show a
              // day still to come, not one already finished.
              if (cursor + 30 < localNow) continue;
              const service = offered[Math.floor(roll() * offered.length) % offered.length];
              const duration = Number(service.durationMinutes ?? 30);
              if (cursor + duration > to) continue;
              const [y, m, d] = date.split('-').map(Number);
              const startsAt = new Date(zonedToUtc(y, m, d, Math.floor(cursor / 60), cursor % 60, site.timezone)).toISOString();
              if (!isFree({ orgId, providerId: provider.id, locationId: site.id, startsAt, durationMinutes: duration, service }).free) continue;
              const client = clients[Math.floor(roll() * clients.length) % clients.length];
              placed += 1;
              report.todayAdded += 1;
              if (!apply) continue;
              upsertBooking({
                orgId,
                externalId: `NW-T-${date.replace(/-/g, '')}-${clock(cursor).replace(':', '')}-${provider.id.slice(-4)}`,
                customer: { name: client.name, number: client.number, email: client.email },
                clientId: client.id,
                service: service.name,
                serviceId: service.id,
                providerId: provider.id,
                locationId: site.id,
                startsAt,
                durationMinutes: duration,
                value: service.price,
                status: 'confirmed',
                source: pickWeighted(SOURCES, roll()) as never,
                metadata: { demoDiary: `${RUN_TAG}-today` },
              });
            }
          }
        }
      }
      if (placed) console.log(`  ${apply ? 'added' : 'would add'} ${placed} visit(s) to today — a demo opened on a thin day still looks like a practice`);
    }
  }

  /* --- 3. the classes the practice runs ------------------------------------ */

  /**
   * A week with a class in it, at each site that has somebody to run it.
   *
   * Without this the newest feature in the product is invisible in the demo: no
   * card on the public page, nothing on the desk's class list, nothing on the
   * board — a visitor could be forgiven for thinking a group appointment was
   * something the software does not do. Two standing sessions a site a week is
   * also what a real practice looks like: a weekday evening group and a quiet
   * morning one.
   *
   * Everything here goes *through the product's own rules* rather than around
   * them: `createClassSession` checks the rota, the room and the clash engine,
   * picks a free room, and refuses a time that is taken; `joinClassSession` seats
   * real clients from the practice's own list. Nothing is written directly to the
   * store, so a demo class can never sit on top of a real appointment, and the
   * seats are ordinary bookings afterwards — reminders, records and money treat
   * them exactly like any other visit.
   *
   * Idempotent the same way the diary is: it refuses to run if the workspace
   * already has class sessions, so a second `--apply` changes nothing.
   */
  /**
   * The class itself. Northwind is a services company, so it has no group
   * appointment in its catalogue yet — and a demo that promises classes it cannot
   * point at would be the same dishonesty the original seeder was written to fix.
   * The service is created through `createService` (the same call the services
   * screen uses), the instructor is linked to it through `updateProvider`, and
   * `createClassSession` then sets its capacity the way the product does when a
   * session is first scheduled. Nothing is written behind the API's back.
   */
  const CLASS_SERVICE = { name: 'Group session', durationMinutes: 60, price: 25 };
  const CLASS_PLAN: { hour: number; minute: number; dayOffset: number; capacity: number }[] = [
    { hour: 17, minute: 0, dayOffset: 2, capacity: 8 },
    { hour: 10, minute: 30, dayOffset: 8, capacity: 6 },
    { hour: 16, minute: 0, dayOffset: 5, capacity: 8 },
  ];
  const existingSessions = classSessionsFor(orgId);
  /** Which sessions this run made — the only ones its own seat tally can be held against. */
  const sessionsThisRun = new Set<string>();
  // Top up rather than seed once: the plan is relative to *today*, so an
  // only-if-none rule lets every seeded session slide into the past until
  // the demo practice runs no classes at all. A plan slot that already has
  // its session (same site, same start) is skipped; a missing one is added.
  const existingStarts = new Set(existingSessions.map((s) => `${s.locationId}|${s.startsAt}`));
  if (existingSessions.length) {
    console.log(`  ${existingSessions.length} class session(s) already on the diary — topping up any plan slot that has slid into the past.`);
  }
  {
    /**
     * A dry run has to be able to *describe* the class without inventing records,
     * so it count-checks against a phantom of the service it would create. The id
     * is never written anywhere in that mode.
     */
    let classService =
      services.find((x) => x.name === CLASS_SERVICE.name) ?? services.find((x) => Number((x as { capacity?: number }).capacity ?? 0) >= 2);
    const phantom = { id: '(would create)', name: CLASS_SERVICE.name, durationMinutes: CLASS_SERVICE.durationMinutes, price: CLASS_SERVICE.price, active: true } as unknown as ServiceDoc;
    const serviceFor = (): ServiceDoc => classService ?? phantom;
    for (const site of locationsFor(orgId).filter((l) => l.active !== false)) {
      const crew = providers.filter((p) => siteOf(p, orgId).some((s) => s.id === site.id));
      if (!crew.length) continue;
      for (const plan of CLASS_PLAN) {
        const date = addDays(today, plan.dayOffset);
        const [y, m, d] = date.split('-').map(Number);
        const startsAt = new Date(zonedToUtc(y, m, d, plan.hour, plan.minute, site.timezone)).toISOString();
        if (existingStarts.has(`${site.id}|${startsAt}`)) continue;

        if (!apply) {
          report.classSessions += 1;
          report.classSeatPlan = (report.classSeatPlan ?? 0) + Math.max(2, Math.round(plan.capacity * 0.4));
          continue;
        }
        if (!classService) {
          classService = createService(
            orgId,
            { name: CLASS_SERVICE.name, durationMinutes: CLASS_SERVICE.durationMinutes, price: CLASS_SERVICE.price, description: 'A place in a group session — seats are sold, not times.' },
            'seed'
          );
        }
        const mine = classService;
        /**
         * Whoever runs it has to be down for it: the product refuses a session
         * with an instructor who does not offer the service, and the demo must not
         * be seeded into a state the desk could not have reached by hand. So the
         * first person who works at the site is linked to the class — through
         * `updateProvider`, the same call the team screen makes.
         */
        // Whoever is actually working then. Putting a 5pm class on the rota of
        // somebody whose day ends at four is the kind of thing the product refuses
        // — and rightly — so the seeder asks the same question the product does.
        const planStart = plan.hour * 60 + plan.minute;
        const working = crew.filter((p) =>
          windowsForDate(orgId, p.id, site.id, date).some((w) => planStart >= parseClock(w.start) && planStart + CLASS_SERVICE.durationMinutes <= parseClock(w.end))
        );
        const candidates = working.length ? working : crew;
        let instructor = candidates.find((p) => !p.serviceIds?.length || p.serviceIds.includes(mine.id));
        if (!instructor) {
          instructor = candidates[0];
          updateProvider(orgId, instructor.id, { serviceIds: [...(instructor.serviceIds ?? []), mine.id] }, 'seed');
        }
        const verdict = isFree({ orgId, providerId: instructor.id, locationId: site.id, startsAt, durationMinutes: CLASS_SERVICE.durationMinutes, service: mine });
        if (!verdict.free) {
          console.log(`  class skipped at ${site.name} on ${date}: ${verdict.reason ?? 'that time is taken'}`);
          continue;
        }
        const result = createClassSession({
          orgId,
          actor: 'seed',
          actorName: 'Demo diary (seed)',
          serviceId: mine.id,
          providerId: instructor.id,
          locationId: site.id,
          startsAt,
          capacity: plan.capacity,
          notes: 'Standing class — book a place at the front desk or online.',
        });
        if (!result.ok) {
          console.log(`  class skipped at ${site.name} on ${date}: ${result.message}`);
          continue;
        }
        const session = result.sessions[0];
        sessionsThisRun.add(session.id);
        report.classSessions += 1;
        report.classSeatPlan = (report.classSeatPlan ?? 0) + Math.max(2, Math.round(plan.capacity * 0.4));

        /**
         * People in it, from the practice's own list, each in a different class so
         * the roster reads like a roster. A seat is a booking, so the client gets
         * the confirmation they would get for any visit — nothing else has to be
         * faked for the class to look real on the board, the diary or the reports.
         */
        const size = Math.max(2, Math.round(plan.capacity * 0.4));
        const guests = clients
          .filter((c) => !usedToday.get(`${date}|${c.id}`))
          .slice(0, size);
        for (const [index, guest] of guests.entries()) {
          const seat = joinClassSession({
            orgId,
            session: classSessionsFor(orgId, (x) => x.id === session.id)[0],
            clientId: guest.id,
            consentSms: true,
            source: 'dashboard',
            actorName: 'Demo diary (seed)',
          });
          if (seat.ok) {
            report.classSeats += 1;
            usedToday.set(`${date}|${guest.id}`, plan.hour * 60 + index);
          }
        }
      }
    }
  }

  /* --- 3b. a full class, with a line for the place ------------------------- */

  /**
   * A wait list only exists where somebody is waiting.
   *
   * Without this the feature is invisible in the demo: the desk's panel is always
   * empty, the public card never says "Full", and the queue is something the
   * product claims rather than does. So the demo gets one small class that is
   * **full**, and a person in line behind it — created through the same calls the
   * screens make (`createClassSession`, `joinClassSession`, `joinClassWaitList`),
   * so nothing here is a state the desk could not have reached by hand.
   *
   * Idempotent: a workspace that already has a full class with somebody waiting
   * gets nothing, and a second `--apply` changes nothing.
   */
  {
    /** A name a visitor would recognise as a person, not a placeholder. */
    const properName = (client: { name?: string }) => {
      const name = String(client.name ?? '').trim();
      return /\s/.test(name) && !/^(caller|unknown|guest|client)$/i.test(name);
    };

    const upcomingFull = classSessionsFor(orgId, (s) => s.status === 'scheduled').filter(
      (s) => Date.parse(String(s.startsAt)) > Date.now() && seatsFor(orgId, s.id).length >= Number(s.capacity ?? 0)
    );
    const alreadyQueued = upcomingFull.filter((s) => classWaiters(orgId, s.id).length > 0);

    if (alreadyQueued.length) {
      // Nothing to add — the demo already shows a queue. Said out loud so a run
      // that looks like it did nothing can be read as "it did not need to".
    } else if (upcomingFull.length) {
      /**
       * A full class exists and nobody is in line behind it — which is the state a
       * demo drifts into when somebody takes the last seat by hand, or when an
       * earlier run wrote the class and not the line. Repair the line rather than
       * making a second full class: a demo with two of them is clutter.
       */
      const session = upcomingFull[0];
      const seatedIds = new Set(seatsFor(orgId, session.id).map((b) => String(b.clientId ?? '')));
      const candidate = clients.find((c) => properName(c) && !seatedIds.has(c.id)) ?? clients.find((c) => !seatedIds.has(c.id));
      if (candidate && apply) {
        const queued = joinClassWaitList({
          orgId,
          session,
          clientId: candidate.id,
          source: 'dashboard',
          actor: 'seed',
          actorName: 'Demo diary (seed)',
        });
        if (queued.ok) {
          report.classQueue = (report.classQueue ?? 0) + 1;
          console.log(`  a full class already on the diary — put ${candidate.name} in line behind it`);
        }
      } else if (!apply) {
        report.classQueue = (report.classQueue ?? 0) + 1;
      }
    } else {
      const classService =
        servicesFor(orgId).find((x) => x.name === CLASS_SERVICE.name) ??
        servicesFor(orgId).find((x) => Number((x as { capacity?: number }).capacity ?? 0) >= 2);

      if (!classService) {
        console.log('  no class service to fill — the queue was not seeded');
      } else {
        let placed = false;
        for (const site of locationsFor(orgId).filter((l) => l.active !== false)) {
          if (placed) break;
          const crew = providersFor(orgId).filter((p) => siteOf(p, orgId).some((x) => x.id === site.id));
          for (const offset of [6, 7, 9, 10, 12, 13]) {
            if (placed) break;
            const date = dateStrIn(site.timezone, Date.now() + offset * 86_400_000);
            const [y, m, d] = date.split('-').map(Number);
            for (const hour of [15, 16, 17]) {
              if (placed) break;
              const startsAt = new Date(zonedToUtc(y, m, d, hour, 0, site.timezone)).toISOString();
              const instructor = crew.find((p) => !p.serviceIds?.length || p.serviceIds.includes(classService.id));
              if (!instructor) continue;
              const verdict = isFree({ orgId, providerId: instructor.id, locationId: site.id, startsAt, durationMinutes: Number(classService.durationMinutes ?? 60), service: classService });
              if (!verdict.free) continue;

              if (!apply) {
                report.classQueue = 3;
                placed = true;
                break;
              }
              const made = createClassSession({
                orgId,
                actor: 'seed',
                actorName: 'Demo diary (seed)',
                serviceId: classService.id,
                providerId: instructor.id,
                locationId: site.id,
                startsAt,
                capacity: 2,
                notes: 'A small class, full — the front desk keeps a line for it.',
              });
              if (!made.ok) continue;
              const session = made.sessions[0];
              sessionsThisRun.add(session.id);

              // Two people in, from the practice's own list.
              const seated = [
                ...clients.filter((c) => properName(c) && !usedToday.get(`${date}|${c.id}`)),
                ...clients.filter((c) => !properName(c) && !usedToday.get(`${date}|${c.id}`)),
              ].slice(0, 2);
              for (const [index, guest] of seated.entries()) {
                const seat = joinClassSession({
                  orgId,
                  session: classSessionsFor(orgId, (x) => x.id === session.id)[0],
                  clientId: guest.id,
                  consentSms: true,
                  source: 'dashboard',
                  actorName: 'Demo diary (seed)',
                });
                if (seat.ok) {
                  report.classSeats += 1;
                  report.classQueue = (report.classQueue ?? 0) + 1;
                  usedToday.set(`${date}|${guest.id}`, hour * 60 + index);
                }
              }
              // And somebody in line behind a class that is now full.
              const inClass = new Set(seated.map((c) => c.id));
              const waiting =
                clients.find((c) => properName(c) && !inClass.has(c.id) && !usedToday.get(`${date}|${c.id}`)) ??
                clients.find((c) => !inClass.has(c.id) && !usedToday.get(`${date}|${c.id}`));
              if (waiting && seatsFor(orgId, session.id).length >= 2 && classWaiters(orgId, session.id).length < MAX_CLASS_WAITERS) {
                const queued = joinClassWaitList({
                  orgId,
                  session: classSessionsFor(orgId, (x) => x.id === session.id)[0],
                  clientId: waiting.id,
                  source: 'dashboard',
                  actor: 'seed',
                  actorName: 'Demo diary (seed)',
                });
                if (queued.ok) report.classQueue = (report.classQueue ?? 0) + 1;
              }
              placed = true;
              break;
            }
          }
        }
        if (apply && placed) console.log('  a full class with somebody in line — the queue is now something the demo does');
      }
    }

    /**
     * The message a place in a class sends has its own wording (a place goes to
     * one person, in order — "first to take it gets it" is the slot list's rule).
     * An older workspace has no template for it, and the seeder is the one place
     * that can add it without anybody re-running the whole setup.
     */
    if (apply) {
      const seeded = seedTemplatesForOrg(orgId);
      if (seeded.seeded) console.log(`  ${seeded.seeded} message template(s) added, including the one for a place in a class`);
    }
  }

  /**
   * Every seat it counted has to be a row.
   *
   * The count is kept in memory as the loop runs, so a seat that was written but
   * silently merged into another booking would leave the demo saying five people
   * are coming to a class of four. That is exactly the kind of quiet wrong number
   * a demo must not tell, so the two are compared and a mismatch is loud.
   */
  if (apply && report.classSeats) {
    /**
     * Only the sessions *this run* made are counted.
     *
     * The first version compared this run's tally against every class row in the
     * workspace, so the day the seeder gained a second class phase (the full one
     * with a queue) it reported a merge that had not happened: two seats written
     * this run against seven rows that already existed. The number to check is
     * "what I wrote" against "what I wrote", per session.
     */
    const seated = classSessionsFor(orgId)
      .filter((session) => sessionsThisRun.has(session.id))
      .reduce((sum, session) => sum + seatsFor(orgId, session.id).length, 0);
    if (seated !== report.classSeats) {
      console.error(`  MISMATCH: ${report.classSeats} seat(s) were taken but ${seated} row(s) exist — two people may have been merged into one booking.`);
      process.exit(1);
    }
  }

  /* --- 4. what it did ------------------------------------------------------ */

  const working = [...report.byDay.entries()].filter(([, count]) => count > 0).length;
  console.log('');
  if (report.sitedAppointments) {
    console.log(`  ${apply ? 'sited' : 'would site'} ${report.sitedAppointments} appointment(s) that had no site, ${report.roomsGiven} of them into a room`);
  }
  if (report.relocated) {
    console.log(`  ${apply ? 'moved' : 'would move'} ${report.relocated} of them into working hours (they were seeded on the server's clock, in the middle of the night)`);
  }
  console.log(`  ${apply ? 'created' : 'would create'} ${report.created} appointment(s) across ${working} day(s)`);
  if (report.byDay.size) {
    const todayCount = report.byDay.get(today) ?? 0;
    console.log(`  today (${today}) holds ${todayCount} visit(s); the busiest day holds ${Math.max(...report.byDay.values())}`);
  }
  console.log(`  statuses: ${Object.entries(report.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (report.todayAdded) console.log(`  ${apply ? 'added' : 'would add'} ${report.todayAdded} visit(s) to today so the day a visitor opens is a day`);
  if (report.classQueue) console.log(`  ${apply ? 'seated or queued' : 'would seat or queue'} ${report.classQueue} place(s) in the full class — the line has somebody in it`);
  console.log(`  ${apply ? 'raised' : 'would raise'} ${report.invoiced} invoice(s), ${report.paid} of them settled`);
  if (report.classSessions) {
    console.log(
      `  ${apply ? 'put on' : 'would put on'} ${report.classSessions} class session(s)` +
        (apply ? ` with ${report.classSeats} seat(s) taken` : ` with about ${report.classSeatPlan} seat(s) taken`)
    );
  }
  if (report.skippedDays.length) {
    console.log(`  ${report.skippedDays.length} day(s) left empty (nobody is on the rota): ${report.skippedDays.slice(0, 4).join(', ')}${report.skippedDays.length > 4 ? ' …' : ''}`);
  }
  if (!apply) console.log('\ndry run — pass --apply to write it');

  // The store batches writes to the next tick, so the file is written out here
  // rather than trusting the process to linger long enough to flush itself.
  if (apply) flushNow();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
