#!/usr/bin/env npx tsx
/** Remove local `.test` API-probe tenants and every tenant-scoped row they own. */
import { dumpAll, flushNow, list, remove, type Doc } from '../lib/server/db';

const prefix = String(process.argv[2] ?? 'Field API Check ');
if (process.env.VOXERA_PROBE_CLEANUP !== '1') {
  console.error('Refusing: set VOXERA_PROBE_CLEANUP=1');
  process.exit(2);
}
const orgs = list<Doc & { name?: string }>('orgs', (row) => String(row.name ?? '').startsWith(prefix));
const ids = new Set(orgs.map((row) => row.id));
const snapshot = dumpAll();
let removed = 0;
for (const [collection, rows] of Object.entries(snapshot.collections)) {
  for (const row of rows) {
    const orgId = String((row as { orgId?: string }).orgId ?? '');
    if (ids.has(orgId) || (collection === 'orgs' && ids.has(row.id))) {
      if (remove(collection, row.id)) removed += 1;
    }
  }
}
flushNow();
console.log(JSON.stringify({ orgs: ids.size, removed }));
