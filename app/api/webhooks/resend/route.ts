import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { audit } from '@/lib/server/audit';
import { setConsent } from '@/lib/server/clients';
import { get, insert, list, nowIso, type Doc } from '@/lib/server/db';
import { logEvent } from '@/lib/server/log';
import { applyDeliveryReceipt, type MessageDoc } from '@/lib/server/messages';
import { resendReceipt, verifyResendWebhook } from '@/lib/server/resend-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 256 * 1024;

async function boundedPayload(req: NextRequest) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel('payload too large');
        throw new Error('payload too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function receiptId(id: string) {
  return `resend_${crypto.createHash('sha256').update(id).digest('hex')}`;
}

/**
 * Signed Resend delivery events.
 *
 * Resend retries at least once and does not guarantee order, so the Svix id is
 * retained for idempotency and the message receipt path gives failures terminal
 * precedence. Only the event type/provider id/outcome are retained — never the
 * raw payload or recipient address.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, error: 'email webhook is not configured' }, { status: 503 });

  const length = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY) return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });

  let payload: string;
  try {
    payload = await boundedPayload(req);
  } catch (error) {
    if (error instanceof Error && error.message === 'payload too large') {
      return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
    }
    throw error;
  }

  const webhookId = req.headers.get('svix-id') ?? '';
  const storedId = receiptId(webhookId);

  let event;
  try {
    event = verifyResendWebhook({
      payload,
      id: webhookId,
      timestamp: req.headers.get('svix-timestamp') ?? '',
      signature: req.headers.get('svix-signature') ?? '',
      secret,
    });
  } catch (error) {
    logEvent('warn', 'email.webhook_refused', { provider: 'resend', reason: error instanceof Error ? error.message : 'invalid webhook' });
    return NextResponse.json({ ok: false, error: 'invalid email webhook' }, { status: 400 });
  }

  if (get<Doc>('providerWebhookEvents', storedId)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const providerMessageId = String(event.data?.email_id ?? '');
  const message = list<MessageDoc>('messages', (row) => row.channel === 'email' && row.providerMessageId === providerMessageId)[0];
  const outcome = resendReceipt(event);
  const applied: { message?: MessageDoc; outreachOutcome?: 'delivered' | 'failed' } = outcome.status
    ? applyDeliveryReceipt({ providerMessageId, status: outcome.status, errorMessage: outcome.reason })
    : { message };
  const matched = applied.message ?? message;

  if (matched && outcome.withdrawConsent && matched.clientId) {
    setConsent(matched.orgId, matched.clientId, 'email', false, {
      source: 'provider',
      note: `Resend reported ${event.type}`,
      actor: 'email:resend',
      actorName: 'Resend webhook',
    });
  }

  if (matched && applied.outreachOutcome) {
    audit({
      orgId: matched.orgId,
      actor: 'email:resend',
      action: `message.${applied.outreachOutcome}`,
      target: matched.id,
      detail: outcome.reason ?? `Resend reported ${event.type}`,
    });
  }

  insert('providerWebhookEvents', {
    id: storedId,
    orgId: matched?.orgId ?? 'system',
    provider: 'resend',
    event: event.type,
    eventAt: event.created_at,
    providerMessageId,
    matched: Boolean(matched),
    outcome: applied.outreachOutcome ?? 'no_change',
    at: nowIso(),
  });

  logEvent('info', 'email.webhook_processed', {
    provider: 'resend',
    type: event.type,
    matched: Boolean(matched),
    outcome: applied.outreachOutcome ?? 'no_change',
  });
  return NextResponse.json({ ok: true, matched: Boolean(matched), recorded: applied.outreachOutcome ?? 'no_change' });
}
