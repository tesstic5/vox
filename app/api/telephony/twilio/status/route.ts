import { NextResponse, type NextRequest } from 'next/server';
import { carrierCall, endTelephonyCall } from '@/lib/server/telephony';
import { get } from '@/lib/server/db';
import type { CallDoc } from '@/lib/server/calls';
import { verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Twilio's status callback. This is the only reliable signal that a phone call
 * is over — the caller hangs up on their side, not ours — so the call record is
 * closed and metered here.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = String(value);
  });

  const sid = params.CallSid ?? new URL(req.url).searchParams.get('callSid') ?? '';
  const link = carrierCall(sid);
  const stored = link ? get<CallDoc>('calls', link.callId) : undefined;
  const verified = verifyTwilioWebhook(req, params, [params.To, params.From, stored?.to, stored?.from]);
  if (!verified.ok) {
    return NextResponse.json({ ok: false, error: verified.reason ?? 'invalid carrier signature' }, { status: 403 });
  }
  if (!link) return NextResponse.json({ ok: true, ignored: 'unknown_call' });

  const terminal = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
  if (!terminal.includes(params.CallStatus ?? '')) {
    return NextResponse.json({ ok: true, status: params.CallStatus ?? 'unknown' });
  }

  const call = endTelephonyCall({
    orgId: link.orgId,
    callId: link.callId,
    status: params.CallStatus,
    durationSeconds: Number(params.CallDuration ?? 0) || undefined,
  });

  return NextResponse.json({ ok: true, callId: link.callId, status: call?.status ?? 'unknown' });
}
