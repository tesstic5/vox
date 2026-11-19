/**
 * Offer expiry, proved against the real sweeper — offline.
 *
 * Run with the app **stopped**. Offer expiry is the one rule in the freed-slot
 * engine that cannot be reached through the API: an offer stands for four hours
 * (never past the appointment itself), and there is no honest way to age a row
 * while the app is up — it holds the database in memory and writes its own copy
 * back over yours.
 *
 * So this inserts three offers and two wait-list entries through the engine's own
 * writers, then runs the *real* `expireOffers` — the same function the housekeeping
 * sweep and the desk's board call — and checks what the rule promises:
 *
 *   1. an aged offer is closed, not deleted — `expired`, with a note;
 *   2. its wait-list entry goes back to `waiting` while its own window is open;
 *   3. an entry whose window has already passed becomes `expired` instead, because
 *      "still waiting for last Tuesday" is not a queue anybody can act on;
 *   4. an offer still inside its window is left alone;
 *   5. the audit trail says it happened.
 *
 *     npx tsx scripts/offer_expiry_probe.ts            (dry run — says what it would do)
 *     npx tsx scripts/offer_expiry_probe.ts --apply
 *
 * It removes the rows it added and flushes, so the file on disk ends up as the
 * workspace without this probe in it. A backup is taken before anything is written.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dumpAll, flushNow, insert, list, remove, storeDriver } from '../lib/server/db';
import { expireOffers, offersFor, offerSpeaking, type WaitOfferDoc } from '../lib/server/wait-offers';
import type { WaitEntryDoc } from '../lib/server/diary';

const STORE = `${storeDriver()} store`;
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
const apply = process.argv.includes('--apply');
const ORG = 'org_3b5dd38bbd095dd5';
const stamp = Date.now();
const probes = `expiryprobe_${stamp}`;

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${label}${detail ? `  — ${detail}` : ''}`);
}

const openWindow = {
  id: `wl_${probes}_open`,
  orgId: ORG,
  name: 'Probe Expiry Open',
  number: '+14155559011',
  from: new Date(stamp + 2 * 86_400_000).toISOString().slice(0, 10),
  to: new Date(stamp + 9 * 86_400_000).toISOString().slice(0, 10),
  status: 'offered' as const,
  createdAt: new Date(stamp).toISOString(),
  updatedAt: new Date(stamp).toISOString(),
} as unknown as WaitEntryDoc;

const closedWindow = {
  ...openWindow,
  id: `wl_${probes}_past`,
  name: 'Probe Expiry Past',
  // A window that closed a week ago.
  from: new Date(stamp - 10 * 86_400_000).toISOString().slice(0, 10),
  to: new Date(stamp - 8 * 86_400_000).toISOString().slice(0, 10),
} as unknown as WaitEntryDoc;

const soon = new Date(stamp + 3 * 86_400_000).toISOString();
const agesAgo = new Date(stamp - 60_000).toISOString();
const stillStands = new Date(stamp + 3 * 3_600_000).toISOString();

function mint(entry: WaitEntryDoc, expiresAt: string, tag: string): WaitOfferDoc {
  return {
    id: `wo_${probes}_${tag}`,
    orgId: ORG,
    entryId: entry.id,
    bookingId: `bkg_${probes}`,
    name: entry.name,
    number: entry.number,
    email: entry.email,
    startsAt: soon,
    durationMinutes: 30,
    providerId: entry.providerId,
    serviceId: entry.serviceId,
    locationId: entry.locationId,
    status: 'open',
    channel: 'sms',
    createdAt: new Date(stamp).toISOString(),
    expiresAt,
  } as WaitOfferDoc;
}

const agedOpen = mint(openWindow, agesAgo, 'aged_open');
const agedPast = mint(closedWindow, agesAgo, 'aged_past');
const live = mint(openWindow, stillStands, 'live');

console.log(`offer expiry probe — ${apply ? 'apply' : 'dry run'} — ${STORE}`);
console.log(`  two offers to age  : ${agedOpen.id}, ${agedPast.id}`);
console.log(`  one to leave alone : ${live.id} (stands until ${stillStands})`);
console.log(`  the entry behind the first one wants ${openWindow.from} → ${openWindow.to}`);

if (!apply) {
  console.log('\ndry run — pass --apply to insert the rows, run the real sweeper and check what it did');
  process.exit(0);
}

// A backup first: these rows go into the same database the app writes, and this is
// the one script in the tree that changes a *time* in order to test a rule.
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backup = path.join(BACKUP_DIR, `voxera-store.before-expiry-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
// A logical dump: works whichever engine is live, and it is what the store
// actually holds — not a file that happens to sit beside it. Gzipped, and
// only the newest dump is kept: this probe runs in the offline gate suite,
// so an uncompressed 30 MB dump per run filled the backups directory with
// copies of a store that was never actually changed by a failed run.
fs.writeFileSync(backup, zlib.gzipSync(JSON.stringify(dumpAll())));
for (const old of fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('voxera-store.before-expiry-probe-')).sort().reverse()) {
  if (path.join(BACKUP_DIR, old) !== backup) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
}
console.log(`  backup: ${backup}`);

insert<WaitEntryDoc>('waitList', openWindow);
insert<WaitEntryDoc>('waitList', closedWindow);
insert<WaitOfferDoc>('waitOffers', agedOpen);
insert<WaitOfferDoc>('waitOffers', agedPast);
insert<WaitOfferDoc>('waitOffers', live);

console.log(`  the first offer's slot, in the clinic's words: ${offerSpeaking(ORG, agedOpen)}`);

const closed = expireOffers(ORG);

type OfferRow = { id: string; status?: string; note?: string };
type EntryRow = { id: string; status?: string };
type AuditRow = { id: string; action?: string };
const offerRows = list<OfferRow>('waitOffers', (o) => String(o.id).includes(probes));
const entryRows = list<EntryRow>('waitList', (e) => String(e.id).includes(probes));
const findOffer = (id: string) => offerRows.find((o) => o.id === id);
const findEntry = (id: string) => entryRows.find((e) => e.id === id);

check('the sweeper closed both aged offers', closed >= 2, `closed ${closed}`);
check('an aged offer is closed, not deleted', findOffer(agedOpen.id)?.status === 'expired', String(findOffer(agedOpen.id)?.status));
check('and the closing says why', String(findOffer(agedOpen.id)?.note ?? '').length > 0, String(findOffer(agedOpen.id)?.note));
check('its entry goes back in the queue while its window is open', findEntry(openWindow.id)?.status === 'waiting', String(findEntry(openWindow.id)?.status));
check('an entry whose own window has gone does not go back in the queue', findEntry(closedWindow.id)?.status === 'expired', String(findEntry(closedWindow.id)?.status));
check('an offer still inside its window is left alone', findOffer(live.id)?.status === 'open', String(findOffer(live.id)?.status));
check('the desk can still see everything that happened', offersFor(ORG, { status: ['open', 'expired'] }).length >= 3, `${offersFor(ORG, { status: ['open', 'expired'] }).length} rows`);
check(
  'the audit trail records the closures',
  list<AuditRow>('audit', (a) => a.action === 'waitlist.offer_expired').length >= 2,
  'waitlist.offer_expired'
);

// Back to how it was found, minus the probes: the same writers the API would use,
// and one flush so the file on disk is the workspace without this probe in it.
for (const offer of list<OfferRow>('waitOffers', (o) => String(o.id).includes(probes))) remove('waitOffers', offer.id);
for (const entry of list<EntryRow>('waitList', (e) => String(e.id).includes(probes))) remove('waitList', entry.id);
flushNow();
console.log('  probe rows removed; the workspace is as it was (backup kept above)');

console.log(`\n${passes} PASS / ${failures} FAIL`);
process.exit(failures ? 1 : 0);
