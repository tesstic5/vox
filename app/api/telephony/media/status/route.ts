import { NextResponse, type NextRequest } from 'next/server';
import { fail, requireAuth, requireConfigRole } from '@/lib/server/api';
import { readiness } from '@/lib/server/media/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the media worker can do on this deployment.
 *
 * Streaming is a provider-key question, so this administrator-only probe names
 * the configured transcriber/voice, frame format, carrier availability, and test
 * simulation state without exposing deployment configuration to anonymous users.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Media readiness requires a signed-in workspace administrator.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const status = await readiness();
  /**
   * The simulated pipeline is a test seam, and readiness should say so.
   *
   * With `VOXERA_MEDIA_SIMULATE=1` the worker feeds the session a scripted caller
   * instead of a real transcriber: frames, turns, transcripts and barge-in all
   * behave as they do in production. Answering "no transcriber configured" while
   * that is true is the kind of half-truth that sends somebody hunting for an API
   * key they do not need, so the stream is reported ready and the simulation is
   * named in the payload — never implied, never hidden.
   */
  const simulated = process.env.VOXERA_MEDIA_SIMULATE === '1';
  const transcriber =
    simulated && !status.transcriber.configured
      ? {
          ...status.transcriber,
          configured: true,
          provider: 'simulated',
          detail:
            'A scripted caller stands in for the transcriber (VOXERA_MEDIA_SIMULATE=1). This is a test seam: raw-audio calls work end to end, and no words are being recognised by a provider.',
        }
      : status.transcriber;
  return NextResponse.json({
    endpoint: '/api/telephony/twilio/media',
    protocol: 'twilio-media-streams',
    simulated,
    inbound: { encoding: 'audio/x-mulaw', sampleRate: 8000, frameMs: status.frameMs },
    outbound: { encoding: 'audio/x-mulaw', sampleRate: 8000, frameMs: status.frameMs },
    providers: { transcriber, voice: status.voice },
    telephonyCredentials: status.telephony,
    features: {
      bargeIn: status.streaming || simulated,
      partialTranscripts: transcriber.configured,
      simulated,
      dtmf: true,
      knobs: ['recordings', 'partials', 'bargeIn', 'silenceTimeoutMs'],
    },
    ready: (status.streaming && status.transcriber.configured) || simulated,
  });
}
