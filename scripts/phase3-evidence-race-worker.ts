import fs from 'node:fs';
import { closeStore } from '../lib/server/db';
import { createLetterCorrection } from '../lib/server/letters';
import { queueReferralNotification } from '../lib/server/referrals';

const [action, index, barrier, orgId, entityId, revision, value] = process.argv.slice(2);

function waitFor(file: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function main() {
  fs.writeFileSync(`${barrier}.${index}.ready`, 'ready');
  waitFor(`${barrier}.go`);
  try {
    if (action === 'correction') {
      const result = createLetterCorrection({
        orgId,
        id: entityId,
        expectedRevision: Number(revision),
        actor: `race-${index}@voxera.test`,
        reason: value,
      });
      console.log(JSON.stringify({ ok: true, id: result.letter.id, sourceRevision: result.corrected.revision }));
      return;
    }
    if (action === 'notification-same' || action === 'notification-different') {
      const body = action === 'notification-different' ? `${value} ${index}` : value;
      const result = queueReferralNotification({
        orgId,
        referralId: entityId,
        expectedRevision: Number(revision),
        actor: `race-${index}@voxera.test`,
        subject: 'Concurrent referral update',
        body,
      });
      console.log(JSON.stringify({ ok: true, id: result.notification.id, body: result.notification.body }));
      return;
    }
    throw new Error(`unknown action ${action}`);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  }
}

void main().then(() => closeStore()).catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
