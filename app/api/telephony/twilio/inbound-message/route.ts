import { NextResponse, type NextRequest } from 'next/server';
import { normaliseNumber, setConsent, findClientByNumber } from '@/lib/server/clients';
import { recordOutreach } from '@/lib/server/outreach';
import { audit } from '@/lib/server/audit';
import { recordAccess } from '@/lib/server/access-log';
import { handleClientReply } from '@/lib/server/inbound';
import { resolveTenantByNumber } from '@/lib/server/telephony';
import { verifyTwilioWebhook } from '@/lib/server/twilio-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inbound texts — the other half of the opt-out line.
 *
 * Every message this platform sends ends with "Reply STOP to opt out." Until now
 * nothing was listening, which made that a promise the product could not keep: a
 * patient who replied STOP to stop the texts would keep receiving them. That is
 * the one bug in a messaging system that is not merely embarrassing.
 *
 * So: STOP (and the synonyms carriers require — UNSUBSCRIBE, CANCEL, END, QUIT)
 * revokes SMS consent with the reply as the evidence, START/UNSTOP grants it back,
 * and both are written into the outreach log so the desk sees them in the thread.
 * Any other reply is recorded in the audit trail and left alone — an answer to a
 * question is a conversation, and this is not a chatbot.
 *
 * Twilio's advanced opt-out can also handle STOP at the carrier, which is
 * preferable when it is on: it replies automatically and blocks delivery further
 * upstream. Handling it here as well means the workspace's own record agrees with
 * the carrier's — because consent that only the carrier knows about is consent the
 * practice cannot show anybody.
 */

const OPT_OUT = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out'];
const OPT_IN = ['start', 'unstop', 'yes'];

function twiml(body?: string) {
  const message = body ? `<Message>${body}</Message>` : '';
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${message}</Response>`, {
    headers: { 'content-type': 'text/xml' },
  });
}

export async function POST(req: NextRequest) {
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

  const to = read('To');
  const from = normaliseNumber(read('From'));
  const body = read('Body').trim();
  const sid = read('MessageSid') || read('SmsMessageSid');
  const verified = verifyTwilioWebhook(req, params, [to, from]);
  if (!verified.ok) {
    return new NextResponse(`Refused: ${verified.reason ?? 'invalid carrier signature'}.`, { status: 403, headers: { 'content-type': 'text/plain' } });
  }

  // The workspace is the one that owns the number that was texted. Ambiguous
  // duplicate claims fail closed inside resolveTenantByNumber.
  const tenant = resolveTenantByNumber(to);
  const orgId = tenant?.orgId ?? '';
  if (!orgId || !from) return twiml();

  const keyword = body.toLowerCase().replace(/[^a-z]/g, '');
  const client = findClientByNumber(orgId, from);

  if (OPT_OUT.includes(keyword)) {
    if (client) {
      setConsent(orgId, client.id, 'sms', false, {
        source: 'inbound-sms',
        note: `Replied "${body}" to ${to}`,
        actor: 'carrier',
        actorName: 'Inbound SMS',
      });
    }
    recordOutreach({
      orgId,
      clientId: client?.id,
      channel: 'sms',
      kind: 'manual',
      outcome: 'opted_out',
      to: from,
      actor: 'carrier',
      detail: `inbound "${body}"`,
      meta: { inboundMessageId: sid, number: to, keyword },
    });
    audit({ orgId, actor: 'carrier', action: 'consent.withdrawn_by_reply', target: client?.id ?? from, detail: body.slice(0, 60) });
    if (client) {
      recordAccess({
        orgId,
        resource: 'client',
        resourceId: client.id,
        action: 'consent',
        actor: 'carrier',
        actorName: 'Inbound SMS',
        detail: 'sms consent withdrawn by reply',
      });
    }
    // No auto-reply: the carrier sends the confirmation, and a practice's own
    // second message is one more text to somebody who just asked for fewer.
    return twiml();
  }

  if (OPT_IN.includes(keyword)) {
    if (client) {
      setConsent(orgId, client.id, 'sms', true, {
        source: 'inbound-sms',
        note: `Replied "${body}" to ${to}`,
        actor: 'carrier',
        actorName: 'Inbound SMS',
      });
      audit({ orgId, actor: 'carrier', action: 'consent.granted_by_reply', target: client.id, detail: body.slice(0, 60) });
    }
    return twiml();
  }

  // Everything else is a reply to something the practice sent — and the copy the
  // practice sends invites exactly three answers: confirm, change it, or ask a
  // question. `handleClientReply` decides which, does the confirm or the cancel
  // through the desk's own path, files anything a person must do, and hands back
  // the sentence to send. Guessing a *new* appointment out of "maybe Thursday?"
  // is the one thing it deliberately will not do.
  const outcome = await handleClientReply({ orgId, from, body, to, messageId: sid });
  audit({
    orgId,
    actor: 'carrier',
    action: 'message.received',
    target: client?.id ?? from,
    detail: `${outcome.intent}: ${body.slice(0, 100)}`,
  });
  return twiml(outcome.reply);
}
