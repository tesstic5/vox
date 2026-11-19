/**
 * Removes the workspaces that the HTTP probe scripts leave behind.
 *
 * `api_check.py` and `onboard_check.py` sign up a stranger to prove the flow
 * works end to end, then delete every resource they can through the API. An
 * organisation itself has no delete endpoint, so those workspaces linger: a demo
 * database slowly fills with "Sunrise Dental"-style orgs, each with calls,
 * bookings and usage rows that are not part of the story anyone is showing.
 *
 * This script clears them, and only them. It is deliberately conservative:
 *
 * It also clears the two other kinds of debris a suite sweep leaves behind:
 *
 *   - **Stale calls.** A probe opens a call, checks something, and never ends
 *     it, so call history fills with entries stuck "in progress". A call that
 *     has been in progress for hours is not a call, it is a dropped socket.
 *   - **Duplicate subscriptions.** Several checks register the same echo
 *     webhook; the workspace should show one, not a growing pile.
 *
 * And it can put back the seed number that `carrier_check.py` releases as part
 * of its run (`--restore-number`), read out of the newest backup that has it.
 *
 *   - dry run unless `--apply` is passed,
 *   - only orgs owned by a probe-looking account (example/probe/voxera.test
 *     domains), never a workspace with a real signup,
 *   - a backup of the database is written before anything is removed,
 *   - the app must be stopped, because these are edits straight to the file.
 *
 * Usage:  VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE=1 npx tsx scripts/tidy-probe-orgs.ts --apply [--restore-number]
 * (dry runs do not need the maintenance switch)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { dumpAll, replaceAll } from '../lib/server/db';
import type { Doc } from '../lib/server/db';
import { withDestructiveMaintenance } from '../lib/server/maintenance-replace';
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

/**
 * Signup domains the probe scripts use. Nothing else is ever touched.
 * `.example`, `.test` and `.invalid` are reserved by RFC 2606/6761 — a real
 * account cannot have them, which makes them a reliable marker.
 */
const PROBE_DOMAINS = ['example.com', 'voxera.test', 'localhost'];
const PROBE_TLDS = ['.example', '.test', '.invalid', '.localhost'];

type Row = Record<string, unknown> & { id?: string; orgId?: string };
type Db = { collections: Record<string, Row[]>; [key: string]: unknown };

function isProbeEmail(email: unknown): boolean {
  const address = String(email ?? '').toLowerCase();
  if (!address.includes('@')) return false;
  const [local, domain] = address.split('@');
  if (PROBE_DOMAINS.includes(domain)) return true;
  if (PROBE_TLDS.some((tld) => domain.endsWith(tld))) return true;
  return /^(probe|test|onboard|api-check)\b/.test(local);
}

function listRows(db: Db, collection: string, keep: (row: Row) => boolean): Row[] {
  return (db.collections[collection] ?? []).filter(keep);
}

function orgRefs(db: Db, orgIds: Set<string>): Array<[string, number]> {
  const tally: Array<[string, number]> = [];
  for (const [name, rows] of Object.entries(db.collections)) {
    const hit = rows.filter((row) => orgIds.has(String(row.orgId ?? ''))).length;
    if (hit > 0) tally.push([name, hit]);
  }
  return tally.sort((a, b) => b[1] - a[1]);
}

const PROBE_SCHEDULER_NAMES = new Set([
  'deliver-messages', 'campaign-tick', 'queue-reminders', 'visit-followups',
  'no-show-followups', 'overdue-chase', 'retention', 'recalls',
]);
const PROBE_TEMPLATE_NAMES = new Set([
  'Booking confirmation', 'Booking confirmation (email)', 'Reminder', 'After the visit',
  'Missed appointment', 'We have not seen you in a while', 'Freed slot', 'A place in a class',
  'A place in a class (email)', 'Freed slot (email)', 'Due for a appointment',
  'Due for a appointment (email)', 'Payment received', 'Payment received (email)',
  'Refund sent', 'Refund sent (email)', 'Invoice still open', 'Invoice still open (email)',
]);
const PROBE_TOOL_NAMES = new Set([
  'lookup_order', 'check_availability', 'book_appointment', 'reschedule_appointment',
  'cancel_appointment', 'send_confirmation', 'draft_note', 'payment_status',
  'create_payment_link', 'transfer_call',
]);
const PROBE_AUDIT_ACTIONS = new Set([
  'auth.signup', 'auth.verification_sent', 'auth.email_verified', 'assistant.version',
  'assistant.published', 'key.created', 'assistant.created',
]);

/**
 * Fingerprint a signup-gate workspace whose user row was removed by an old,
 * interrupted cleaner. The slug alone is not enough: it must be old, have no
 * login, have the matching generated name, and contain only the exact bootstrap
 * and gate fixtures those probes create. Any extra business row makes it fail
 * closed and remain untouched for a person to inspect.
 */
function isFingerprintProbeOrphan(db: Db, org: Row, users: Row[]): boolean {
  const slug = String(org.slug ?? '');
  const match = /^probe-(gate|lock)-(\d{10})$/.exec(slug);
  if (!match || users.some((user) => String(user.orgId ?? '') === String(org.id))) return false;
  const [, kind, token] = match;
  const expectedName = `Probe ${kind === 'gate' ? 'Gate' : 'Lock'} ${token}`;
  if (String(org.name ?? '') !== expectedName || org.plan !== 'build') return false;
  const created = new Date(String(org.createdAt ?? '')).getTime();
  if (!Number.isFinite(created) || created > Date.now() - 7 * 86_400_000) return false;

  const rowsFor = (collection: string) =>
    (db.collections[collection] ?? []).filter((row) => String(row.orgId ?? '') === String(org.id));
  const referenced = Object.keys(db.collections).filter((name) => rowsFor(name).length > 0);
  const allowed = kind === 'gate'
    ? new Set(['apiKeys', 'assistantVersions', 'assistants', 'audit', 'onboarding', 'scheduler', 'templates', 'tools'])
    : new Set(['audit', 'scheduler', 'templates']);
  if (referenced.some((name) => !allowed.has(name))) return false;

  const scheduler = rowsFor('scheduler');
  const templates = rowsFor('templates');
  const audit = rowsFor('audit');
  if (
    scheduler.length !== PROBE_SCHEDULER_NAMES.size ||
    scheduler.some((row) => !PROBE_SCHEDULER_NAMES.has(String(row.name ?? '')) || !String(row.id ?? '').startsWith(`job_${org.id}_`)) ||
    templates.length !== PROBE_TEMPLATE_NAMES.size ||
    templates.some((row) => !PROBE_TEMPLATE_NAMES.has(String(row.name ?? '')) || !String(row.id ?? '').startsWith('tpl_')) ||
    audit.length < 1 || audit.length > 7 || audit.some((row) => !PROBE_AUDIT_ACTIONS.has(String(row.action ?? '')))
  ) return false;

  if (kind === 'lock') return true;
  const assistants = rowsFor('assistants');
  const onboarding = rowsFor('onboarding');
  const tools = rowsFor('tools');
  const keys = rowsFor('apiKeys');
  const versions = rowsFor('assistantVersions');
  return (
    assistants.length === 1 && assistants[0].name === 'Booking desk' &&
    onboarding.length === 1 &&
    tools.length === PROBE_TOOL_NAMES.size && tools.every((row) => PROBE_TOOL_NAMES.has(String(row.name ?? ''))) &&
    keys.length <= 1 && keys.every((row) => row.name === 'probe key') &&
    versions.length <= 1 && versions.every((row) => String(row.assistantId ?? '') === String(assistants[0].id ?? ''))
  );
}

/**
 * Calls a probe opened and abandoned this session: still `in-progress`, older
 * than `STALE_CALL_MINUTES` — a quarter of an hour, past any plausible live
 * call in this environment, so a genuine one is never touched — and
 * younger than `DEBRIS_HOURS` (so the seeded history — which deliberately
 * contains in-progress calls from the fixture — is left exactly as it was).
 */
const STALE_CALL_MINUTES = 15;
const DEBRIS_HOURS = 24;

function staleCalls(db: Db): Row[] {
  const now = Date.now();
  const oldest = now - DEBRIS_HOURS * 3600 * 1000;
  const newest = now - STALE_CALL_MINUTES * 60 * 1000;
  return (db.collections.calls ?? []).filter((call) => {
    if (call.status !== 'in-progress') return false;
    const at = new Date(String(call.createdAt ?? 0)).getTime();
    return at > oldest && at < newest;
  });
}

/** The most recent backup that still contains a row with this id. */
function findInBackups(id: string): Row | undefined {
  if (!fs.existsSync(BACKUP_DIR)) return undefined;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('voxera-db') && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf8')) as Db;
      for (const rows of Object.values(snapshot.collections)) {
        const hit = (rows ?? []).find((row) => row.id === id);
        if (hit) return hit;
      }
    } catch {
      /* an unreadable backup is skipped, not fatal */
    }
  }
  return undefined;
}

function dedupeWebhooks(db: Db): Row[] {
  const seen = new Map<string, Row>();
  const extras: Row[] = [];
  for (const hook of db.collections.webhooks ?? []) {
    const key = `${hook.orgId}::${hook.url}`;
    if (seen.has(key)) extras.push(hook);
    else seen.set(key, hook);
  }
  return extras;
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const restoreNumber = process.argv.includes('--restore-number');
  // Read through the store, not around it: the data lives in SQLite now and a
  // script that opens the old JSON file would quietly sweep nothing.
  const db = dumpAll() as unknown as Db;
  const users = db.collections.users ?? [];
  const orgs = db.collections.orgs ?? [];

  const doomed = new Set<string>();
  for (const user of users) {
    if (user.orgId && isProbeEmail(user.email)) doomed.add(String(user.orgId));
  }

  /**
   * A workspace is only a probe workspace if *everybody* in it is a probe.
   *
   * This condition used to be written the other way round (`!users.some(non-probe)`),
   * which read as "delete it from the list when all its users are probes" — so it
   * un-doomed exactly the workspaces that should go, and (once a single probe
   * address appeared inside a real one, which is what a locum created by the
   * checks is) it doomed the real workspace instead. A person with a normal
   * address in the org is proof the org is somebody's practice.
   */
  for (const org of orgs) {
    const id = String(org.id);
    const real = users.some((u) => String(u.orgId ?? '') === id && !isProbeEmail(u.email));
    if (real) doomed.delete(id);
  }
  // And the two workspaces the whole project is built around are never swept, no
  // matter what a check script has left inside them.
  for (const slug of ['northwind-labs', 'voxera-demo']) {
    const kept = orgs.find((o) => String(o.slug ?? '') === slug);
    if (kept) doomed.delete(String(kept.id));
  }
  const fingerprintOrphans = orgs.filter((org) => isFingerprintProbeOrphan(db, org, users));
  for (const org of fingerprintOrphans) doomed.add(String(org.id));
  if (doomed.size >= orgs.length) {
    console.error('refusing to run: every workspace looks like a probe workspace');
    process.exit(1);
  }

  const stale = staleCalls(db);
  const dupes = dedupeWebhooks(db);
  const seedNumber = restoreNumber ? findInBackups('num_b127b76817558320') : undefined;
  const numberMissing = seedNumber && !(db.collections.numbers ?? []).some((n) => n.id === seedNumber.id);

  // Probe debris: client records and appointments the check scripts create under
  // their own names. Matched by name on purpose — a sweep must never touch a real
  // record, and these names are unmistakable. Numbers are deliberately *not* used
  // as a signal: the demo bookings share the 555-01xx range, so a probe can merge
  // into a seed client, and the safe answer there is to leave it alone.
  // `Probe` anywhere in the name, not only at the front: the scripts name their
  // records after what they were checking ("Statement Probe", "Slot Probe A"), and
  // the whole word is still a signal no real patient carries.
  // `Recall\d{6}` is in here because `recall_check.py` names its fixtures
  // `Recall201500 …` — a pattern it documents as "the name the first version of it
  // used". A run of that gate interrupted before its own sweep leaves those records
  // behind, and they were invisible to this script: twelve of them were sitting in
  // the demo's Replies queue, waiting on a person, from a run killed on 15 October.
  // Keep this in step with `PROBE_CLIENT` in `scripts/recall_check.py`.
  const PROBE_NAME = /\bProbe\b|^(Practice Check|Practice Client)\b|^Recall\d{6}\b/;
  const probeClients = listRows(db, 'clients', (c) => PROBE_NAME.test(String(c.name ?? '')));
  const probeNames = new Set(probeClients.map((c) => String(c.id)));
  const probeBookings = listRows(db, 'bookings', (b) => probeNames.has(String(b.clientId ?? '')) || PROBE_NAME.test(String((b.customer as { name?: string } | undefined)?.name ?? '')));
  const probeWait = listRows(db, 'waitList', (w) => PROBE_NAME.test(String(w.name ?? '')));
  const probeWaitIds = new Set(probeWait.map((w) => String(w.id)));
  // Messages and outreach rows belong to those records: a removed appointment that
  // leaves its reminder behind would surface in the reports as a touch concerning
  // nobody. Matched by the client or the appointment, never by phone number.
  const probeClientIds = new Set(probeClients.map((c) => String(c.id)));
  const probeBookingIds = new Set(probeBookings.map((b) => String(b.id)));
  // A freed-slot offer belongs to the appointment that freed it and the person it
  // was offered to; matched both ways, plus by name, so a probe offer left behind
  // cannot sit on a real client's list looking live.
  const probeOffers = listRows(
    db,
    'waitOffers',
    (o) => probeClientIds.has(String(o.clientId ?? '')) || probeBookingIds.has(String(o.bookingId ?? '')) || probeWaitIds.has(String(o.entryId ?? '')) || PROBE_NAME.test(String(o.name ?? ''))
  );
  const probeMessages = listRows(db, 'messages', (m) => probeClientIds.has(String(m.clientId ?? '')) || probeBookingIds.has(String(m.bookingId ?? '')));
  const probeOutreach = listRows(db, 'outreach', (o) => probeClientIds.has(String(o.clientId ?? '')) || probeBookingIds.has(String(o.bookingId ?? '')));
  // A probe campaign has no victim record to match on, so it is matched by name.
  // Notes hang off the same records (P5). A note left pointing at an appointment
  // that no longer exists is exactly the orphan this sweep exists to prevent —
  // and unlike a message, a note is a *record*: it is only ever removed together
  // with the probe client it was written about.
  const probeNotes = listRows(db, 'notes', (n) => probeClientIds.has(String(n.clientId ?? '')) || probeBookingIds.has(String(n.bookingId ?? '')));
  const probeCampaigns = listRows(db, 'bookingCampaigns', (c) => /^Probe\b/.test(String(c.name ?? '')));
  // Money hangs off the same records (P6). An invoice is a document with a number,
  // so it is removed only with the probe client or appointment it was raised
  // against — never on its own, and never because it looks odd.
  const probeInvoices = listRows(db, 'invoices', (i) => probeClientIds.has(String(i.clientId ?? '')) || (Array.isArray(i.bookingIds) && (i.bookingIds as string[]).some((id) => probeBookingIds.has(id))));
  const probeInvoiceIds = new Set(probeInvoices.map((i) => String(i.id)));
  const probePayments = listRows(db, 'payments', (p) => probeClientIds.has(String(p.clientId ?? '')) || (Array.isArray(p.allocations) && (p.allocations as { invoiceId?: string }[]).some((a) => probeInvoiceIds.has(String(a.invoiceId ?? '')))));
  const probeLinks = listRows(db, 'paymentLinks', (l) => probeInvoiceIds.has(String(l.invoiceId ?? '')) || probeClientIds.has(String(l.clientId ?? '')));
  const probeExpenses = listRows(db, 'expenses', (e) => /probe|check/i.test(String(e.supplier ?? '')) || /probe|check/i.test(String(e.reference ?? '')));
  // Templates the check edited and retired: the live set should be the house's.
  const probeTemplates = listRows(db, 'templates', (t) => /edited by check|check probe/i.test(String((t as { name?: string }).name ?? '')));
  /**
   * Class sessions and the class services behind them (A8).
   *
   * A session carries no name of its own, so it is matched by the service it
   * belongs to and by the probe bookings that sit in it — which is also the rule
   * that keeps this narrow: a real class the practice created is never touched,
   * because neither its service nor its roster says "Probe".
   */
  const probeServices = listRows(db, 'services', (svc) => /^Probe\b/.test(String(svc.name ?? '')));
  const probeServiceIds = new Set(probeServices.map((svc) => String(svc.id)));
  const probeSessions = listRows(
    db,
    'classSessions',
    (session) => probeServiceIds.has(String(session.serviceId ?? '')) || probeBookingIds.has(String(session.sessionId ?? ''))
  );
  /**
   * …and a session whose class service no longer exists, which is debris of the
   * same kind as an invoice pointing at a client who is gone: nothing can name
   * it, nothing can join it, and no screen can even cancel it by title. Service
   * deletion now refuses while a session is still to come, so anything in this
   * state was orphaned before that rule — or by a run that died between the two.
   */
  const liveServiceIds = new Set((db.collections.services ?? []).map((svc) => String(svc.id)));
  const orphanSessions = listRows(db, 'classSessions', (session) => !liveServiceIds.has(String(session.serviceId ?? '')));
  for (const session of orphanSessions) {
    if (!probeSessions.some((p) => p.id === session.id)) probeSessions.push(session);
  }
  const probeSessionIds = new Set(probeSessions.map((session) => String(session.id)));
  // A seat belongs to the class it is in: removing the session without its seats
  // would leave bookings pointing at an hour nobody is holding.
  const probeSeats = listRows(db, 'bookings', (b) => probeSessionIds.has(String(b.sessionId ?? '')));
  // Rooms (P8) are matched by the name the practice check gives the one it adds,
  // and board notes by the title the team check posts. Both are the gate's own
  // leavings — a room is a record with appointments pointing at it, so it is only
  // removed by name and only when nothing is booked in it.
  const probeRooms = listRows(db, 'rooms', (r) => /^(Practice Check|Probe)\b/.test(String(r.name ?? '')));
  const probeRoomIds = new Set(probeRooms.map((r) => String(r.id)));
  // Probe practitioners are configuration fixtures too. Remove one only when no
  // non-probe appointment or class still refers to it; the name is necessary but
  // never sufficient on its own.
  const probeProviders = listRows(db, 'providers', (p) => /^Probe\b/.test(String(p.name ?? '')));
  const survivingBookings = (db.collections.bookings ?? []).filter((b) => !probeBookingIds.has(String(b.id)));
  const survivingSessions = (db.collections.classSessions ?? []).filter((s) => !probeSessionIds.has(String(s.id)));
  const providersInUse = new Set([
    ...survivingBookings.map((b) => String(b.providerId ?? '')),
    ...survivingSessions.map((s) => String(s.providerId ?? '')),
  ].filter(Boolean));
  const freeProbeProviders = probeProviders.filter((p) => !providersInUse.has(String(p.id)));
  const freeProbeProviderIds = new Set(freeProbeProviders.map((p) => String(p.id)));
  const roomsInUse = new Set(
    survivingBookings
      .filter((b) => b.status !== 'cancelled' && new Date(String(b.startsAt ?? 0)).getTime() >= Date.now())
      .map((b) => String(b.roomId ?? ''))
      .filter(Boolean)
  );
  const freeProbeRooms = probeRooms.filter((r) => !roomsInUse.has(String(r.id)));
  const probeBoardNotes = listRows(db, 'boardNotes', (n) => /^Practice Check/.test(String(n.title ?? '')));
  // Logins the team check creates (P8). A login is not a record: removing the
  // probe account is the point of it being a fixed address, and its sessions go
  // with it so nothing is left holding a cookie for a user who is not here.
  const probeUsers = listRows(db, 'users', (u) => /^locum@/i.test(String(u.email ?? '')) || /Probe/.test(String(u.name ?? '')));
  if (
    probeClients.length ||
    probeBookings.length ||
    probeWait.length ||
    probeMessages.length ||
    probeOutreach.length ||
    probeNotes.length ||
    probeInvoices.length ||
    probePayments.length ||
    probeLinks.length ||
    probeExpenses.length ||
    probeCampaigns.length ||
    probeTemplates.length ||
    freeProbeRooms.length ||
    freeProbeProviders.length ||
    probeBoardNotes.length ||
    probeUsers.length
  ) {
    const ids = new Set([
      ...probeClients.map((c) => c.id),
      ...probeBookings.map((b) => b.id),
      ...probeWait.map((w) => w.id),
      ...probeOffers.map((o) => o.id),
      ...probeMessages.map((m) => m.id),
      ...probeNotes.map((n) => n.id),
      ...probeInvoices.map((i) => i.id),
      ...probePayments.map((p) => p.id),
      ...probeLinks.map((l) => l.id),
      ...probeExpenses.map((e) => e.id),
      ...probeCampaigns.map((c) => c.id),
      ...probeTemplates.map((t) => t.id),
      ...probeSessions.map((session) => session.id),
      ...probeSeats.map((seat) => seat.id),
      ...freeProbeRooms.map((r) => r.id),
      ...freeProbeProviders.map((p) => p.id),
      ...probeBoardNotes.map((n) => n.id),
    ]);
    const userIds = new Set(probeUsers.map((u) => String(u.id)));
    // Auth tokens: every reset link, magic link, code and invitation minted for a
    // probe login. Counted before the filter below so the summary can report them.
    const probeTokens = listRows(db, 'authTokens', (t) => userIds.has(String(t.userId)));
    db.collections.clients = (db.collections.clients ?? []).filter((c) => !ids.has(String(c.id)));
    db.collections.bookings = (db.collections.bookings ?? []).filter((b) => !ids.has(String(b.id)));
    db.collections.waitList = (db.collections.waitList ?? []).filter((w) => !ids.has(String(w.id)));
    db.collections.waitOffers = (db.collections.waitOffers ?? []).filter((o) => !ids.has(String(o.id)));
    db.collections.messages = (db.collections.messages ?? []).filter((m) => !ids.has(String(m.id)));
    db.collections.outreach = (db.collections.outreach ?? []).filter((o) => !ids.has(String(o.id)));
    db.collections.notes = (db.collections.notes ?? []).filter((n) => !ids.has(String(n.id)));
    db.collections.invoices = (db.collections.invoices ?? []).filter((i) => !ids.has(String(i.id)));
    db.collections.payments = (db.collections.payments ?? []).filter((p) => !ids.has(String(p.id)));
    db.collections.paymentLinks = (db.collections.paymentLinks ?? []).filter((l) => !ids.has(String(l.id)));
    db.collections.expenses = (db.collections.expenses ?? []).filter((e) => !ids.has(String(e.id)));
    db.collections.bookingCampaigns = (db.collections.bookingCampaigns ?? []).filter((c) => !ids.has(String(c.id)));
    db.collections.templates = (db.collections.templates ?? []).filter((t) => !ids.has(String(t.id)));
    db.collections.accessLog = (db.collections.accessLog ?? []).filter((a) => !ids.has(String(a.resourceId)));
    db.collections.rooms = (db.collections.rooms ?? []).filter((r) => !ids.has(String(r.id)));
    db.collections.providers = (db.collections.providers ?? []).filter((p) => !ids.has(String(p.id)));
    db.collections.rota = (db.collections.rota ?? []).filter((r) => !freeProbeProviderIds.has(String(r.providerId ?? '')));
    db.collections.rotaChanges = (db.collections.rotaChanges ?? []).filter((r) => !freeProbeProviderIds.has(String(r.providerId ?? '')));
    db.collections.classSessions = (db.collections.classSessions ?? []).filter((session) => !ids.has(String(session.id)));
    // The class service goes last, and only once nothing is left pointing at it:
    // a service deleted while a session still names it is a class with no name.
    const survivingServiceIds = new Set([
      ...((db.collections.classSessions ?? []) as { serviceId?: string }[]).map((session) => String(session.serviceId ?? '')),
      ...((db.collections.bookings ?? []) as { serviceId?: string }[]).map((b) => String(b.serviceId ?? '')),
    ]);
    const removedServices = probeServices.filter((svc) => !survivingServiceIds.has(String(svc.id)));
    db.collections.services = (db.collections.services ?? []).filter((svc) => !removedServices.some((r) => r.id === svc.id));
    db.collections.boardNotes = (db.collections.boardNotes ?? []).filter((n) => !ids.has(String(n.id)));
    db.collections.users = (db.collections.users ?? []).filter((u) => !userIds.has(String(u.id)));
    db.collections.sessions = (db.collections.sessions ?? []).filter((s) => !userIds.has(String(s.userId)));
    // Reset links, magic links, verification codes and invitation links all hang
    // off the person they were minted for. A live invitation left pointing at a
    // deleted member is the auth equivalent of a reminder about nobody.
    db.collections.authTokens = (db.collections.authTokens ?? []).filter((t) => !userIds.has(String(t.userId)));
    console.log(
      `${apply ? 'removed' : 'would remove'} ${probeClients.length} probe client(s), ${probeBookings.length} appointment(s), ` +
        `${probeWait.length} wait entry(ies), ${probeOffers.length} freed-slot offer(s), ${probeMessages.length} message(s), ${probeOutreach.length} outreach row(s), ` +
        `${probeNotes.length} note(s), ${probeInvoices.length} invoice(s), ${probePayments.length} payment(s), ` +
        `${probeCampaigns.length} campaign(s), ${probeTemplates.length} probe template(s), ` +
        `${probeSessions.length} class session(s)${orphanSessions.length ? ` (${orphanSessions.length} orphaned)` : ''}, ${probeSeats.length} class seat(s), ${removedServices.length} probe service(s), ` +
        `${freeProbeRooms.length} probe room(s), ${freeProbeProviders.length} probe practitioner(s), ${probeBoardNotes.length} board note(s), ${probeUsers.length} probe login(s), ` +
        `${probeTokens.length} auth token(s)`
    );
  }

  /**
   * A practitioner's `serviceIds` is the list of what they run — the rota screen
   * reads it, the booking page filters by it, and the desk cannot book a service
   * that is not on it. A name on that list which no service answers to is the same
   * debris as an invoice naming a client who is gone: the roster shows a service
   * that does not exist, and the class picker refuses an instructor for a reason
   * nobody can see. It is exactly the hole this sweep's own service removal left
   * (`svc_73be868996fb7369` stayed on Priya's list after the service went), and the
   * one the deletion guard could not catch, so the rule is written to be general: a
   * service id not in the file is stripped, whether this run removed it or an
   * earlier one did.
   */
  const liveServiceIdsNow = new Set((db.collections.services ?? []).map((svc) => String(svc.id)));
  const staleRefs: { provider: string; serviceId: string }[] = [];
  db.collections.providers = (db.collections.providers ?? []).map((row) => {
    const refs = (row as { serviceIds?: unknown }).serviceIds;
    if (!Array.isArray(refs) || refs.length === 0) return row;
    const kept = refs.filter((id) => liveServiceIdsNow.has(String(id)));
    if (kept.length === refs.length) return row;
    for (const id of refs) {
      if (!liveServiceIdsNow.has(String(id))) staleRefs.push({ provider: String((row as { name?: string }).name ?? row.id), serviceId: String(id) });
    }
    return { ...row, serviceIds: kept };
  });
  if (staleRefs.length) {
    const people = [...new Set(staleRefs.map((r) => r.provider))];
    console.log(
      `${apply ? 'stripped' : 'would strip'} ${staleRefs.length} service reference(s) naming a service that is not in the file, ` +
        `from ${people.length} practitioner(s) — ` +
        staleRefs.map((r) => `${r.provider} \u2192 ${r.serviceId}`).join(', ')
    );
  }

  /**
   * Money left behind by a record that is gone.
   *
   * The check scripts raise real invoices against the clients they create; when
   * that client is swept, the invoice stays pointing at an id that no longer
   * exists. The money screen cannot name the customer and the revenue report
   * files the lot under "Unassigned" — so a demo workspace ends up showing
   * revenue from nobody, which is the same defect as a reminder about nobody.
   *
   * The rule is deliberately narrow: an invoice is only removed when its client
   * is *missing from the file*. Real records are archived, not deleted, so a
   * dangling client id can only be debris — this pass cannot touch a live
   * practice's books.
   */
  const liveClientIds = new Set((db.collections.clients ?? []).map((c) => String(c.id)));
  const orphanInvoices = (db.collections.invoices ?? []).filter(
    (i) => i.clientId !== undefined && i.clientId !== null && !liveClientIds.has(String(i.clientId))
  );
  const orphanInvoiceIds = new Set(orphanInvoices.map((i) => String(i.id)));
  const orphanPayments = (db.collections.payments ?? []).filter(
    (p) =>
      orphanInvoiceIds.has(String(p.invoiceId ?? '')) ||
      (Array.isArray(p.allocations) && (p.allocations as { invoiceId?: string }[]).some((a) => orphanInvoiceIds.has(String(a.invoiceId ?? ''))))
  );
  const orphanLinks = (db.collections.paymentLinks ?? []).filter((l) => orphanInvoiceIds.has(String(l.invoiceId ?? '')));
  if (orphanInvoices.length || orphanPayments.length || orphanLinks.length) {
    db.collections.invoices = (db.collections.invoices ?? []).filter((i) => !orphanInvoiceIds.has(String(i.id)));
    db.collections.payments = (db.collections.payments ?? []).filter((p) => !orphanPayments.some((o) => o.id === p.id));
    db.collections.paymentLinks = (db.collections.paymentLinks ?? []).filter((l) => !orphanLinks.some((o) => o.id === l.id));
    console.log(
      `${apply ? 'removed' : 'would remove'} ${orphanInvoices.length} invoice(s) whose client is gone, ` +
        `${orphanPayments.length} payment(s) and ${orphanLinks.length} payment link(s) with them`
    );
  }

  // Numbers that point at a carrier which is not in the file any more. The demo
  // workspace is *meant* to ship with no carrier connected — `connect one at
  // Dashboard → Carriers` is a real journey, and `carrier_check.py` deletes every
  // carrier row as part of its own clean slate. What must not survive is the
  // reference: a line whose `carrierId` names a carrier that no longer exists reads
  // as "connected" to anything that looks at the id and as "not connected" to the
  // sender, which is how the demo ended up unable to text with no visible reason.
  // Detached, never re-attached: clearing the id is exactly what the disconnect
  // journey does.
  const liveCarriers = new Set((db.collections.carriers ?? []).map((c) => String(c.id)));
  const danglingNumbers = listRows(db, 'numbers', (n) => Boolean(n.carrierId) && !liveCarriers.has(String(n.carrierId)));
  if (danglingNumbers.length) {
    if (apply) {
      db.collections.numbers = (db.collections.numbers ?? []).map((n) =>
        danglingNumbers.some((d) => String(d.id) === String(n.id)) ? { ...n, carrierId: undefined } : n
      );
    }
    console.log(
      `${apply ? 'detached' : 'would detach'} ${danglingNumbers.length} number(s) from a carrier that is not in the file — ` +
        danglingNumbers.map((n) => `${String(n.number)} (${String(n.carrierId)})`).join(', ')
    );
  }

  // Orphans: a message or outreach row about a record that is not in the file any
  // more. The product archives rather than deletes, so the only way to make one is
  // this script removing its record — which is exactly the case that must not leave
  // a touch in the reports concerning nobody. Runs after the removal above, so it
  // also catches whatever the name matching could not see.
  const liveClients = new Set((db.collections.clients ?? []).map((c) => String(c.id)));
  const liveBookings = new Set((db.collections.bookings ?? []).map((b) => String(b.id)));
  const isOrphan = (row: Row) => {
    const clientId = row.clientId === undefined || row.clientId === null ? '' : String(row.clientId);
    const bookingId = row.bookingId === undefined || row.bookingId === null ? '' : String(row.bookingId);
    if (clientId && !liveClients.has(clientId)) return true;
    if (bookingId && !liveBookings.has(bookingId)) return true;
    return false;
  };
  // A probe address with no record attached: the check scripts send to
  // `…@example.test` and `probe.email@…` on purpose, so those rows are identifiable
  // even when they were never tied to a client.
  const isProbeAddress = (row: Row) => {
    const to = String(row.to ?? '');
    if (!to) return false;
    if (/^\+?[\d+]*$/.test(to)) return false;
    const domain = to.split('@')[1] ?? '';
    return PROBE_TLDS.some((tld) => domain.endsWith(tld)) || PROBE_DOMAINS.includes(domain) || /^(probe|test)\b/i.test(to.split('@')[0] ?? '');
  };
  const orphanMessages = listRows(db, 'messages', isOrphan);
  const orphanOutreach = listRows(db, 'outreach', isOrphan);
  const probeAddressedMessages = listRows(db, 'messages', (m) => !isOrphan(m) && isProbeAddress(m));
  const probeAddressedOutreach = listRows(db, 'outreach', (o) => !isOrphan(o) && isProbeAddress(o));
  if (orphanMessages.length || orphanOutreach.length || probeAddressedMessages.length || probeAddressedOutreach.length) {
    db.collections.messages = (db.collections.messages ?? []).filter((m) => !isOrphan(m) && !isProbeAddress(m));
    db.collections.outreach = (db.collections.outreach ?? []).filter((o) => !isOrphan(o) && !isProbeAddress(o));
    console.log(
      `${apply ? 'removed' : 'would remove'} ${orphanMessages.length} orphan message(s), ${orphanOutreach.length} orphan outreach row(s), ` +
        `${probeAddressedMessages.length} probe-addressed message(s), ${probeAddressedOutreach.length} probe-addressed outreach row(s)`
    );
  }

  if (
    doomed.size === 0 &&
    stale.length === 0 &&
    dupes.length === 0 &&
    !numberMissing &&
    probeClients.length === 0 &&
    probeBookings.length === 0 &&
    probeWait.length === 0 &&
    probeMessages.length === 0 &&
    probeOutreach.length === 0 &&
    probeCampaigns.length === 0 &&
    probeTemplates.length === 0 &&
    orphanMessages.length === 0 &&
    orphanOutreach.length === 0 &&
    probeAddressedMessages.length === 0 &&
    probeAddressedOutreach.length === 0 &&
    orphanInvoices.length === 0 &&
    orphanPayments.length === 0 &&
    orphanLinks.length === 0 &&
    staleRefs.length === 0
  ) {
    console.log('nothing to do — no probe workspaces, probe records, messages, outreach rows or campaigns, orphan invoices, stale calls, duplicate webhooks, dangling service references or missing seed number');
    return;
  }

  for (const org of orgs) {
    if (!doomed.has(String(org.id))) continue;
    const owner = users.find((u) => String(u.orgId ?? '') === String(org.id));
    const rows = orgRefs(db, new Set([String(org.id)]))
      .map(([name, count]) => `${name} ${count}`)
      .join(', ');
    console.log(`${apply ? 'REMOVE' : 'WOULD REMOVE'} ${org.id} "${String(org.name)}" (${String(owner?.email ?? 'no user')}) — ${rows}`);
  }

  if (stale.length) {
    const ages = stale.map((c) => (Date.now() - new Date(String(c.createdAt)).getTime()) / 3600000).sort((a, b) => a - b);
    console.log(`${apply ? 'REMOVE' : 'WOULD REMOVE'} ${stale.length} abandoned call(s) from this session — oldest ${ages[ages.length - 1].toFixed(1)}h, newest ${ages[0].toFixed(1)}h`);
  }
  if (dupes.length) {
    for (const hook of dupes) console.log(`${apply ? 'REMOVE' : 'WOULD REMOVE'} duplicate webhook ${hook.id} → ${String(hook.url)}`);
  }
  if (numberMissing && seedNumber) {
    console.log(`${apply ? 'RESTORE' : 'WOULD RESTORE'} seed number ${seedNumber.id} (${String(seedNumber.number)}) from a backup`);
  }

  if (!apply) {
    console.log('\ndry run — pass --apply to remove them');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `voxera-store.before-tidy-${stamp}.json.gz`);
  // The logical dump, not the file: one engine-agnostic artifact, and it is the
  // exact shape this script just decided to write. Gzipped, keeping only the
  // newest two — a tidy is re-runnable, so older pre-tidy dumps are bulk, not
  // evidence.
  fs.writeFileSync(backup, zlib.gzipSync(JSON.stringify(db)));
  const older = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('voxera-store.before-tidy-')).sort().reverse();
  for (const old of older.slice(2)) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });

  for (const [name, rows] of Object.entries(db.collections)) {
    if (name === 'orgs') continue;
    db.collections[name] = rows.filter((row) => !doomed.has(String(row.orgId ?? '')));
  }
  db.collections.orgs = orgs.filter((org) => !doomed.has(String(org.id)));
  if (stale.length) {
    const staleIds = new Set(stale.map((c) => c.id));
    db.collections.calls = (db.collections.calls ?? []).filter((c) => !staleIds.has(String(c.id)));
  }
  if (dupes.length) {
    const dupeIds = new Set(dupes.map((w) => w.id));
    db.collections.webhooks = (db.collections.webhooks ?? []).filter((w) => !dupeIds.has(String(w.id)));
    for (const [name, rows] of Object.entries(db.collections)) {
      if (name === 'webhookDeliveries') db.collections[name] = rows.filter((d) => !dupeIds.has(String(d.webhookId)));
    }
  }
  // Restored verbatim: the adopted line is what a carrier-check run leaves behind,
  // carrier SID included, and a later sweep has to recognise it as its own work.
  if (numberMissing && seedNumber) db.collections.numbers = [...(db.collections.numbers ?? []), seedNumber];

  withDestructiveMaintenance('operator-confirmed probe workspace tidy', (capability) =>
    replaceAll(db as unknown as { collections: Record<string, Doc[]> }, capability));
  console.log(`\nremoved ${doomed.size} workspace(s); backup at ${path.relative(process.cwd(), backup)}`);
}

main();
