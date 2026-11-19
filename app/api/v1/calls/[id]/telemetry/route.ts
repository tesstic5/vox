import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { get, update, type Doc } from '@/lib/server/db';
import type { CallDoc } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/calls/{id}/telemetry — device-side measurements.
 *
 * Only the caller's browser can observe microphone latency: how long the
 * transcriber took, and the real voice-to-voice gap (last word out of the mic →
 * first audio from the speaker). The media pipeline reports it here after each
 * turn so the dashboard can show measured numbers instead of estimates.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const call = get<CallDoc>('calls', id);
  if (!call || call.orgId !== ctx.orgId) return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{
    voiceToVoiceMs?: number;
    sttMs?: number;
    bargeIns?: number;
    device?: string;
    browser?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.voiceToVoiceMs && !body.sttMs) {
    return fail('VALIDATION_ERROR', 'Send at least one of `voiceToVoiceMs` or `sttMs`.', { requestId: ctx.requestId });
  }

  const samples = call.metrics.v2vSamples ?? 0;
  const prior = call.metrics.voiceToVoiceMs ?? 0;
  const v2v = body.voiceToVoiceMs && body.voiceToVoiceMs > 0 ? Math.round(body.voiceToVoiceMs) : undefined;
  const metrics = {
    ...call.metrics,
    voiceToVoiceMs: v2v ? Math.round((prior * samples + v2v) / (samples + 1)) : call.metrics.voiceToVoiceMs,
    v2vSamples: v2v ? samples + 1 : samples,
    sttMs: body.sttMs ? Math.round((((call.metrics.sttMs ?? 0) * samples + body.sttMs) / (samples + 1)) || body.sttMs) : call.metrics.sttMs,
    interruptions: call.metrics.interruptions + (body.bargeIns ?? 0),
  };

  update<Doc>('calls', id, { metrics, media: { device: body.device, browser: body.browser, reportedAt: new Date().toISOString() } });
  return ok({ callId: id, metrics }, { requestId: ctx.requestId });
}
