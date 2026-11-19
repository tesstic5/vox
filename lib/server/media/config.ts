/**
 * Media-stream configuration.
 *
 * One place answers two questions:
 *
 *   1. Is streaming ready? (which transcriber, which voice, is telephony wired)
 *   2. Given a carrier's `start` frame, which call and organisation is this?
 *
 * Providers are environment keys, deliberately: swapping Deepgram for something
 * else, or ElevenLabs for Cartesia, is a deploy-time change, not a code change.
 */

import { findByPath, get, list, type Doc } from '../db';
import { authTokenForNumber, carrierCall, ingestInbound, resolveTenantByNumber } from '../telephony';
import * as stt from '../providers/stt';
import * as tts from '../providers/tts';

export type MediaReadiness = {
  streaming: boolean;
  transcriber: ReturnType<typeof stt.describe>;
  voice: ReturnType<typeof tts.describe>;
  /** True when at least one number resolves to a carrier with a stored token. */
  telephony: boolean;
  frameMs: number;
  sampleRate: { carrier: number; provider: number };
};

export async function readiness(): Promise<MediaReadiness> {
  const numbers = list<Doc & { number?: string; carrierId?: string }>('numbers');
  let telephony = false;
  for (const n of numbers.slice(0, 8)) {
    if (n.carrierId || n.number) {
      const token = authTokenForNumber(String(n.number ?? ''));
      if (token) {
        telephony = true;
        break;
      }
    }
  }
  return {
    streaming: Boolean(stt.available()) || Boolean(tts.available()),
    transcriber: stt.describe(),
    voice: tts.describe(),
    telephony,
    frameMs: 20,
    sampleRate: { carrier: 8000, provider: 16000 },
  };
}

export type ResolvedSession = { callId: string; orgId: string; streamSid?: string };

/**
 * Maps a carrier's `start` frame onto a stored call.
 *
 * Twilio sends `callSid` and the dialled `to`; either is enough on its own. A
 * call that was placed by us is remembered at dial time, which is the common
 * case for outbound; inbound calls are matched on the number.
 */
export function resolveSession(params: {
  callSid?: string;
  to?: string;
  from?: string;
  streamSid?: string;
  /** The dialled number, for inbound calls with no remembered call SID. */
  provider?: 'twilio';
  customParameters?: Record<string, string>;
}): ResolvedSession | undefined {
  // Explicit hand-off (our TwiML attaches callId to the stream URL).
  const explicit = params.customParameters?.callId;
  if (explicit) {
    const call = get<Doc & { orgId?: string }>('calls', explicit);
    if (call?.orgId) return { callId: explicit, orgId: call.orgId, streamSid: params.streamSid };
  }

  const link = params.callSid ? carrierCall(params.callSid) : undefined;
  if (link) {
    const call = get<Doc & { orgId?: string }>('calls', link.callId);
    if (call?.orgId) return { callId: link.callId, orgId: call.orgId, streamSid: params.streamSid };
  }

  if (params.callSid) {
    const bySid = findByPath<Doc & { orgId: string; telephony?: { callSid?: string } }>('calls', 'telephony.callSid', params.callSid);
    if (bySid) return { callId: bySid.id, orgId: bySid.orgId, streamSid: params.streamSid };
  }

  // Inbound: nobody remembered this SID, so the dialled number identifies the
  // workspace. A call is opened now, which is also what gives the media session
  // somewhere to write its transcript.
  if (params.to) {
    const tenant = resolveTenantByNumber(params.to);
    if (!tenant) return undefined;
    const orgId = tenant.orgId;
    const ingested = ingestInbound({
      orgId,
      to: params.to,
      from: params.from ?? 'unknown',
      carrierCallId: params.callSid ?? `media-${Date.now()}`,
      provider: params.provider ?? 'twilio',
    });
    if ('error' in ingested) return undefined;
    return { callId: ingested.call.id, orgId, streamSid: params.streamSid };
  }

  return undefined;
}
