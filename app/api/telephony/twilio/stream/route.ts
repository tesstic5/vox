import { NextResponse, type NextRequest } from 'next/server';
import { mediaTwimlFor, carrierCall } from '@/lib/server/telephony';
import { get } from '@/lib/server/db';
import type { CallDoc } from '@/lib/server/calls';
import { twilioWebhookUrl, verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Media-stream mode.
 *
 * Instead of letting the carrier transcribe, this points the call at a WebSocket
 * where raw audio frames are exchanged — the low-latency path, and the one that
 * supports barge-in properly. The signed token here is checked by the media
 * worker when the socket's `start` frame arrives, so an unsigned connection
 * cannot join someone else's call.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = String(value);
  });
  const sid = String(form.get('CallSid') ?? new URL(req.url).searchParams.get('callSid') ?? '');
  const link = carrierCall(sid);
  if (!link) {
    return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', {
      headers: { 'content-type': 'text/xml' },
    });
  }
  const call = get<CallDoc>('calls', link.callId);
  const verified = verifyTwilioWebhook(req, params, [params.To, params.From, call?.to, call?.from]);
  if (!verified.ok) {
    return new NextResponse(`Refused: ${verified.reason ?? 'invalid carrier signature'}.`, { status: 403, headers: { 'content-type': 'text/plain' } });
  }

  // Hand the call to the media worker: raw audio in both directions, so the
  // agent can be interrupted mid-sentence and provider models do the listening.
  const callbackOrigin = new URL(twilioWebhookUrl(req) ?? req.url).origin;
  return new NextResponse(mediaTwimlFor({ origin: callbackOrigin, callId: link.callId, callSid: sid }), {
    headers: { 'content-type': 'text/xml' },
  });
}
