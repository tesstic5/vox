/**
 * Retention.
 *
 * The store is a single JSON file that is rewritten in full on every flush, so a
 * collection that only grows does not just cost disk — it makes every write
 * slower. Three collections grow on their own with no upper bound: `sessions`
 * (one per sign-in, never cleaned), `apiRequests` (one per authenticated API
 * request) and `audit` (one per notable action). `webhookDeliveries` and
 * `carrierCalls` grow with traffic too.
 *
 * The windows below are the honest default for a product like this: sessions
 * follow their own 30-day expiry, request logs and carrierSid mappings are
 * debugging data, and the audit trail is kept long enough to answer "who did
 * that" for a quarter. Nothing here touches customer data — calls, bookings,
 * usage events, credentials and files are never pruned.
 *
 * Runs once at boot and then every six hours from `server.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { find, get, insert, list, newId, nowIso, remove, update, type Doc } from './db';
import { refreshOverdue } from './money';
import { expireLinks } from './payments';
import { clientsPastRetention } from './clients';
import { audit } from './audit';
import { pruneRateBuckets } from './ratelimit';
import { expireOffers } from './wait-offers';
import { cancelMessage, composeBookingMessage, deliverDueMessages, messagesFor, queueMessage, type MessageDoc } from './messages';
import { outreachRules, queueNoShowFollowUps, queueVisitFollowUps } from './outreach-rules';
import { bookingsFor, type BookingDoc } from './bookings';
import { locationById, practiceProfile, providerById, serviceById, termsForOrg } from './practice';
import { formatClock } from './availability';
import { repairTemplateWordingForOrg, seedTemplatesForOrg } from './templates';
import { dataPath } from './paths';
import { activeLegalHolds } from './privacy-governance';

const DAY = 86_400_000;

export type SweepResult = {
  at: string;
  removed: Record<string, number>;
  /** Offers that stopped standing this sweep. Closed, not deleted — see `sweep`. */
  offersClosed: number;
  /**
   * Wordings written for workspaces that did not have them yet.
   *
   * When the product learns to say something new — a receipt, a refund, a chase for
   * an unpaid bill — a workspace that has been running since before that must not
   * have to open a screen to acquire the wording, or its clients get the bare
   * sentence forever. Seeding is idempotent and never touches edited wording.
   */
  templatesSeeded: number;
};

function olderThan(iso: string | undefined, cutoff: number) {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at < cutoff;
}

/**
 * Write expired audit rows to a compressed archive before they are dropped.
 *
 * The rollup keeps the counts; this keeps the detail, off the hot store.
 * Audit rows compress extremely well (repetitive JSON keys), so a month of
 * trail costs a few hundred KB on disk instead of megabytes inside the
 * SQLite file every read has to live beside. One file per sweep, pruned
 * to the newest `VOXERA_AUDIT_ARCHIVE_KEEP` (default 12). A failed archive
 * write must never block retention — the rollup has already captured the
 * aggregate, and a sweep that throws would be retried against a growing
 * store forever — so failures are logged and swallowed.
 */
function archiveExpiredAudit(rows: Doc[], now: number) {
  if (!rows.length) return;
  try {
    const dir = dataPath('archives');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `audit-expired-${stamp}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows)));
    const keep = Math.max(1, Number(process.env.VOXERA_AUDIT_ARCHIVE_KEEP ?? 12) || 12);
    const archives = fs
      .readdirSync(dir)
      .filter((f) => /^audit-expired-.*\.json\.gz$/.test(f))
      .sort()
      .reverse();
    for (const old of archives.slice(keep)) fs.rmSync(path.join(dir, old), { force: true });
    console.log(`  retention    : archived ${rows.length} expired audit row(s) → ${path.relative(process.cwd(), file)}`);
  } catch (error) {
    console.error('  retention    : audit archive failed (rows still rolled up and dropped):', error);
  }
}

export function sweep(now = Date.now()): SweepResult {
  const removed: Record<string, number> = {};

  // An offer to take a freed slot stops standing on its own clock — and when it
  // does, the person goes back in the queue and the slot is the desk's again.
  // Nobody is told, which is the point: this is a timetable closing, not a
  // decision, and the offer is closed rather than deleted (the desk can still see
  // that it was made and what came of it).
  const offersClosed = expireOffers(undefined, now);
  const drop = (collection: string, ids: string[]) => {
    if (!ids.length) return;
    for (const id of ids) remove(collection, id);
    removed[collection] = (removed[collection] ?? 0) + ids.length;
  };

  // The unauthenticated website demo is deliberately short-lived. Its signed
  // token expires after 30 minutes and the sweep removes both its rate-limit
  // marker and the linked call (including transcript and visitor IP) after one
  // hour. Normal workspace calls are not touched by this rule.
  const expiredDemoCalls = list<Doc & { callId?: string; at?: string; orgId?: string }>(
    'demoCalls',
    (row) => olderThan(row.at, now - 60 * 60 * 1000)
  );
  const demoRecordIds: string[] = [];
  for (const row of expiredDemoCalls) {
    const call = row.callId ? get<Doc & { orgId?: string; source?: string }>('calls', String(row.callId)) : undefined;
    if (call && call.source === 'demo' && String(call.orgId) === String(row.orgId)) {
      remove('calls', call.id);
      demoRecordIds.push(call.id);
    }
  }
  if (demoRecordIds.length) removed.calls = (removed.calls ?? 0) + demoRecordIds.length;
  drop('demoCalls', expiredDemoCalls.map((row) => row.id));

  // Sessions: expired, or revoked more than a day ago (the row is what proves a
  // sign-out happened, so it is kept briefly rather than deleted outright).
  drop(
    'sessions',
    list<Doc & { expiresAt?: string; revokedAt?: string }>('sessions', (s) => {
      if (olderThan(s.expiresAt, now - 7 * DAY)) return true;
      return Boolean(s.revokedAt) && olderThan(s.revokedAt, now - DAY);
    }).map((s) => s.id)
  );

  // Request log: 7 days is plenty to debug a key that misbehaved.
  drop('apiRequests', list<Doc & { at?: string }>('apiRequests', (r) => olderThan(r.at, now - 7 * DAY)).map((r) => r.id));

  /**
   * Audit: 90 days of "who did that", then it is **rolled up**, not just deleted.
   *
   * The audit trail is the collection that grows without a ceiling — 61,000 rows,
   * 16 MB of the store, after two days of test load — and deleting rows at the end
   * of the window was the wrong shape of forgetting: the detail went, and so did
   * any record that the events had happened at all.
   *
   * So each purge first folds its rows into `auditRollups` keyed by (workspace,
   * action, month). A year later the answer to "how many keys were minted in
   * March, and by which workspace" is still there; the individual lines are not.
   * The window is configurable for deployments with their own retention rules.
   */
  const auditDays = Number(process.env.VOXERA_AUDIT_RETENTION_DAYS ?? 90);
  const expiredAudit = list<Doc & { at?: string; orgId?: string; action?: string }>('audit', (a) => olderThan(a.at, now - auditDays * DAY));
  if (expiredAudit.length) {
    const buckets = new Map<string, { orgId: string; action: string; month: string; count: number }>();
    for (const row of expiredAudit) {
      const month = String(row.at ?? '').slice(0, 7) || 'unknown';
      const action = String(row.action ?? 'unknown');
      const orgId = String(row.orgId ?? 'unknown');
      const key = `${orgId}\u0000${action}\u0000${month}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { orgId, action, month, count: 1 });
    }
    for (const bucket of buckets.values()) {
      const existing = find<Doc & { count?: number }>(
        'auditRollups',
        (r) => r.orgId === bucket.orgId && r.action === bucket.action && r.month === bucket.month
      );
      if (existing) {
        update<Doc & { count?: number }>('auditRollups', existing.id, { count: (existing.count ?? 0) + bucket.count } as never);
      } else {
        insert<Doc>('auditRollups', {
          id: newId('aur_'),
          orgId: bucket.orgId,
          action: bucket.action,
          month: bucket.month,
          count: bucket.count,
          createdAt: nowIso(),
        } as Doc);
      }
    }
    removed.auditRollups = buckets.size;
    archiveExpiredAudit(expiredAudit, now);
    drop('audit', expiredAudit.map((a) => a.id));
  }

  // Record-access history: capped per record at write time, and aged out
  // after a year here — "who saw this file" a year on is a question the
  // audit rollup already answers in aggregate.
  const accessDays = Number(process.env.VOXERA_ACCESSLOG_RETENTION_DAYS ?? 365);
  drop(
    'accessLog',
    list<Doc & { at?: string }>('accessLog', (r) => olderThan(r.at, now - accessDays * DAY)).map((r) => r.id)
  );

  // Freed-slot offers: the *open* ones are live and never touched here (the sweep
  // closes them on their own clock); a closed one is history, kept 90 days like
  // the audit trail so a practice can still show what was offered and what came
  // of it.
  drop(
    'waitOffers',
    list<Doc & { status?: string; respondedAt?: string; createdAt?: string }>('waitOffers', (o) => {
      if (o.status === 'open') return false;
      const closedAt = o.respondedAt ?? o.createdAt;
      return olderThan(closedAt, now - 90 * DAY);
    }).map((o) => o.id)
  );

  // Deliveries: 30 days, and never more than 1,000 per workspace, so a webhook
  // pointed at a dead endpoint cannot fill the file on its own.
  const deliveries = list<Doc & { orgId?: string; at?: string }>('webhookDeliveries');
  const expired = deliveries.filter((d) => olderThan(d.at, now - 30 * DAY));
  const perOrg = new Map<string, typeof deliveries>();
  for (const d of deliveries.filter((x) => !expired.includes(x))) {
    const key = String(d.orgId ?? 'unknown');
    perOrg.set(key, [...(perOrg.get(key) ?? []), d]);
  }
  const overflow: string[] = [];
  for (const rows of perOrg.values()) {
    if (rows.length > 1000) overflow.push(...rows.slice(1000).map((r) => r.id));
  }
  drop('webhookDeliveries', [...expired.map((d) => d.id), ...overflow]);

  // Signed inbound provider receipts are idempotency evidence, not permanent
  // message content. Keep a month and cap the deployment-wide tail so a provider
  // retry storm cannot grow the store without bound.
  const providerEvents = list<Doc & { at?: string }>('providerWebhookEvents');
  const expiredProviderEvents = providerEvents.filter((event) => olderThan(event.at, now - 30 * DAY));
  const retainedProviderEvents = providerEvents.filter((event) => !expiredProviderEvents.includes(event));
  drop('providerWebhookEvents', [
    ...expiredProviderEvents.map((event) => event.id),
    ...retainedProviderEvents.slice(10_000).map((event) => event.id),
  ]);

  // Carrier SID → call mappings are only needed while the call is fresh.
  drop(
    'carrierCalls',
    list<Doc & { createdAt?: string }>('carrierCalls', (c) => olderThan(c.createdAt, now - 2 * DAY)).map((c) => c.id)
  );

  // Archived client records are *purged* only once their retention window has
  // passed — the window exists precisely so that "delete" is not instant. Every
  // purge leaves its own audit line, because a record that vanished without a
  // trace is the thing a records-keeping system must never do.
  const purgedClients: string[] = [];
  for (const client of clientsPastRetention(now)) {
    const holds = activeLegalHolds({ orgId: client.orgId, patientId: client.id, resourceId: client.id, recordClass: 'patient_record' });
    if (holds.length) {
      audit({
        orgId: client.orgId,
        actor: 'maintenance',
        action: 'client.retention_held',
        target: client.id,
        detail: `${holds.length} active legal hold(s) prevented purge`,
      });
      continue;
    }
    audit({
      orgId: client.orgId,
      actor: 'maintenance',
      action: 'client.purged',
      target: client.id,
      detail: `retention window ended ${client.retentionUntil}; archived by ${client.archivedBy ?? 'unknown'}`,
    });
    remove('clients', client.id);
    purgedClients.push(client.id);
  }
  if (purgedClients.length) removed.clients = (removed.clients ?? 0) + purgedClients.length;

  // Expired wait-list entries stop pretending to be waiting after a day.
  const expiredWait = list<Doc & { orgId?: string; from?: string; to?: string; status?: string }>('waitList', (w) => w.status === 'waiting' || w.status === 'offered').filter(
    (w) => new Date(String(w.to ?? w.from ?? 0)).getTime() < now - DAY
  );
  if (expiredWait.length) {
    for (const entry of expiredWait) remove('waitList', entry.id);
    removed.waitList = expiredWait.length;
  }

  // The house wording, for every workspace: a job the product learned since a
  // workspace was made (the receipt, the chase) has no stored template there yet,
  // and a client should never be the one who finds out. Edited wording is left
  // exactly as the practice wrote it — see `seedTemplatesForOrg`.
  let templatesSeeded = 0;
  for (const org of list<Doc & { id: string }>('orgs')) {
    try {
      templatesSeeded += seedTemplatesForOrg(org.id).seeded;
      templatesSeeded += repairTemplateWordingForOrg(org.id).repaired;
    } catch (error) {
      console.error(`[maintenance] could not seed templates for ${org.id}`, error);
    }
  }

  removed.rateBuckets = pruneRateBuckets();
  removed.remindersQueued = queueDueReminders(now);
  removed.noShowFollowUps = queueNoShowFollowUps(now);
  removed.visitFollowUps = queueVisitFollowUps(now);
  removed.messagesSent = 0;
  removed.messagesBlocked = 0;
  return { at: new Date(now).toISOString(), removed, offersClosed, templatesSeeded };
}

/**
 * Reminders, queued ahead of time rather than sent on the hour.
 *
 * A reminder is made once — when it is first seen inside the lead window — and
 * carries the appointment as its `bookingId`, so a re-run cannot duplicate it and
 * a cancellation can take it back. The send itself happens in `deliverMessages`,
 * which re-checks consent: somebody who says "stop texting me" on Tuesday must
 * not get Wednesday's reminder.
 */
/**
 * Brings queued reminders back in line with the appointments they belong to.
 *
 * An appointment that moves after its reminder was queued leaves that reminder
 * pointing at the old time — and a reminder that arrives for the wrong moment is
 * worse than none at all. So every sweep re-derives each pending reminder's moment
 * from the current appointment: cancelled ones are taken back, moved ones are
 * re-timed, and nothing is touched when nothing has changed.
 */
export function reconcileReminders(now = Date.now(), orgId?: string): { retimed: number; cancelled: number } {
  let retimed = 0;
  let cancelled = 0;
  const pending = list<MessageDoc>('messages', (m) => {
    if (m.status !== 'pending' || m.kind !== 'reminder' || !m.bookingId) return false;
    return orgId ? String(m.orgId) === orgId : true;
  });

  for (const message of pending) {
    const booking = get<BookingDoc>('bookings', String(message.bookingId));
    if (!booking || booking.status === 'cancelled' || booking.status === 'no_show' || booking.status === 'completed') {
      cancelMessage(String(message.orgId), message.id, 'system', booking ? `appointment is ${booking.status}` : 'appointment is gone');
      cancelled += 1;
      continue;
    }
    const rules = outreachRules(String(message.orgId));
    const startMs = new Date(String(booking.startsAt)).getTime();
    const expected = Math.max(now, startMs - rules.reminder.leadMinutes * 60_000);

    /**
     * A reminder is a sentence about a moment, so a retimed row whose words still
     * describe the old moment is worse than no reminder at all: "your job is
     * Friday at 9:00am" arriving about a Monday appointment is how a client ends
     * up at a locked door. Move an appointment and the text is re-rendered and
     * compared; when it no longer describes the booking, the row is withdrawn and
     * the next pass queues one that does.
     */
    const client = booking.clientId ? get<Doc & { name?: string }>('clients', String(booking.clientId)) : undefined;
    if (client) {
      const composed = composeBookingMessage({
        orgId: String(message.orgId),
        kind: 'reminder',
        channel: message.channel,
        booking,
        clientName: String(client.name ?? booking.customer.name),
        fallback: `A reminder: your appointment is coming up.`,
      });
      if (composed.body !== message.body) {
        cancelMessage(String(message.orgId), message.id, 'system', 'the appointment changed after this was written');
        cancelled += 1;
        continue;
      }
    }

    if (Math.abs(new Date(String(message.sendAt)).getTime() - expected) > 60_000) {
      update<MessageDoc>('messages', message.id, { sendAt: new Date(expected).toISOString(), updatedAt: nowIso() } as never);
      retimed += 1;
    }
  }
  return { retimed, cancelled };
}

export function queueDueReminders(now = Date.now(), orgId?: string): number {
  // Reconcile first: whatever was queued before must still describe the diary as
  // it is now, not as it was when the row was written.
  reconcileReminders(now, orgId);

  const upcoming = list<BookingDoc>('bookings', (b) => {
    const at = new Date(String(b.startsAt ?? 0)).getTime();
    if (orgId && String(b.orgId) !== orgId) return false;
    return at > now && (b.status === 'confirmed' || b.status === 'pending');
  });

  let queued = 0;
  for (const booking of upcoming) {
    if (!booking.clientId) continue;
    const bookingOrg = String(booking.orgId);
    // Per-workspace rules: when to remind, and on which channels.
    const rules = outreachRules(bookingOrg);
    if (!rules.reminder.enabled) continue;
    const startMs = new Date(String(booking.startsAt)).getTime();
    const leadMs = rules.reminder.leadMinutes * 60_000;
    const aheadMs = (rules.reminder.leadMinutes + rules.reminder.queueAheadMinutes) * 60_000;
    // Two doors, not one: the reminder joins the queue when the appointment comes
    // within the queue-ahead horizon, and leaves it at its own moment (`sendAt`).
    if (startMs - now > aheadMs) continue;
    // Too late to be a reminder (the appointment has begun in all but name).
    if (startMs - now < Math.min(60, rules.reminder.skipInsideMinutes) * 60_000) continue;

    for (const channel of rules.reminder.channels) {
      const already = messagesFor(bookingOrg, (m) => m.bookingId === booking.id && m.kind === 'reminder' && m.channel === channel && m.status !== 'cancelled');
      if (already.length) continue;
      const client = get<Doc & { name?: string }>('clients', String(booking.clientId));
      if (!client) continue;
      const composed = composeBookingMessage({
        orgId: bookingOrg,
        kind: 'reminder',
        channel,
        booking,
        clientName: String(client.name ?? booking.customer.name),
        fallback: `A reminder: your appointment is coming up.`,
      });
      queueMessage({
        orgId: bookingOrg,
        channel,
        to: channel === 'email' ? String(booking.customer.email ?? '') : booking.customer.number,
        clientId: String(booking.clientId),
        bookingId: booking.id,
        body: composed.body,
        subject: composed.subject,
        kind: 'reminder',
        // T-minus N, and never in the past: an appointment already inside the lead
        // window gets its reminder now rather than a moment that has passed.
        sendAt: new Date(Math.max(now, startMs - leadMs)).toISOString(),
        source: 'reminder-rule',
        meta: { kind: 'reminder', reference: booking.externalId ?? '', templateId: composed.templateId ?? '' },
        respectConsent: true,
      });
      queued += 1;
    }
  }
  return queued;
}

/**
 * Sends what is due. Called from the sweep, and by `/v1/messages/deliver` so a
 * workspace can prove the path without waiting six hours.
 */
export async function deliverMessages(options: { orgId?: string; limit?: number; dryRun?: boolean } = {}) {
  return deliverDueMessages(options);
}


/**
 * Boot + interval hook for `server.ts`.
 *
 * `onTick` runs after each sweep — the delivery of due messages hangs off it,
 * because a queue that only drains when a page is open is not a queue. The timer
 * is unref'd so it never holds the process open.
 */
export function startMaintenance(intervalMs = 6 * 60 * 60 * 1000, options: { onTick?: () => void } = {}) {
  const first = sweep();
  const total = Object.values(first.removed).reduce((a, b) => a + b, 0);
  if (total) console.log(`  retention    : swept ${total} stale rows (${Object.entries(first.removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  // Money ages on its own clock: an invoice becomes overdue because a date passed,
  // and a payment link expires because a window closed. Neither is a user action,
  // so both are swept here rather than waiting for somebody to open a page.
  const money = firstMoney();
  if (money.overdue || money.expired) {
    console.log(`  money        : ${money.overdue} invoice(s) now overdue, ${money.expired} payment link(s) expired`);
  }
  if (first.offersClosed) {
    console.log(`  wait list    : ${first.offersClosed} offer(s) closed — those clients are back in the queue`);
  }
  options.onTick?.();
  const timer = setInterval(() => {
    sweep();
    firstMoney();
    options.onTick?.();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The two time-driven bits of the ledger, idempotent and cheap. */
export function firstMoney(): { overdue: number; expired: number } {
  return { overdue: refreshOverdue(), expired: expireLinks() };
}
