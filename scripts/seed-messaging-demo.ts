/**
 * Backfills a plausible messaging history for the demo workspaces.
 *
 * A workspace that has just been created has no outreach history, and the two
 * things P4 adds — the outreach log and the no-show report — are meaningless
 * without it: every number is zero, so a reviewer cannot tell a working report
 * from a broken one.
 *
 * So this script gives the **demo** workspaces the history a practice would have
 * after a few weeks: appointments settled as attended or missed, confirmations and
 * reminders recorded against them, calls from the seeded call history attached as
 * call-shaped touches. It is deliberately:
 *
 *   - **idempotent** — a booking that already has a confirmation row does not get
 *     a second one, and an appointment that is already settled is left alone;
 *   - **deterministic** — whether an appointment was missed is derived from its id,
 *     not from `Math.random`, so two runs of the suite produce the same numbers;
 *   - **honest about what it is** — every row it writes says `actor: 'seed'`, so
 *     nobody has to wonder whether a text really went out;
 *   - **demo-only** — it acts on the workspaces named in `DEMO_SLUGS`, never on a
 *     workspace somebody signed up for.
 *
 * Usage:  npx tsx scripts/seed-messaging-demo.ts [--apply]
 * (dry run unless `--apply`; the app must be stopped)
 */

import { get, list, update, type Doc } from '../lib/server/db';
import { recordOutreach } from '../lib/server/outreach';
import { messagesFor, queueMessage } from '../lib/server/messages';
import { setAppointmentStatus } from '../lib/server/diary';
import { describeBooking, type BookingDoc } from '../lib/server/bookings';
import { locationsFor } from '../lib/server/practice';

const DEMO_SLUGS = ['northwind-labs', 'voxera-demo'];
const apply = process.argv.includes('--apply');

/** A stable 0–99 score for a string: the same booking always gets the same fate. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}

function main() {
  const orgs = list<Doc & { slug?: string; name?: string }>('orgs', (o) => DEMO_SLUGS.includes(String(o.slug ?? '')));
  if (!orgs.length) {
    console.log(`no demo workspaces found (looking for ${DEMO_SLUGS.join(', ')})`);
    return;
  }

  const now = Date.now();
  let settled = 0;
  let confirmations = 0;
  let reminders = 0;
  let followUps = 0;
  let callRows = 0;

  for (const org of orgs) {
    const orgId = String(org.id);
    const timezone = locationsFor(orgId)[0]?.timezone ?? 'UTC';
    const bookings = list<BookingDoc>('bookings', (b) => String(b.orgId) === orgId);
    const booked = bookings.filter((b) => b.clientId);

    for (const booking of booked) {
      const startMs = new Date(String(booking.startsAt)).getTime();
      const past = startMs < now - 4 * 3_600_000;
      const score = hash(`${booking.id}:${String(booking.externalId ?? '')}`);
      const missed = score < 12;

      // ---- settle what has happened ------------------------------------
      if (past && (booking.status === 'confirmed' || booking.status === 'pending' || booking.status === 'arrived')) {
        if (apply) {
          const result = setAppointmentStatus({
            orgId,
            id: booking.id,
            status: missed ? 'no_show' : 'completed',
            note: 'seed: a few weeks of clinic history',
            actor: 'seed',
            actorName: 'Demo history',
          });
          if (result.ok) settled += 1;
        } else {
          settled += 1;
        }
      }

      const finalStatus = past ? (missed ? 'no_show' : 'completed') : booking.status;
      const existing = new Set(messagesFor(orgId, (m) => m.bookingId === booking.id).map((m) => String(m.kind ?? '')));

      // ---- the confirmation and the reminder ---------------------------
      const when = (offsetMs: number) => new Date(Math.min(startMs + offsetMs, now - 60_000)).toISOString();
      if (!existing.has('confirmation')) {
        const body = `Hi ${booking.customer.name.split(' ')[0]} — your appointment is booked for ${describeBooking(booking)}. Reply STOP to opt out.`;
        if (apply) {
          queueMessage({
            orgId,
            channel: 'sms',
            to: booking.customer.number,
            clientId: String(booking.clientId),
            bookingId: booking.id,
            body,
            kind: 'confirmation',
            source: 'seed',
            respectConsent: false,
            immediate: true,
          });
        }
        confirmations += 1;
      }
      if (startMs - now < 7 * 86_400_000 && !existing.has('reminder')) {
        if (apply) {
          queueMessage({
            orgId,
            channel: 'sms',
            to: booking.customer.number,
            clientId: String(booking.clientId),
            bookingId: booking.id,
            body: `Hi ${booking.customer.name.split(' ')[0]} — a reminder: your appointment is coming up. Reply STOP to opt out.`,
            kind: 'reminder',
            source: 'seed',
            respectConsent: false,
            immediate: true,
            sendAt: when(-24 * 3_600_000),
          });
        }
        reminders += 1;
      }
      if (missed && !existing.has('no_show')) {
        if (apply) {
          queueMessage({
            orgId,
            channel: 'sms',
            to: booking.customer.number,
            clientId: String(booking.clientId),
            bookingId: booking.id,
            body: `Hi ${booking.customer.name.split(' ')[0]} — we missed you today. Reply with a day that suits and we will rebook you. Reply STOP to opt out.`,
            kind: 'no_show',
            source: 'seed',
            respectConsent: false,
            immediate: true,
            sendAt: when(3 * 3_600_000),
          });
        }
        followUps += 1;
      }

      // ---- a call, where the history has one ---------------------------
      const callIds = (booking.callIds ?? []) as string[];
      const call = callIds.map((id) => get<Doc & { status?: string; endedReason?: string; durationSeconds?: number }>('calls', id)).find(Boolean);
      const callLogged = call
        ? list<Doc>('outreach', (row) => row.callId === String(call.id)).length > 0
        : false;
      if (call && !callLogged) {
        const answered = Number(call.durationSeconds ?? 0) > 20;
        if (apply) {
          recordOutreach({
            orgId,
            channel: 'call',
            kind: 'confirmation',
            outcome: answered ? 'answered' : 'no_answer',
            to: booking.customer.number,
            callId: String(call.id),
            bookingId: booking.id,
            clientId: String(booking.clientId),
            actor: 'seed',
            detail: answered ? `${call.durationSeconds ?? 0}s` : `ended: ${String(call.endedReason ?? 'no answer')}`,
            at: new Date(startMs - 26 * 3_600_000).toISOString(),
          });
        }
        callRows += 1;
      }

      // ---- the outcomes of what was sent, as rows ----------------------
      if (apply) {
        const rows = messagesFor(orgId, (m) => m.bookingId === booking.id);
        for (const row of rows) {
          // The seeded queue above was never actually delivered, so the history gets
          // its own rows: the log is what a practice reads, and it should read true.
          recordOutreach({
            orgId,
            channel: row.channel,
            kind: (row.kind ?? 'unknown') as never,
            outcome: 'sent',
            to: row.to,
            messageId: row.id,
            bookingId: booking.id,
            clientId: row.clientId ? String(row.clientId) : undefined,
            actor: 'seed',
            at: new Date(Math.min(new Date(String(row.sendAt)).getTime(), now - 60_000)).toISOString(),
            meta: { seeded: 'true' },
          });
          update<Doc>('messages', row.id, {
            status: 'sent',
            sentAt: new Date(Math.min(new Date(String(row.sendAt)).getTime(), now - 60_000)).toISOString(),
            attempts: 1,
            provider: 'seed',
            providerMessageId: `seed_${row.id.slice(-6)}`,
            reason: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      void timezone;
    }
  }

  console.log(
    `${apply ? 'seeded' : 'would seed'} ${settled} settled appointment(s), ${confirmations} confirmation(s), ${reminders} reminder(s), ` +
      `${followUps} missed-appointment follow-up(s), ${callRows} call row(s) across ${orgs.length} demo workspace(s)`
  );
  if (!apply) console.log('\ndry run — pass --apply to write it');
}

main();
