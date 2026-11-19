#!/usr/bin/env node
/** Child process used by number-ownership-check.ts. */
import { existsSync, writeFileSync } from 'node:fs';
import { reserveNumberClaim } from '../lib/server/number-ownership';

const [barrier, worker, number, orgId] = process.argv.slice(2);
if (!barrier || !worker || !number || !orgId) {
  console.error('usage: number-reservation-worker <barrier> <worker> <number> <orgId>');
  process.exit(2);
}

async function main() {
  writeFileSync(`${barrier}.${worker}.ready`, String(process.pid));
  const deadline = Date.now() + 20_000;
  while (!existsSync(barrier)) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const result = reserveNumberClaim({
    number,
    orgId,
    carrierId: `car_${worker}`,
    operation: 'adopt',
  });
  console.log(`RESULT ${JSON.stringify({ worker, ...result })}`);
}

main().catch((error) => {
  console.log(`RESULT ${JSON.stringify({ worker, ok: false, error: String(error) })}`);
  process.exitCode = 1;
});
