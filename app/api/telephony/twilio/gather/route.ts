import { NextResponse, type NextRequest } from 'next/server';
import { carrierCall, sayAndGather, hangupTwiml, telephonyTurn, assistantConfigFor } from '@/lib/server/telephony';
import { get, type Doc } from '@/lib/server/db';
import type { CallDoc } from '@/lib/server/calls';
import { twilioWebhookUrl, verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `SpeechResult` arrives here. One turn of the phone conversation runs, and the
 * reply is spoken back inside a new `<Gather>` so the caller can just keep
 * talking — no keypad, no "say that again".
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = String(value);
  });

  const url = new URL(req.url);
  const sid = url.searchParams.get('callSid') ?? params.CallSid ?? '';
  const link = carrierCall(sid);
  if (!link) {
    return new NextResponse(hangupTwiml('This call is no longer active.'), { headers: { 'content-type': 'text/xml' } });
  }
  const call = get<CallDoc>('calls', link.callId);
  if (!call || call.status !== 'in-progress') {
    return new NextResponse(hangupTwiml('This call has already ended.'), { headers: { 'content-type': 'text/xml' } });
  }
  const verified = verifyTwilioWebhook(req, params, [params.To, params.From, call.to, call.from]);
  if (!verified.ok) {
    return new NextResponse(`Refused: ${verified.reason ?? 'invalid carrier signature'}.`, { status: 403, headers: { 'content-type': 'text/plain' } });
  }
  const callbackOrigin = new URL(twilioWebhookUrl(req) ?? req.url).origin;

  const speech = (params.SpeechResult ?? '').trim();
  const noInput = !speech || String(params.SpeechConfidence ?? '0') === '0' && !speech;

  if (noInput) {
    // Twilio already played a nudge; ask once more, then let the caller go.
    const attempts = Number((call as CallDoc & { silenceAttempts?: number }).silenceAttempts ?? 0) + 1;
    if (attempts >= 3) {
      return new NextResponse(hangupTwiml('I have not been able to hear you, so I will end the call here. Please try again.'), {
        headers: { 'content-type': 'text/xml' },
      });
    }
    const config = assistantConfigFor(call.assistantId, link.orgId);
    return new NextResponse(
      sayAndGather({
        text: config?.firstMessage ? 'Sorry, I missed that — could you say it again?' : 'Sorry, I missed that.',
        actionUrl: `${callbackOrigin}/api/telephony/twilio/gather?callSid=${encodeURIComponent(sid)}`,
      }),
      { headers: { 'content-type': 'text/xml' } }
    );
  }

  const turn = await telephonyTurn({ call, orgId: link.orgId, text: speech });
  if (!turn) {
    return new NextResponse(hangupTwiml('Something went wrong with this assistant. Goodbye.'), {
      headers: { 'content-type': 'text/xml' },
    });
  }

  const { result } = turn;

  // Escalation uses only the workspace number's explicitly configured fallback.
  // No fallback means a clear apology and hangup, never an invented destination.
  if (turn.forwarded) {
    if (!turn.transferTarget) {
      return new NextResponse(hangupTwiml('I cannot connect a transfer because no fallback number is configured. Please contact the team directly.'), {
        headers: { 'content-type': 'text/xml' },
      });
    }
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="Polly.Joanna-Neural">${result.reply.replace(
        /[<>&"']/g,
        (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c
      )}</Say>\n  <Dial timeout="30">${turn.transferTarget}</Dial>\n</Response>`,
      { headers: { 'content-type': 'text/xml' } }
    );
  }

  // The caller said they were done — close politely rather than re-prompting.
  if (result.intent === 'goodbye') {
    return new NextResponse(hangupTwiml(result.reply), { headers: { 'content-type': 'text/xml' } });
  }

  return new NextResponse(
    sayAndGather({
      text: result.reply,
      actionUrl: `${callbackOrigin}/api/telephony/twilio/gather?callSid=${encodeURIComponent(sid)}`,
    }),
    { headers: { 'content-type': 'text/xml', 'x-request-id': call.id } }
  );
}
