import { NextResponse, type NextRequest } from 'next/server';
import { applyDeliveryReceipt, type MessageDoc } from '@/lib/server/messages';
import { audit } from '@/lib/server/audit';
import { list } from '@/lib/server/db';
import { verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Twilio's message status callback.
 *
 * `sent` means a carrier took the message; `delivered` means a phone acknowledged
 * it. They are different facts and the dashboard should not confuse them, so this
 * is where the second one is learned. Nothing here trusts the payload beyond its
 * shape: the message is found by the id we recorded at send time, and a callback
 * for a message we never sent is quietly ignored rather than creating anything.
 */
export async function POST(req: NextRequest) {
  // A carrier always posts form-encoded fields; anything else (a probe, a health
  // check) must not blow up here — it just gets told there was nothing to do.
  let form: FormData | null = null;
  try {
    form = await req.formData();
  } catch {
    form = null;
  }
  const params: Record<string, string> = {};
  form?.forEach((value, key) => {
    params[key] = String(value);
  });
  const read = (key: string) => params[key] ?? '';

  const sid = read('MessageSid') || new URL(req.url).searchParams.get('messageSid') || '';
  const status = read('MessageStatus') || read('SmsStatus');
  const stored = sid ? list<MessageDoc>('messages', (message) => message.providerMessageId === sid)[0] : undefined;
  const verified = verifyTwilioWebhook(req, params, [
    read('From'),
    read('To'),
    stored?.deliveryMeta?.from,
  ]);
  if (!verified.ok) {
    return NextResponse.json({ ok: false, error: verified.reason ?? 'invalid carrier signature' }, { status: 403 });
  }
  if (!sid || !status) return NextResponse.json({ ok: true, ignored: 'missing_sid_or_status' });

  const result = applyDeliveryReceipt({
    providerMessageId: sid,
    status,
    errorCode: read('ErrorCode') || undefined,
    errorMessage: read('ErrorMessage') || undefined,
  });
  if (!result.message) return NextResponse.json({ ok: true, ignored: 'unknown_message' });

  if (result.outreachOutcome) {
    audit({
      orgId: String(result.message.orgId),
      actor: 'carrier',
      action: `message.${result.outreachOutcome}`,
      target: result.message.id,
      detail: result.message.reason ?? `carrier reported ${status}`,
    });
  }

  return NextResponse.json({
    ok: true,
    messageId: result.message.id,
    status: result.message.status,
    recorded: result.outreachOutcome ?? 'no_change',
  });
}
