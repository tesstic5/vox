#!/usr/bin/env npx tsx
/** Test-only helper: marks a `.test` account verified for local API probes. */
import { flushNow, list, update, type Doc } from '../lib/server/db';

const email = String(process.argv[2] ?? '').trim().toLowerCase();
if (process.env.VOXERA_PROBE_VERIFY !== '1' || !email.endsWith('.test')) {
  console.error('Refusing: set VOXERA_PROBE_VERIFY=1 and pass an address ending in .test');
  process.exit(2);
}
const user = list<Doc & { email?: string }>('users', (row) => String(row.email ?? '').toLowerCase() === email)[0];
if (!user) {
  console.error('No such probe user');
  process.exit(3);
}
update('users', user.id, { emailVerified: true } as never);
flushNow();
console.log(user.id);
