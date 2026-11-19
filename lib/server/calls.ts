/**
 * Call lifecycle: create → turns → end.
 *
 * A call is a real record with a real transcript produced by the agent runtime.
 * Ending one writes a usage event, updates the assistant's rolling stats,
 * posts a webhook, and leaves an audit entry — so the calls list, analytics,
 * billing and observability pages are all reading the same facts.
 */

import { flushNow, get, insert, list, listAllByOrg, newId, nowIso, update, type Doc } from './db';
import { runTurn, type AgentConfig, type HistoryTurn, type ToolCall } from './agent';
import { resolveModel } from './ai/credentials';
import { deliverWebhook } from './webhooks';
import { findClientByNumber, touchClientInteraction } from './clients';
import { meterMinutes } from './metering';
import { ensureDraftNoteForCall } from './notes';
import { buildAnalytics, type AnalyticsReport } from '../analytics';

export type CallDoc = Doc & {
  orgId: string;
  assistantId: string;
  assistantName: string;
  type: 'inbound' | 'outbound' | 'web';
  status: 'ended' | 'in-progress' | 'queued' | 'failed';
  endedReason: string;
  from: string;
  to: string;
  numberId?: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  cost: { platform: number; stt: number; tts: number; llm: number; telephony: number; total: number };
  /** Present only when a provider import or operator supplied the cost. */
  costSource?: 'provider_import' | 'operator';
  transcript: { role: 'assistant' | 'user' | 'system' | 'tool'; text: string; at: number; seconds: number; engine?: string }[];
  toolCalls?: ToolCall[];
  guardrails?: { kind: string; action: string; note: string }[];
  recordingUrl: string | null;
  analysis: {
    summary: string;
    successEvaluation: 'true' | 'false' | 'not_evaluated';
    sentiment: 'positive' | 'neutral' | 'negative';
    intent: string;
    structuredData: Record<string, string | number | boolean>;
    score: number;
    /** Absent means no explicit rubric/human evaluation supplied this verdict. */
    evaluationSource?: 'rubric' | 'human';
    /** Every distinct intent observed, in order — the call's journey. */
    intents?: string[];
    /** Which engine answered: a provider id, or `rules`. */
    engine?: string;
    /** The model label the dashboard shows. */
    model?: string;
  };
  metrics: {
    latencyMs: number;
    interruptions: number;
    turns: number;
    /** Measured on the caller's device: end of speech → first agent audio. */
    voiceToVoiceMs?: number;
    v2vSamples?: number;
    /** Transcriber turnaround, measured on the device. */
    sttMs?: number;
    /** Time from turn request to first speakable text, measured server-side. */
    ttfaMs?: number;
    /** Wall-clock duration of the most recent turn, client side. */
    lastTurn?: number;
  };
  customer: { name: string; number: string; company?: string };
  /** Who originated the call: `dashboard`, `api`, `batch`, `simulation`, or `phone`. */
  source?: string;
  /** Rolling memory of the thread, so follow-ups land in the right context. */
  context?: { lastIntent?: string; followedUp?: boolean };
  /** Carrier-side facts for phone calls. Signature evidence exists only inbound. */
  telephony?: {
    provider: string;
    carrierCallId: string;
    direction: string;
    signatureVerified?: boolean;
    providerAcceptedAt?: string;
    error?: string;
  };
  /** Device-reported media facts (browser, mic device). */
  media?: { device?: string; browser?: string; reportedAt?: string };
  /** Set when this call exists to act on a booking — the link back to it. */
  bookingId?: string;
  /** Set when a campaign queued the call, so its stats can follow the outcome. */
  campaignId?: string;
  /** The brief the agent was given for this call, when it is not the assistant's default. */
  purpose?: string;
};

/** Intents that carry no reason-for-calling and should never become the label. */
const TRIVIAL_INTENTS = new Set(['greeting', 'smalltalk', 'goodbye', 'repeat', 'unknown']);

/**
 * A call's intent is its reason for calling, not whatever was said last.
 * The first substantive intent wins; an escalation always overrides it, because
 * "did this end up with a human" is the question the analytics are asking.
 */
export function pickIntent(current: string | undefined, next: string | undefined) {
  if (!next || next === 'unknown') return current || 'unknown';
  if (next === 'transfer') return next;
  if (!current || current === 'unknown') return next;
  if (TRIVIAL_INTENTS.has(current) && !TRIVIAL_INTENTS.has(next)) return next;
  return current;
}

function assistantConfig(assistantId: string, orgId: string): AgentConfig | undefined {
  const a = get<Doc & Record<string, unknown>>('assistants', assistantId);
  if (!a || (a as { orgId?: string }).orgId !== orgId) return undefined;
  const tools = (a.tools as string[] | undefined) ?? [];
  const toolDefs = list<Doc & { orgId?: string; name: string; description?: string }>('tools', (t) => t.orgId === orgId);
  const knowledge = (a.knowledge as string[] | undefined) ?? [];
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
    knowledge,
    tools: toolDefs
      .filter((t) => tools.includes(t.name) || tools.length === 0)
      .map((t) => ({ name: t.name, description: t.description })),
    // Which model answers, if this workspace (or the deployment) has a key for
    // one. Undefined means the deterministic rule engine takes the turn.
    ai: resolveModel({ orgId, model: a.model as string | undefined, provider: a.provider as string | undefined }),
  };
}

export function createCall(input: {
  orgId: string;
  assistantId: string;
  type: 'inbound' | 'outbound' | 'web';
  from: string;
  to: string;
  numberId?: string;
  customer?: { name: string; number: string; company?: string };
  source?: string;
  bookingId?: string;
  campaignId?: string;
  /** A per-call brief the agent follows instead of the assistant's own prompt. */
  purpose?: string;
}): { call?: CallDoc; error?: string } {
  const config = assistantConfig(input.assistantId, input.orgId);
  if (!config) return { error: 'assistant_not_found' };

  const call = insert<CallDoc>('calls', {
    id: `call_${newId('').slice(1, 13)}`,
    orgId: input.orgId,
    assistantId: input.assistantId,
    assistantName: config.name,
    type: input.type,
    status: 'in-progress',
    endedReason: 'customer-ended-call',
    from: input.from,
    to: input.to,
    numberId: input.numberId,
    startedAt: nowIso(),
    durationSeconds: 0,
    cost: { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 },
    transcript: config.firstMessage
      ? [{ role: 'assistant', text: config.firstMessage, at: 0, seconds: 0 }]
      : [],
    toolCalls: [],
    guardrails: [],
    recordingUrl: null,
    analysis: {
      summary: '',
      successEvaluation: 'not_evaluated',
      sentiment: 'neutral',
      intent: 'unknown',
      intents: [],
      structuredData: {},
      score: 0,
    },
    metrics: { latencyMs: 0, interruptions: 0, turns: 0, voiceToVoiceMs: undefined, v2vSamples: 0 },
    customer: input.customer ?? { name: 'Unknown caller', number: input.from },
    source: input.source ?? 'dashboard',
    bookingId: input.bookingId,
    campaignId: input.campaignId,
    purpose: input.purpose,
  } as CallDoc);

  // A call is an interaction: the client's record should say so tonight, not
  // when someone remembers to update it.
  const touched = (input.customer?.number ?? (input.type === 'inbound' ? input.from : '')) || '';
  if (touched) void touchClientInteraction(input.orgId, touched);

  // Written through immediately. The carrier opens its media stream as soon as it
  // has the TwiML, and that stream is served by a second copy of this store — so
  // a call that exists only in this process's cache would not be found, and the
  // handshake would be rejected as an unknown call.
  flushNow();

  return { call };
}

export async function appendTurn(input: {
  orgId: string;
  callId: string;
  text: string;
  /**
   * Backfill support: seeded history passes an explicit offset so a call's
   * duration reflects the conversation rather than how fast the seeder ran.
   * Live calls omit it and use the wall clock.
   */
  offsetSeconds?: number;
  /**
   * Telemetry measured on the caller's device — the microphone side, which the
   * server cannot observe: how long the transcriber took, and the full
   * voice-to-voice gap (their last word → the agent's first audio).
   */
  voice?: { voiceToVoiceMs?: number; sttMs?: number; clientTurnMs?: number };
  /**
   * Transports with no barge-in (a phone) want the agent to finish its thought
   * rather than defer to an interruption that cannot happen.
   */
  patience?: boolean;
  /**
   * Who is on the dashboard end of this turn, when it is a browser call. A phone
   * call has no entry here and the report tool falls back to matching the
   * caller's number against the team's.
   */
  viewer?: { name?: string; email?: string; role?: string };
}) {
  const call = get<CallDoc>('calls', input.callId);
  if (!call || call.orgId !== input.orgId) return { error: 'not_found' as const };
  if (call.status !== 'in-progress') return { error: 'call_ended' as const };

  const config = assistantConfig(call.assistantId, call.orgId);
  if (!config) return { error: 'assistant_not_found' as const };

  const history: HistoryTurn[] = call.transcript
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text }));

  const userTurnIndex = call.transcript.filter((t) => t.role === 'user').length;
  const result = await runTurn({
    config,
    history,
    userText: input.text,
    callId: call.id,
    turnIndex: userTurnIndex,
    // Earlier intents in this call are how follow-ups ("Thursday works") are
    // understood; a stateless classifier would treat them as new requests.
    priorIntents: call.analysis.intents ?? (call.analysis.intent !== 'unknown' ? [call.analysis.intent] : []),
    priorSlots: call.analysis.structuredData as Record<string, string>,
    patience: input.patience,
    // Where the booking tools find the real record: the booking this call was
    // queued for, or the caller's own number for an inbound confirmation call.
    orgId: call.orgId,
    bookingId: call.bookingId,
    // Only an inbound call carries the customer's own number; on an outbound
    // call the "to" field is an internal number and must never be matched
    // against a booking. A browser test call is the exception the rule was
    // never about: whoever opened it typed their own number, and the agent
    // should be able to book them in rather than hit a wall.
    callerNumber:
      call.type === 'inbound' ? call.from : call.type === 'web' ? call.customer?.number : undefined,
    timezone: call.analysis.structuredData?.timezone as string | undefined,
    // Authentication on the HTTP turn endpoint proves who is operating the
    // dashboard, not who is on an inbound phone call. Only a browser/web call may
    // inherit that viewer. Otherwise an owner replaying an inbound turn would
    // accidentally elevate an unknown caller to owner-only report access.
    viewer: call.type === 'web' ? input.viewer : undefined,
  });

  const seconds =
    input.offsetSeconds ??
    Math.max(1, Math.round((Date.now() - new Date(call.startedAt).getTime()) / 1000));
  const transcript = [
    ...call.transcript,
    { role: 'user' as const, text: input.text, at: seconds, seconds, engine: result.engine },
    { role: 'assistant' as const, text: result.reply, at: seconds, seconds, engine: result.engine },
  ];

  const toolCalls = [...(call.toolCalls ?? []), ...result.toolCalls];
  const guardrails = result.guardrail ? [...(call.guardrails ?? []), result.guardrail] : call.guardrails ?? [];
  const turns = transcript.filter((t) => t.role === 'user').length;
  const priorAvg = call.metrics.latencyMs || result.latencyMs;
  const latencyMs = Math.round((priorAvg * (turns - 1) + result.latencyMs) / turns);

  // Voice-to-voice is averaged across the call the same way latency is, so a
  // single slow turn cannot flatter or wreck the number.
  const v2vSample =
    input.voice?.voiceToVoiceMs && input.voice.voiceToVoiceMs > 0 ? Math.round(input.voice.voiceToVoiceMs) : undefined;
  const priorV2V = call.metrics.voiceToVoiceMs ?? 0;
  const v2vTurns = call.metrics.v2vSamples ?? 0;
  const voiceToVoiceMs = v2vSample
    ? Math.round((priorV2V * v2vTurns + v2vSample) / (v2vTurns + 1))
    : call.metrics.voiceToVoiceMs;

  const updated = update<CallDoc>('calls', call.id, {
    transcript,
    toolCalls,
    guardrails,
    status: 'in-progress',
    // Remember what the caller was mid-way through, for the next turn.
    context: { lastIntent: pickIntent(call.analysis.intent, result.intent), followedUp: Boolean(result.continued) },
    durationSeconds: seconds,
    metrics: {
      latencyMs,
      ...(result.firstChunkMs ? { ttfaMs: result.firstChunkMs } : {}),
      interruptions: call.metrics.interruptions,
      turns,
      voiceToVoiceMs,
      v2vSamples: v2vSample ? v2vTurns + 1 : v2vTurns,
      sttMs: input.voice?.sttMs ? Math.round(input.voice.sttMs) : call.metrics.sttMs,
      lastTurn: input.voice?.clientTurnMs,
    },
    analysis: {
      ...call.analysis,
      // Which engine actually produced the words on this call, so the dashboard
      // can be honest about it (and an operator can see a key that stopped working).
      engine: result.engine ?? call.analysis.engine,
      model: result.model ?? call.analysis.model,
      intent: pickIntent(call.analysis.intent, result.intent),
      intents: Array.from(new Set([...(call.analysis.intents ?? []), result.intent])).filter((i) => i && i !== 'unknown'),
      // Extracted entities become the call's structured output — what an
      // integrator reads back out of the API after the call.
      structuredData: {
        ...call.analysis.structuredData,
        ...Object.fromEntries(Object.entries(result.slots ?? {}).filter(([, v]) => v)),
      },
      // Do not infer satisfaction or a quality score from turn count. A hostile
      // guardrail is an observed signal; otherwise these remain unevaluated.
      sentiment: result.guardrail?.kind === 'hostile' ? 'negative' : call.analysis.sentiment,
      score: call.analysis.score,
    },
  });

  return { call: updated, turn: result };
}

export function endCall(input: {
  orgId: string;
  callId: string;
  endedReason?: string;
  summary?: string;
  /** Backfill support — see appendTurn. Live calls omit it. */
  endedAt?: string;
}) {
  const call = get<CallDoc>('calls', input.callId);
  if (!call || call.orgId !== input.orgId) return undefined;

  const endedAt = input.endedAt ?? nowIso();
  const durationSeconds = Math.max(
    call.durationSeconds,
    Math.round((new Date(endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000)
  );
  const minutes = durationSeconds / 60;
  // Cost fields are populated only from observed provider or operator inputs.
  // Ending a call does not invent a tariff from its duration.
  const cost = call.cost ?? { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 };

  const userTurns = call.transcript.filter((t) => t.role === 'user');
  const updated = update<CallDoc>('calls', call.id, {
    status: 'ended',
    endedReason: input.endedReason ?? 'customer-ended-call',
    endedAt,
    durationSeconds,
    cost,
    analysis: {
      ...call.analysis,
      successEvaluation: call.analysis.successEvaluation ?? 'not_evaluated',
      summary:
        input.summary ??
        (userTurns.length
          ? `${userTurns.length} caller turn${userTurns.length === 1 ? '' : 's'} captured; no outcome evaluation was run.`
          : 'No caller speech was captured before the call ended.'),
    },
  });
  if (!updated) return undefined;

  // The write-up (P5). A call about an appointment leaves a draft note for a
  // person to read and sign — but only when the assistant that took the call can
  // actually keep notes, only once per call, and never for a call where nobody
  // spoke. The agent drafts; it does not sign. See `notes.ts`.
  if (call.bookingId && userTurns.length) {
    const config = assistantConfig(call.assistantId, call.orgId);
    const keepsNotes = (config?.tools ?? []).some((t) => t.name === 'draft_note');
    if (keepsNotes) {
      const client = findClientByNumber(call.orgId, String(call.customer?.number ?? ''));
      if (client) {
        ensureDraftNoteForCall({
          orgId: call.orgId,
          callId: call.id,
          bookingId: call.bookingId,
          clientId: client.id,
          serviceId: (call as Doc & { serviceId?: string }).serviceId,
          providerId: (call as Doc & { providerId?: string }).providerId,
          summary: updated.analysis.summary,
        });
      }
    }
  }

  // The organisation's own balance moves with the call, so the number the
  // dashboard and the API report is the number that actually happened.
  meterMinutes(call.orgId, minutes);

  // usage event drives billing + analytics
  insert<Doc>('usageEvents', {
    id: newId('use_'),
    orgId: call.orgId,
    assistantId: call.assistantId,
    callId: call.id,
    kind: 'call',
    minutes: Number(minutes.toFixed(4)),
    cost,
    costSource: call.costSource,
    at: endedAt,
  } as Doc);

  // running stats on the assistant
  const assistant = get<Doc & { calls?: number; minutes?: number; containment?: number; evaluatedCalls?: number }>('assistants', call.assistantId);
  if (assistant) {
    const calls = (assistant.calls ?? 0) + 1;
    const priorMinutes = assistant.minutes ?? 0;
    const evaluated = updated.analysis.successEvaluation === 'true' || updated.analysis.successEvaluation === 'false';
    const priorEvaluated = assistant.evaluatedCalls ?? 0;
    const patch: Record<string, unknown> = {
      calls,
      minutes: Number((priorMinutes + minutes).toFixed(2)),
      lastCallAt: endedAt,
    };
    if (evaluated) {
      const evaluatedCalls = priorEvaluated + 1;
      const priorContainment = assistant.containment ?? 0;
      patch.evaluatedCalls = evaluatedCalls;
      patch.containment = Number(
        (((priorContainment * priorEvaluated) + (updated.analysis.successEvaluation === 'true' ? 100 : 0)) / evaluatedCalls).toFixed(1)
      );
    }
    update('assistants', call.assistantId, patch);
  }

  insert<Doc>('audit', {
    id: newId('aud_'),
    orgId: call.orgId,
    actor: 'system',
    action: 'call.ended',
    target: call.id,
    at: endedAt,
    detail: `${call.type} call with ${call.customer.name} ended after ${durationSeconds}s`,
  } as Doc);

  void deliverWebhook({
    orgId: call.orgId,
    event: 'call.ended',
    payload: {
      type: 'call.ended',
      call: {
        id: call.id,
        assistantId: call.assistantId,
        status: 'ended',
        durationSeconds,
        cost: cost.total,
        endedReason: updated.endedReason,
        transcript: updated.transcript,
        analysis: updated.analysis,
      },
    },
  });

  return updated;
}

/**
 * One-time repair for records written by the former duration-rate and automatic
 * "resolved" heuristics. Those values had no provider receipt or rubric. Keep
 * explicit future imports/evaluations (identified by source fields), but turn
 * unsupported legacy claims into honest unavailable state.
 */
export function normalizeLegacyInferredCallClaims() {
  // Recheck under a new marker: some stores recorded v1 before usage-event and
  // evaluation cleanup was complete, so trusting that old marker left claims in
  // place. V3 audits the rows again and is independently idempotent.
  const claimsMigrationId = 'migration_call_claims_recheck_v3';
  const rentalsMigrationId = 'migration_number_rental_claims_v2';
  const legacyNumbersMigrationId = 'migration_legacy_number_capabilities_v1';
  const claimsDone = Boolean(get<Doc>('migrations', claimsMigrationId));
  const rentalsDone = Boolean(get<Doc>('migrations', rentalsMigrationId));
  const legacyNumbersDone = Boolean(get<Doc>('migrations', legacyNumbersMigrationId));
  if (claimsDone && rentalsDone && legacyNumbersDone) return { migrated: false, calls: 0, usageEvents: 0, numbers: 0 };

  let changedCalls = 0;
  let changedUsage = 0;
  let changedNumbers = 0;
  const touchedOrgs = new Set<string>();

  if (!claimsDone) {
    for (const org of list<Doc & { id: string }>('orgs')) for (const call of listAllByOrg<CallDoc>('calls', org.id)) {
      let changed = false;
      const patch: Partial<CallDoc> = {};
      if (!call.costSource && Object.values(call.cost ?? {}).some((value) => Number(value) !== 0)) {
        patch.cost = { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 };
        changed = true;
      }
      if (!call.analysis.evaluationSource && call.analysis.successEvaluation !== 'not_evaluated') {
        const callerTurns = call.transcript.filter((turn) => turn.role === 'user').length;
        const oldSummary = String(call.analysis.summary ?? '');
        const inferredSummary = /Caller raised .*the agent (resolved|escalated)/i.test(oldSummary);
        patch.analysis = {
          ...call.analysis,
          successEvaluation: 'not_evaluated',
          score: 0,
          sentiment: call.guardrails?.some((guardrail) => guardrail.kind === 'hostile') ? 'negative' : 'neutral',
          summary: inferredSummary
            ? callerTurns
              ? `${callerTurns} caller turn${callerTurns === 1 ? '' : 's'} captured; no outcome evaluation was run.`
              : 'No caller speech was captured before the call ended.'
            : oldSummary,
        };
        changed = true;
      }
      if (changed) {
        update<CallDoc>('calls', call.id, patch);
        changedCalls += 1;
        touchedOrgs.add(call.orgId);
      }
    }

    for (const event of list<Doc & { cost?: Record<string, number>; costSource?: string }>('usageEvents')) {
      if (event.costSource || !event.cost || !Object.values(event.cost).some((value) => Number(value) !== 0)) continue;
      update('usageEvents', event.id, { cost: { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 } });
      changedUsage += 1;
      if (event.orgId) touchedOrgs.add(String(event.orgId));
    }

    for (const assistant of list<Doc & { orgId?: string }>('assistants')) {
      const explicit = assistant.orgId
        ? listAllByOrg<CallDoc>('calls', assistant.orgId).filter(
            (call) => call.assistantId === assistant.id && Boolean(call.analysis.evaluationSource),
          )
        : [];
      const passed = explicit.filter((call) => call.analysis.successEvaluation === 'true').length;
      update('assistants', assistant.id, {
        evaluatedCalls: explicit.length,
        containment: explicit.length ? Number(((passed / explicit.length) * 100).toFixed(1)) : undefined,
      });
    }
  }

  if (!rentalsDone) {
    for (const number of list<Doc & { monthlyCost?: number; monthlyCostSource?: string; orgId?: string }>('numbers')) {
      if (number.monthlyCostSource || number.monthlyCost === undefined || number.monthlyCost === null) continue;
      update('numbers', number.id, { monthlyCost: undefined });
      changedNumbers += 1;
      if (number.orgId) touchedOrgs.add(String(number.orgId));
    }
  }

  if (!legacyNumbersDone) {
    for (const number of list<Doc & { number?: string; provider?: string; status?: string; carrierId?: string; carrierSid?: string; orgId?: string }>('numbers')) {
      const looksDialable = /^\+[1-9]\d{7,14}$/.test(String(number.number ?? '').replace(/[^\d+]/g, ''));
      const wasPresentedAsCarrierLine = looksDialable && number.provider !== 'sandbox' && number.status !== 'released';
      if (!wasPresentedAsCarrierLine || number.carrierId || number.carrierSid) continue;
      update('numbers', number.id, {
        status: 'unavailable',
        provider: 'legacy_unverified',
        legacyUnavailable: true,
        unavailableReason: 'No carrier account or carrier number SID was ever recorded for this legacy line.',
      });
      changedNumbers += 1;
      if (number.orgId) touchedOrgs.add(String(number.orgId));
    }
  }

  for (const orgId of touchedOrgs) {
    insert<Doc>('audit', {
      id: newId('aud_'),
      orgId,
      actor: 'migration',
      action: 'call.unsupported_claims_removed',
      target: 'calls',
      detail: 'Removed inferred call cost, number rental, outcome, or carrier-line claims that had no provider receipt, carrier identity, or explicit evaluation.',
      at: nowIso(),
    } as Doc);
  }
  if (!claimsDone) {
    insert<Doc>('migrations', {
      id: claimsMigrationId,
      at: nowIso(),
      changedCalls,
      changedUsage,
    } as Doc);
  }
  if (!rentalsDone) {
    insert<Doc>('migrations', {
      id: rentalsMigrationId,
      at: nowIso(),
      changedNumbers,
    } as Doc);
  }
  if (!legacyNumbersDone) {
    insert<Doc>('migrations', {
      id: legacyNumbersMigrationId,
      at: nowIso(),
      changedNumbers,
    } as Doc);
  }
  flushNow();
  return { migrated: true, calls: changedCalls, usageEvents: changedUsage, numbers: changedNumbers };
}

export function callsForDay(orgId: string, days: number) {
  const since = Date.now() - days * 86400000;
  return listAllByOrg<CallDoc>('calls', orgId).filter((c) => new Date(c.startedAt).getTime() >= since);
}

/** Percentiles and aggregates computed from stored calls — not seeded. */
export function metricsFor(orgId: string, days = 7) {
  const calls = callsForDay(orgId, days);
  const ended = calls.filter((c) => c.status === 'ended');
  const latencies = ended.map((c) => c.metrics.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);
  const totalMinutes = ended.reduce((n, c) => n + c.durationSeconds / 60, 0);
  const totalCost = ended.reduce((n, c) => n + c.cost.total, 0);
  const evaluated = ended.filter((c) => c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false');
  const contained = evaluated.filter((c) => c.analysis.successEvaluation === 'true').length;
  const guardrailHits = ended.reduce((n, c) => n + (c.guardrails?.length ?? 0), 0);

  return {
    window: `${days}d`,
    calls: calls.length,
    ended: ended.length,
    inProgress: calls.length - ended.length,
    minutes: Number(totalMinutes.toFixed(2)),
    cost: Number(totalCost.toFixed(4)),
    containment: evaluated.length ? Number(((contained / evaluated.length) * 100).toFixed(1)) : null,
    containmentSamples: evaluated.length,
    latency: { p50: pct(50), p90: pct(90), p99: pct(99), samples: latencies.length },
    guardrailHits,
    byIntent: Object.entries(
      ended.reduce<Record<string, number>>((acc, c) => {
        acc[c.analysis.intent] = (acc[c.analysis.intent] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([intent, count]) => ({ intent, count })),
  };
}

/**
 * Full analytics for a window, computed over every stored call — the
 * dashboard's local snapshot only ever carries the newest 100 records, so
 * page-level counting silently truncated. Same math as the client fallback
 * (`buildAnalytics`), so the two can never disagree about definitions.
 */
export function analyticsFor(orgId: string, days = 30): AnalyticsReport & { source: 'server' } {
  const calls = listAllByOrg<CallDoc>('calls', orgId);
  return { ...buildAnalytics(calls, Date.now(), days), source: 'server' };
}

/** Reads one call record, scoped to its org. */
export function getCall(callId: string) {
  return get<CallDoc>('calls', callId);
}
