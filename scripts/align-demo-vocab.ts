/**
 * align-demo-vocab.ts — one workspace's service list, said once.
 *
 * The demo diary was written before the practice layer existed: its appointments
 * name a job ("Checkup", "Site visit") in a string. When those appointments were
 * attributed to real services (`attributeSeededDiary`), the workspace briefly held
 * two vocabularies — the seeded services ("Quick check", "Installation visit",
 * "Support consultation") and the job types the diary actually books. A practice
 * with two names for one job has a booking page nobody can choose from, so this
 * script performs the merge a person would: one service per job, every reference
 * pointed at the keeper, duplicates removed, and every service offered by the
 * people who do that work.
 *
 * It refuses to touch more than one workspace, never deletes an appointment, an
 * invoice or a note, and prints what it would do before it does anything.
 *
 * Usage:
 *   npx tsx scripts/align-demo-vocab.ts                # dry run (default)
 *   npx tsx scripts/align-demo-vocab.ts --apply
 *   npx tsx scripts/align-demo-vocab.ts --apply --org org_1234
 */

import { get, list, update, remove, type Doc } from '../lib/server/db';
import { servicesFor, providersFor, type ServiceDoc } from '../lib/server/practice';
import { bookingsFor } from '../lib/server/bookings';
import { invoicesFor } from '../lib/server/money';

const apply = process.argv.includes('--apply');
const orgArg = process.argv.indexOf('--org');

/** One job, one name. Keys are what the seed called it; values are the diary's word. */
const ALIASES: Record<string, string> = {
  'quick check': 'Checkup',
  'installation visit': 'Installation',
  'support consultation': 'Consultation',
};

type Change = { kind: string; detail: string };

const changes: Change[] = [];

function resolveOrgId(): string | undefined {
  if (orgArg > -1 && process.argv[orgArg + 1]) return process.argv[orgArg + 1];
  if (process.env.VOXERA_ORG_ID) return process.env.VOXERA_ORG_ID;
  // Default: the demo workspace, matched on its slug rather than on a hardcoded id.
  const demo = list<Doc & { slug?: string }>('orgs', () => true).find((o) => String(o.slug ?? '') === 'northwind-labs');
  return demo ? demo.id : undefined;
}

function main() {
  const orgId = resolveOrgId();
  if (!orgId) {
    console.error('no workspace to align — pass --org <id> (or VOXERA_ORG_ID)');
    process.exit(2);
  }
  const org = get<Doc & { name?: string; slug?: string }>('orgs', orgId);
  if (!org) {
    console.error(`no workspace with id ${orgId}`);
    process.exit(2);
  }

  const services = servicesFor(orgId, { includeInactive: true });
  const canonical = (service: ServiceDoc) => ALIASES[service.name.trim().toLowerCase()] ?? service.name.trim();

  // Names that must merge: anything the alias map folds together, plus any exact
  // duplicate the workspace already has.
  const groups = new Map<string, ServiceDoc[]>();
  for (const service of services) {
    const key = canonical(service).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }

  const keepers = new Map<string, ServiceDoc>();
  const dropped = new Set<string>();

  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
    const [keep, ...rest] = sorted;
    keepers.set(key, keep);
    for (const extra of rest) dropped.add(extra.id);
    const from = new Set(group.map((s) => `${s.name} (${s.durationMinutes}m)`));
    if (from.size > 1 || rest.length) {
      changes.push({
        kind: 'merge',
        detail: `${[...from].join(' + ')} → ${canonical(keep)} (${keep.durationMinutes}m) · keep ${keep.id}, drop ${rest.map((s) => s.id).join(', ') || 'none'}`,
      });
    }
    if (keep.name !== canonical(keep)) {
      // The seed's placeholder name goes; the diary's word stays. Its *length*
      // comes from the job the diary actually books, because a 15-minute Checkup
      // service behind 30-minute Checkup appointments is a diary that argues with
      // itself. The price is the practice's own and is left alone.
      const named = group.find((s) => s.name.trim().toLowerCase() === canonical(keep).toLowerCase());
      const duration = named?.durationMinutes ?? keep.durationMinutes;
      changes.push({
        kind: 'rename',
        detail: `${keep.name} → ${canonical(keep)}${duration !== keep.durationMinutes ? ` · ${keep.durationMinutes}m → ${duration}m (how long the diary books it)` : ''}`,
      });
      if (apply) update<ServiceDoc>('services', keep.id, { name: canonical(keep), durationMinutes: duration } as never);
    }
  }

  // Every reference to a dropped row points at its keeper instead.
  const repoint = new Map<string, string>();
  for (const [key, group] of groups) {
    const keep = keepers.get(key)!;
    for (const service of group) if (service.id !== keep.id) repoint.set(service.id, keep.id);
  }

  let bookingsMoved = 0;
  for (const booking of bookingsFor(orgId, () => true)) {
    const current = String((booking as { serviceId?: string }).serviceId ?? '');
    const next = repoint.get(current);
    if (!next) continue;
    bookingsMoved += 1;
    if (apply) update<Doc>('bookings', booking.id, { serviceId: next } as never);
  }
  if (bookingsMoved) changes.push({ kind: 'repoint', detail: `${bookingsMoved} appointment(s) → their job's service` });

  let linesMoved = 0;
  for (const invoice of invoicesFor(orgId, { includeDrafts: true, includeVoid: true })) {
    let changed = false;
    const lines = invoice.lines.map((line) => {
      const next = line.serviceId ? repoint.get(String(line.serviceId)) : undefined;
      if (!next) return line;
      changed = true;
      linesMoved += 1;
      return { ...line, serviceId: next };
    });
    if (changed && apply) update<Doc>('invoices', invoice.id, { lines } as never);
  }
  if (linesMoved) changes.push({ kind: 'repoint', detail: `${linesMoved} invoice line(s) → their job's service` });

  let rosters = 0;
  for (const provider of providersFor(orgId, { includeInactive: true })) {
    const current = (provider.serviceIds ?? []).map(String);
    const next = [...new Set(current.map((id) => repoint.get(id) ?? id))];
    if (next.length !== current.length || next.some((id, i) => id !== current[i])) {
      rosters += 1;
      if (apply) update<Doc>('providers', provider.id, { serviceIds: next } as never);
    }
  }
  if (rosters) changes.push({ kind: 'roster', detail: `${rosters} practitioner(s) repointed to the surviving services` });

  // A service nobody offers is a service the booking page will refuse. The people
  // who have done that job are the people who offer it.
  const stillThere = services.filter((s) => !dropped.has(s.id));
  const offered = new Set(providersFor(orgId, { includeInactive: true }).flatMap((p) => (p.serviceIds ?? []).map(String)));
  for (const service of stillThere) {
    if (offered.has(service.id)) continue;
    const did = [...new Set(bookingsFor(orgId, (b) => String((b as { serviceId?: string }).serviceId ?? '') === service.id).map((b) => String((b as { providerId?: string }).providerId ?? '')).filter(Boolean))];
    const pool = did.length ? did : providersFor(orgId).map((p) => p.id);
    if (!pool.length) continue;
    changes.push({ kind: 'offer', detail: `${service.name} is offered by ${pool.length} practitioner(s) who have done it` });
    if (apply) {
      for (const providerId of pool) {
        const provider = providersFor(orgId, { includeInactive: true }).find((p) => p.id === providerId);
        if (!provider) continue;
        const next = [...new Set([...(provider.serviceIds ?? []).map(String), service.id])];
        update<Doc>('providers', provider.id, { serviceIds: next } as never);
      }
    }
  }

  if (apply) {
    for (const [key, group] of groups) {
      const keep = keepers.get(key)!;
      for (const extra of group) if (extra.id !== keep.id) remove('services', extra.id);
    }
  }

  console.log(`${org.name ?? orgId} — ${services.length} service(s), ${groups.size} job type(s)`);
  if (!changes.length) {
    console.log('nothing to do — one name per job, and every service is offered');
    return;
  }
  for (const change of changes) console.log(`  ${change.kind.padEnd(8)} ${change.detail}`);
  console.log(`\n${apply ? 'applied' : 'dry run — pass --apply to make these changes'}`);
}

main();
