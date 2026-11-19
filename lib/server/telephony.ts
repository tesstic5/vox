/**
 * Telephony.
 *
 * This is how a phone number reaches the agent. The carrier is configured to
 * POST to these URLs (Twilio's console calls them "A call comes in" and "Call
 * status changes"), and we answer with TwiML — the same arrangement used by
 * every hosted voice platform.
 *
 * Two ingress modes are supported:
 *
 *   1. `<Gather input="speech">` — the carrier does the speech recognition and
 *      posts the transcript. Works on every Twilio number with no media server,
 *      which makes it the default.
 *   2. Media streams over WebSocket — the carrier sends raw audio frames. The
 *      ingest point is advertised in the TwiML (`<Connect><Stream>`) with a
 *      signed URL; the public deployment runs a media worker there and swaps the
 *      transcriber/voice providers in.
 */

import crypto from 'node:crypto';
import { get, insert, list, update, type Doc } from './db';
import { appendTurn, createCall, endCall, pickIntent, type CallDoc } from './calls';
import { runTurn, runTurnStreamed, type AgentConfig, type HistoryTurn } from './agent';
import { resolveModel } from './ai/credentials';
import { audit } from './audit';
import { mediaSecret } from './media/secret';
import { applyHandoff, handoffFor } from './squads';
import { recordOutreach, type OutreachDoc, type OutreachKind, type OutreachOutcome } from './outreach';
import { claimsForNumber } from './number-ownership';
import { decryptSecret } from './carriers';

export type TelephonyProvider = 'twilio';

function xmlEscape(value: string) {
  return value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}

/** Wraps TwiML in the XML preamble Twilio expects. */
export function twiml(body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

export function sayAndGather(input: {
  text: string;
  actionUrl: string;
  voice?: string;
  hints?: string;
  /** Twilio's own recogniser language; the assistant's language wins if set. */
  language?: string;
  timeout?: number;
}) {
  const voice = (input.voice ?? 'Polly.Joanna-Neural').replace(/[^\w.-]/g, '');
  return twiml(
    [
      `  <Gather input="speech" speechTimeout="auto" speechModel="phone_call" enhanced="true"`,
      `    action="${xmlEscape(input.actionUrl)}" method="POST"`,
      input.hints ? `    hints="${xmlEscape(input.hints)}"` : '',
      `    language="${xmlEscape(input.language ?? 'en-US')}" timeout="${input.timeout ?? 6}">`,
      `    <Say voice="${voice}">${xmlEscape(input.text)}</Say>`,
      '  </Gather>',
      '  <Redirect method="POST">/</Redirect>',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

export function hangupTwiml(text: string, voice = 'Polly.Joanna-Neural') {
  return twiml(`  <Say voice="${voice}">${xmlEscape(text)}</Say>\n  <Hangup/>`);
}

export function streamTwiml(input: { wssUrl: string; callId: string; token: string }) {
  return twiml(
    [
      '  <Connect>',
      `    <Stream url="${xmlEscape(input.wssUrl)}">`,
      `      <Parameter name="callId" value="${xmlEscape(input.callId)}"/>`,
      `      <Parameter name="token" value="${xmlEscape(input.token)}"/>`,
      '    </Stream>',
      '  </Connect>',
    ].join('\n')
  );
}

/**
 * Signs a media-stream handshake for one call. Expires in an hour.
 *
 * Returns an empty string when the deployment has no signing secret: the token
 * would be unverifiable anyway, and minting one on a guessable default is how a
 * forged stream gets in. `answerModeFor` keeps calls on the gather path in that
 * case, so this is a last-resort guard rather than the normal flow.
 */
export function mintMediaToken(callId: string, callSid: string) {
  const secret = mediaSecret();
  if (!secret) return '';
  const expires = Date.now() + 60 * 60 * 1000;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${callSid}:${callId}:${expires}`)
    .digest('base64url');
  return `${expires}.${signature}`;
}

/**
 * `<Connect><Stream>` for a call, pointing at this deployment's media worker.
 *
 * Used in two places: a number configured for raw-audio mode, and the
 * `/api/telephony/twilio/stream` bridge that a carrier can be pointed at
 * explicitly.
 */
export function mediaTwimlFor(input: { origin: string; callId: string; callSid: string }) {
  const wssUrl = `${input.origin.replace(/^http/, 'ws')}/api/telephony/twilio/media`;
  return streamTwiml({ wssUrl, callId: input.callId, token: mintMediaToken(input.callId, input.callSid) });
}

/**
 * How this number should be answered.
 *
 * `gather` lets the carrier transcribe (works everywhere, no media worker);
 * `media` streams raw audio to the worker, which is what enables barge-in and
 * provider-side models. Number setting → workspace setting → deployment default.
 */
export function answerModeFor(input: { orgId: string; number?: Doc & { answerMode?: string } }): 'gather' | 'media' {
  // Media mode needs a signing secret; without one the worker would reject the
  // handshake anyway, so the line is answered with carrier-side recognition.
  if (!mediaSecret()) return 'gather';
  if (input.number?.answerMode === 'media') return 'media';
  if (input.number?.answerMode === 'gather') return 'gather';
  const settings = list<Doc & { streaming?: boolean; answerMode?: string }>('providerSettings', (s) => s.orgId === input.orgId)[0];
  if (settings?.answerMode === 'media' || settings?.streaming === true) return 'media';
  if (process.env.VOXERA_ANSWER_MODE === 'media') return 'media';
  return 'gather';
}

/**
 * The auth token used to verify a request from a given number.
 *
 * A carrier connected through the dashboard stores its own token, so verification
 * works per workspace instead of requiring a deployment-wide env var.
 */
export function authTokenForNumber(e164: string) {
  const tenant = resolveTenantByNumber(e164);
  if (!tenant) return process.env.TWILIO_AUTH_TOKEN;
  const number = tenant.number as Doc & { carrierId?: string };
  const carrier = number.carrierId
    ? get<Doc & { encrypted?: string; iv?: string; authTag?: string }>('carriers', String(number.carrierId))
    : undefined;
  if (carrier) {
    const token = decryptSecret(carrier as never);
    if (token) return token;
  }
  return process.env.TWILIO_AUTH_TOKEN;
}

/**
 * Verifies a Twilio request signature.
 *
 * Twilio signs `url + sorted(form params)` with the account auth token, so a
 * request with a valid signature is proof it came from the carrier.
 *
 * The awkward case is a request we *cannot* verify — no token on the number, no
 * `TWILIO_AUTH_TOKEN` on the deployment. That used to be waved through, which
 * meant a deployment that forgot one env var would answer and act on forged
 * webhooks. It now fails closed in production and says why. Only a non-production
 * process may opt into unsigned local-stub traffic explicitly.
 */
export function verifyTwilioSignature(input: {
  signature: string | null;
  url: string;
  params: Record<string, string>;
  authToken?: string;
}): { ok: boolean; enforced: boolean; reason?: string } {
  const token = input.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    const development = (process.env.NODE_ENV ?? 'development') !== 'production';
    if (development && process.env.VOXERA_ALLOW_UNSIGNED_TELEPHONY === '1') {
      return { ok: true, enforced: false };
    }
    return {
      ok: false,
      enforced: false,
      reason:
        'no auth token is configured for this number, and the deployment has no TWILIO_AUTH_TOKEN, so the request cannot be verified',
    };
  }
  if (!input.signature) return { ok: false, enforced: true, reason: 'the request carried no X-Twilio-Signature' };
  const payload =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((k) => `${k}${input.params[k]}`)
      .join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(payload, 'utf-8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, enforced: true } as const;
}

/** Finds the number record a carrier dialled into. */
export function numberFor(orgId: string, e164: string) {
  return list<Doc & { number?: string; assistantId?: string | null; label?: string; fallbackNumber?: string }>(
    'numbers',
    (n) => n.orgId === orgId && String(n.number ?? '').replace(/[^\d+]/g, '') === e164.replace(/[^\d+]/g, '')
  )[0];
}

export function assistantConfigFor(assistantId: string, orgId: string): AgentConfig | undefined {
  const a = get<Doc & Record<string, unknown>>('assistants', assistantId);
  if (!a || a.orgId !== orgId) return undefined;
  const toolNames = (a.tools as string[] | undefined) ?? [];
  const tools = list<Doc & { orgId?: string; name: string; description?: string }>('tools', (t) => t.orgId === orgId).filter(
    (t) => toolNames.includes(t.name) || toolNames.length === 0
  );
  return {
    id: assistantId,
    name: String(a.name ?? 'Assistant'),
    firstMessage: a.firstMessage as string | undefined,
    systemPrompt: a.systemPrompt as string | undefined,
    model: a.model as string | undefined,
    temperature: a.temperature as number | undefined,
    company:
      (a.company as string | undefined) ??
      String(get<Doc & { name?: string }>('orgs', orgId)?.name ?? 'the business'),
    knowledge: (a.knowledge as string[] | undefined) ?? [],
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    ai: resolveModel({ orgId, model: a.model as string | undefined, provider: a.provider as string | undefined }),
  };
}

/* ------------------------------------------------------------- call registry */

/**
 * Maps a carrier's call SID to our call record, so the gather/status webhooks —
 * which carry only the SID — can find the conversation they belong to.
 */
export function rememberCarrierCall(sid: string, callId: string, orgId: string) {
  const existing = get<Doc>('carrierCalls', sid);
  if (existing) return existing;
  return insert<Doc>('carrierCalls', { id: sid, callId, orgId } as Doc);
}

/**
 * Which tenant does this dialled number belong to?
 *
 * A carrier posts to one deployment for every customer, so the number that was
 * dialled is what identifies the workspace. Numbers are unique platform-wide.
 */
export function resolveTenantByNumber(e164: string) {
  const claims = claimsForNumber(e164);
  // Ambiguity must fail closed. Picking the first duplicate would route a call,
  // signature token, and transcript into an arbitrary tenant.
  if (claims.length !== 1) return undefined;
  const number = claims[0] as Doc & { number?: string; orgId: string; assistantId?: string | null };
  return { orgId: String(number.orgId), number };
}

export function carrierCall(sid: string) {
  return get<Doc & { callId: string; orgId: string }>('carrierCalls', sid);
}

/* ---------------------------------------------------------------- turn engine */

/**
 * One turn of a phone conversation.
 *
 * The carrier has already transcribed the caller (or a media worker did), so
 * this takes text in and gives speech text back — tools, guardrails, knowledge
 * retrieval and intent all run exactly as they do on a web call.
 */
export async function telephonyTurn(input: {
  call: CallDoc;
  orgId: string;
  text: string;
  /** True while the caller is mid-sentence; used to decide whether to wait. */
  partial?: boolean;
}) {
  const config = assistantConfigFor(input.call.assistantId, input.orgId);
  if (!config) return undefined;


  // The turn is run exactly once, by appendTurn, and the reply it returns is the
  // reply that gets spoken. Running it here as well would double a model bill and
  // — worse — let the caller hear one answer while the record kept another.
  const recorded = await appendTurn({
    orgId: input.orgId,
    callId: input.call.id,
    text: input.text,
    // Phone callers cannot barge in on a tool call, so give them the answer.
    patience: true,
  });
  if ('error' in recorded) return undefined;
  const result = recorded.turn;

  // A transfer goes one of two ways. If the assistant belongs to a squad with a
  // member after it, the call hands off inside Voxera: the next assistant takes
  // over, and the handoff is written into the transcript as a `system` event
  // carrying the brief. Only when there is no next member does the transport do
  // what it always did — hang up and forward to the number's target.
  const handoff = result.intent === 'transfer' ? handoffFor(input.orgId, input.call.assistantId) : undefined;
  if (handoff) {
    const call = recorded.call ?? input.call;
    applyHandoff({
      orgId: input.orgId,
      callId: call.id,
      handoff,
      atSeconds: call.durationSeconds ?? input.call.durationSeconds,
    });
  }

  const forwarded = result.intent === 'transfer' && !handoff;
  const transferTarget = forwarded
    ? numberFor(input.orgId, input.call.to)?.fallbackNumber ?? numberFor(input.orgId, input.call.from)?.fallbackNumber
    : undefined;
  if (forwarded) {
    audit({
      orgId: input.orgId,
      actor: 'telephony',
      action: 'call.forwarded',
      target: input.call.id,
      detail: transferTarget
        ? `transfer requested after ${input.call.transcript.length} turns to configured fallback`
        : `transfer requested after ${input.call.transcript.length} turns but no fallback number is configured`,
    });
  }

  return { result, call: recorded.call ?? input.call, forwarded, transferTarget, handoff };
}

/** Ends a phone call, recording why the carrier says it finished. */
export function endTelephonyCall(input: { orgId: string; callId: string; status?: string; durationSeconds?: number }) {
  const reason =
    input.status === 'no-answer'
      ? 'customer-busy'
      : input.status === 'failed' || input.status === 'busy'
        ? 'error'
        : 'customer-ended-call';
  const call = endCall({ orgId: input.orgId, callId: input.callId, endedReason: reason });
  const finished = call && input.durationSeconds && input.durationSeconds > call.durationSeconds
    ? update<CallDoc>('calls', call.id, { durationSeconds: input.durationSeconds })
    : call;
  if (finished) recordCallOutreach(finished, input.status);
  return finished;
}

/**
 * A finished call is an outreach fact.
 *
 * Written here because this is the one place a call reaches a terminal state —
 * carrier webhook, agent hand-off, or a test ending it deliberately — and the
 * outcome of a call belongs in the same timeline as the texts. Idempotent by call
 * id: a carrier that fires its callback twice does not write two rows.
 */
function recordCallOutreach(call: CallDoc, carrierStatus?: string) {
  if (list<OutreachDoc>('outreach', (row) => row.callId === call.id).length) return;
  const campaign = call.campaignId
    ? list<Doc & { kind?: string }>('bookingCampaigns', (c) => c.id === call.campaignId)[0]
    : undefined;
  const kind = (campaign?.kind === 'confirm'
    ? 'confirmation'
    : campaign?.kind === 'remind'
      ? 'reminder'
      : campaign?.kind === 'winback'
        ? 'winback'
        : campaign?.kind === 'followup'
          ? 'followup'
          : 'manual') as OutreachKind;
  const noAnswer = carrierStatus === 'no-answer' || carrierStatus === 'busy' || call.endedReason === 'customer-busy';
  const failed = carrierStatus === 'failed' || call.endedReason === 'error';
  const outcome: OutreachOutcome = noAnswer ? 'no_answer' : failed ? 'failed' : 'answered';
  recordOutreach({
    orgId: String(call.orgId),
    clientId: undefined,
    bookingId: call.bookingId,
    channel: 'call',
    kind,
    outcome,
    to: String(call.to ?? ''),
    callId: call.id,
    campaignId: call.campaignId,
    actor: call.campaignId ? 'campaign' : 'agent',
    detail: call.durationSeconds ? `${call.durationSeconds}s` : `ended: ${carrierStatus ?? call.endedReason ?? 'unknown'}`,
    meta: { assistant: String(call.assistantName ?? ''), endedReason: String(call.endedReason ?? '') },
  });
}

/* ------------------------------------------------------------------- inbound */

/**
 * Starts (or resumes) the call record for an inbound carrier call. Returns
 * everything the route needs to render TwiML.
 */
export function ingestInbound(input: {
  orgId: string;
  to: string;
  from: string;
  carrierCallId: string;
  provider: TelephonyProvider;
  customerName?: string;
}) {
  const number = numberFor(input.orgId, input.to);
  const assistantId = String(number?.assistantId ?? '');
  const config = assistantId ? assistantConfigFor(assistantId, input.orgId) : undefined;
  if (!config) {
    return { error: 'no_assistant' as const, number };
  }

  const { call } = createCall({
    orgId: input.orgId,
    assistantId,
    type: 'inbound',
    from: input.from,
    to: input.to,
    numberId: number ? String(number.id) : undefined,
    customer: { name: input.customerName ?? 'Phone caller', number: input.from },
    source: 'phone',
  });
  if (!call) return { error: 'call_create_failed' as const, number };
  rememberCarrierCall(input.carrierCallId, call.id, input.orgId);
  audit({
    orgId: input.orgId,
    actor: 'telephony',
    action: 'call.inbound',
    target: call.id,
    detail: `${input.provider} ${input.from} → ${input.to} answered by ${config.name}`,
  });
  return { call, config, number };
}

/** Transcribes a call's history for a media-stream worker or a debugging read. */
export function transcriptFor(callId: string, orgId: string) {
  const call = get<CallDoc>('calls', callId);
  if (!call || call.orgId !== orgId) return undefined;
  return {
    callId,
    intent: pickIntent(call.analysis.intent, undefined),
    turns: call.transcript,
    tools: call.toolCalls ?? [],
    guardrails: call.guardrails ?? [],
  };
}

export { runTurnStreamed };
