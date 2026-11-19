/**
 * One-time repair for the malformed-full-sync probe run on 2026-11-04.
 *
 * That stale build validated a malformed snapshot after marking ten rows absent.
 * The timestamp is the transaction fingerprint; refusing any count other than the
 * observed ten prevents this script from becoming a generic history rewriter.
 * Safe to re-run: zero matches means the repair already happened.
 *
 * Run only with the application stopped and after taking a SQLite backup.
 */

import { list, update, type Doc } from '../lib/server/db';
import { audit } from '../lib/server/audit';

const contaminatedAt = '2026-11-04T22:21:45.024Z';
const rows = list<Doc & {
  orgId: string;
  externalId?: string;
  updatedAt?: string;
  metadata?: Record<string, string>;
}>('bookings', (row) => row.updatedAt === contaminatedAt && row.metadata?.removedFromSource === 'true');

if (rows.length === 0) {
  console.log('booking marker repair: already clean (0 matching rows)');
  process.exit(0);
}
if (rows.length !== 10) {
  throw new Error(`booking marker repair refused: expected exactly 10 fingerprinted rows, found ${rows.length}`);
}

for (const row of rows) {
  const metadata = { ...(row.metadata ?? {}) };
  delete metadata.removedFromSource;
  update('bookings', row.id, { metadata: Object.keys(metadata).length ? metadata : undefined });
}

const orgIds = [...new Set(rows.map((row) => row.orgId))];
for (const orgId of orgIds) {
  audit({
    orgId,
    actor: 'data-repair',
    action: 'booking.sync_markers_repaired',
    detail: `${rows.filter((row) => row.orgId === orgId).length} rows from malformed full-sync probe ${contaminatedAt}`,
  });
}

console.log(`booking marker repair: cleared removedFromSource from ${rows.length} fingerprinted rows`);
