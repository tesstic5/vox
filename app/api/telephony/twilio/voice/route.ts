import { NextResponse, type NextRequest } from 'next/server';
import {
  ingestInbound,
  sayAndGather,
  hangupTwiml,
  resolveTenantByNumber,
  answerModeFor,
  mediaTwimlFor,
} from '@/lib/server/telephony';
import { update, type Doc } from '@/lib/server/db';
import { twilioWebhookUrl, verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Point a Twilio number's voice webhook here and the agent answers the line.
 *
 * Twilio posts `application/x-www-form-urlencoded` with To/From/CallSid; we
 * resolve the tenant from the dialled number, open a call record, and reply with
 * TwiML that speaks the greeting then listens for the caller.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = String(value);
  });

  // Prefer the workspace's own carrier token; fall back to the deployment's
  // managed-account token, and verify against the operator-controlled public URL.
  const verified = verifyTwilioWebhook(req, params, [params.To, params.From]);
  if (!verified.ok) {
    // The refusal explains itself: a misconfigured deployment should read as a
    // configuration problem, not as a carrier sending bad signatures.
    return new NextResponse(verified.reason ? `Refused: ${verified.reason}.` : 'Invalid signature', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const to = params.To ?? '';
  const from = params.From ?? '';
  const sid = params.CallSid ?? `sim_${Date.now()}`;
  const tenant = resolveTenantByNumber(to);
  if (!tenant) {
    return new NextResponse(sid && hangupTwiml('This number is not configured for any account.'), {
      headers: { 'content-type': 'text/xml' },
    });
  }

  const inbound = ingestInbound({
    orgId: tenant.orgId,
    to,
    from,
    carrierCallId: sid,
    provider: 'twilio',
    customerName: params.CallerName || undefined,
  });

  if (inbound.error || !inbound.call || !inbound.config) {
    return new NextResponse(hangupTwiml('This line has no assistant assigned yet. Goodbye.'), {
      headers: { 'content-type': 'text/xml' },
    });
  }

  // Twilio's own recording + transcription settings ride on the call record so
  // the dashboard can show what the carrier was told to do.
  update<Doc>('calls', inbound.call.id, {
    telephony: {
      provider: 'twilio',
      carrierCallId: sid,
      signatureVerified: verified.enforced,
      direction: 'inbound',
    },
  });

  // Raw-audio mode: the worker answers, speaks the greeting itself, and can be
  // interrupted. Otherwise the carrier transcribes and posts a `gather`.
  const callbackOrigin = new URL(twilioWebhookUrl(req) ?? req.url).origin;
  if (answerModeFor({ orgId: tenant.orgId, number: tenant.number as Doc & { answerMode?: string } }) === 'media') {
    return new NextResponse(mediaTwimlFor({ origin: callbackOrigin, callId: inbound.call.id, callSid: sid }), {
      headers: { 'content-type': 'text/xml', 'x-request-id': inbound.call.id },
    });
  }

  const actionUrl = `${callbackOrigin}/api/telephony/twilio/gather?callSid=${encodeURIComponent(sid)}`;
  return new NextResponse(
    sayAndGather({
      text: inbound.config.firstMessage ?? `Thanks for calling. This is ${inbound.config.name}. How can I help?`,
      actionUrl,
      hints: 'order, refund, billing, appointment, cancel, hours, human, agent',
      timeout: 6,
    }),
    { headers: { 'content-type': 'text/xml', 'x-request-id': inbound.call.id } }
  );
}

/** Twilio falls back to GET when a redirect has no method; answer the same way. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const tenant = resolveTenantByNumber(url.searchParams.get('To') ?? '');
  if (!tenant) return new NextResponse(hangupTwiml('This number is not configured for any account.'), { headers: { 'content-type': 'text/xml' } });
  return new NextResponse(
    hangupTwiml('Please call back on a configured line.'),
    { headers: { 'content-type': 'text/xml' } }
  );
}
