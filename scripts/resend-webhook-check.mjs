#!/usr/bin/env node
/** Signed-route acceptance for the Resend webhook; uses an unknown synthetic id. */
import crypto from 'node:crypto';

const BASE = (process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const secret = process.env.RESEND_WEBHOOK_SECRET ?? '';
let passes = 0;
let failures = 0;

function check(label, ok, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function key() {
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  return Buffer.from(encoded, 'base64');
}

function signature(id, timestamp, payload) {
  return `v1,${crypto.createHmac('sha256', key()).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
}

async function post(payload, id, timestamp, signed = signature(id, timestamp, payload), chunked = false) {
  const body = chunked
    ? new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
            controller.enqueue(encoder.encode(payload.slice(offset, offset + 16 * 1024)));
          }
          controller.close();
        },
      })
    : payload;
  const response = await fetch(`${BASE}/api/webhooks/resend`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signed,
    },
    body,
    ...(chunked ? { duplex: 'half' } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

if (key().length < 16) {
  console.error('RESEND_WEBHOOK_SECRET must be a whsec_ base64 secret for this gate');
  process.exit(2);
}

const stamp = Date.now();
const now = String(Math.floor(stamp / 1000));
const payload = JSON.stringify({
  type: 'email.delivered',
  created_at: new Date(stamp).toISOString(),
  data: { email_id: `email_unknown_${stamp}` },
});

const forged = await post(payload, `msg_forged_${stamp}`, now, 'v1,Zm9yZ2Vk');
check('a forged Resend callback is refused', forged.status === 400, `HTTP ${forged.status}`);

const staleAt = String(Number(now) - 900);
const stale = await post(payload, `msg_stale_${stamp}`, staleAt);
check('a stale but correctly signed Resend callback is refused', stale.status === 400, `HTTP ${stale.status}`);

const huge = 'x'.repeat(257 * 1024);
const oversized = await post(huge, `msg_huge_${stamp}`, now);
check('an oversized Resend callback is refused before parsing', oversized.status === 413, `HTTP ${oversized.status}`);

const chunkedOversized = await post(huge, `msg_chunked_huge_${stamp}`, now, signature(`msg_chunked_huge_${stamp}`, now, huge), true);
check('a chunked oversized callback is bounded without trusting Content-Length', chunkedOversized.status === 413, `HTTP ${chunkedOversized.status}`);

const id = `msg_valid_${stamp}`;
const accepted = await post(payload, id, now);
check('a valid signed callback is accepted without inventing a message match', accepted.status === 200 && accepted.body.ok === true && accepted.body.matched === false, `HTTP ${accepted.status} ${JSON.stringify(accepted.body)}`);

const replay = await post(payload, id, now);
check('replaying the same signed Svix id is idempotent', replay.status === 200 && replay.body.duplicate === true, `HTTP ${replay.status} ${JSON.stringify(replay.body)}`);

console.log(`\n${passes} PASS / ${failures} FAIL`);
process.exit(failures ? 1 : 0);
