import { claimScheduler } from '../lib/server/instance-lock';
import { flushNow, insert, closeStore } from '../lib/server/db';
import { rateLimit } from '../lib/server/ratelimit';

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === 'insert') {
    insert(args[0], { id: args[1], value: args[2] });
    flushNow();
    console.log('inserted');
  } else if (mode === 'rate') {
    const result = rateLimit(args[0], 10_000, 60_000);
    console.log(JSON.stringify(result));
  } else if (mode === 'claim') {
    const claim = claimScheduler();
    console.log(JSON.stringify({ owns: claim.owns, reason: claim.reason }));
    claim.release?.();
  } else {
    throw new Error(`unknown worker mode ${mode}`);
  }
} finally {
  closeStore();
}
