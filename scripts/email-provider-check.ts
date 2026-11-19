import crypto from 'node:crypto';
import http from 'node:http';
import { sendRelayEmail } from '../lib/server/email-relay';
import { resendReceipt, verifyResendWebhook } from '../lib/server/resend-webhook';

let passes = 0;
let failures = 0;
const requests: Array<{ authorization?: string; idempotencyKey?: string; body: Record<string, unknown> }> = [];

function check(label: string, ok: boolean, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
    requests.push({
      authorization: req.headers.authorization,
      idempotencyKey: Array.isArray(req.headers['idempotency-key']) ? req.headers['idempotency-key'][0] : req.headers['idempotency-key'],
      body,
    });
    res.setHeader('content-type', 'application/json');
    if (body.subject === 'reject') {
      res.statusCode = 422;
      res.end(JSON.stringify({ message: 'sender domain is not verified' }));
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ id: `email_${requests.length}` }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('email test server did not bind');

const before = {
  provider: process.env.VOXERA_EMAIL_PROVIDER,
  base: process.env.VOXERA_EMAIL_API_BASE,
  key: process.env.VOXERA_EMAIL_API_KEY,
  from: process.env.VOXERA_EMAIL_FROM,
};

try {
  process.env.VOXERA_EMAIL_API_BASE = `http://127.0.0.1:${address.port}`;
  process.env.VOXERA_EMAIL_API_KEY = 'email-provider-check-key';
  process.env.VOXERA_EMAIL_FROM = 'Voxera Pilot <pilot@example.test>';

  process.env.VOXERA_EMAIL_PROVIDER = 'relay';
  const generic = await sendRelayEmail({
    to: 'generic@example.test',
    subject: 'generic',
    text: 'Generic relay body',
    metadata: { messageId: 'msg_1', orgId: 'org_1' },
  });
  const genericBody = requests.at(-1)?.body ?? {};
  check('the generic relay returns its provider id', generic.ok && generic.id === 'email_1', JSON.stringify(generic));
  check('the generic relay preserves its documented metadata contract', Boolean(genericBody.metadata) && !('tags' in genericBody), JSON.stringify(genericBody));

  process.env.VOXERA_EMAIL_PROVIDER = 'resend';
  const resend = await sendRelayEmail({
    to: 'resend@example.test',
    subject: 'resend',
    text: 'Resend body',
    metadata: { messageId: 'msg:unsafe/value', orgId: 'org_2' },
  });
  const resendRequest = requests.at(-1);
  const resendBody = resendRequest?.body ?? {};
  const tags = Array.isArray(resendBody.tags) ? resendBody.tags as Array<{ name?: string; value?: string }> : [];
  check('the Resend adapter returns the accepted message id', resend.ok && resend.id === 'email_2', JSON.stringify(resend));
  check('the Resend adapter uses Bearer authentication', resendRequest?.authorization === 'Bearer email-provider-check-key', String(resendRequest?.authorization));
  check(
    'the Resend adapter deduplicates queue retries with the durable message id',
    resendRequest?.idempotencyKey === 'voxera-message/msg:unsafe/value',
    String(resendRequest?.idempotencyKey),
  );
  check('the Resend adapter removes unsupported generic metadata', !('metadata' in resendBody), JSON.stringify(resendBody));
  check('the Resend adapter emits provider-native safe tags', tags.length === 2 && tags.every((tag) => /^[A-Za-z0-9_-]+$/.test(String(tag.name)) && /^[A-Za-z0-9_-]+$/.test(String(tag.value))), JSON.stringify(tags));

  const keyBytes = Buffer.from('resend-webhook-check-key-32-bytes!');
  const webhookSecret = `whsec_${keyBytes.toString('base64')}`;
  const webhookId = 'msg_webhook_check';
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const webhookPayload = JSON.stringify({
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: { email_id: 'email_2', bounce: { message: 'mailbox unavailable', type: 'Permanent' } },
  });
  const webhookSignature = crypto
    .createHmac('sha256', keyBytes)
    .update(`${webhookId}.${webhookTimestamp}.${webhookPayload}`)
    .digest('base64');
  const verified = verifyResendWebhook({
    payload: webhookPayload,
    id: webhookId,
    timestamp: webhookTimestamp,
    signature: `v1,${webhookSignature}`,
    secret: webhookSecret,
  });
  check('a correctly signed Resend webhook verifies against the raw body', verified.type === 'email.bounced' && verified.data?.email_id === 'email_2');
  const receipt = resendReceipt(verified);
  check('a Resend hard bounce becomes a terminal failure and consent withdrawal', receipt.status === 'failed' && receipt.withdrawConsent && receipt.reason === 'mailbox unavailable', JSON.stringify(receipt));
  const temporaryReceipt = resendReceipt({
    type: 'email.bounced',
    data: { email_id: 'email_2', bounce: { message: 'mailbox temporarily unavailable', type: 'Temporary' } },
  });
  check(
    'a temporary bounce fails this attempt without withdrawing future consent',
    temporaryReceipt.status === 'failed' && !temporaryReceipt.withdrawConsent,
    JSON.stringify(temporaryReceipt),
  );

  let forgedRefused = false;
  try {
    verifyResendWebhook({ payload: webhookPayload, id: webhookId, timestamp: webhookTimestamp, signature: 'v1,Zm9yZ2Vk', secret: webhookSecret });
  } catch {
    forgedRefused = true;
  }
  check('a forged Resend signature is refused', forgedRefused);

  let staleRefused = false;
  try {
    verifyResendWebhook({
      payload: webhookPayload,
      id: webhookId,
      timestamp: String(Number(webhookTimestamp) - 900),
      signature: `v1,${webhookSignature}`,
      secret: webhookSecret,
    });
  } catch {
    staleRefused = true;
  }
  check('a stale Resend webhook is refused before processing', staleRefused);

  const rejected = await sendRelayEmail({ to: 'reject@example.test', subject: 'reject', text: 'Rejected body' });
  check('a provider rejection remains a failure with its reason', !rejected.ok && rejected.reason === 'sender domain is not verified', JSON.stringify(rejected));

  delete process.env.VOXERA_EMAIL_API_BASE;
  const missing = await sendRelayEmail({ to: 'none@example.test', subject: 'none', text: 'No provider' });
  check('missing email configuration never pretends to deliver', !missing.ok && missing.reason.includes('no email relay configured'), JSON.stringify(missing));
} finally {
  for (const [key, value] of Object.entries({
    VOXERA_EMAIL_PROVIDER: before.provider,
    VOXERA_EMAIL_API_BASE: before.base,
    VOXERA_EMAIL_API_KEY: before.key,
    VOXERA_EMAIL_FROM: before.from,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log(`\n${passes} PASS / ${failures} FAIL`);
if (failures) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
