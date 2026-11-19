import { NextResponse, type NextRequest } from 'next/server';
import { fail, readJson, requireAuth } from '@/lib/server/api';
import { get, type Doc } from '@/lib/server/db';
import { appendTurn, type CallDoc } from '@/lib/server/calls';
import { assistantConfigFor, telephonyTurn } from '@/lib/server/telephony';
import { runTurnStream, streamResult } from '@/lib/server/agent';
import type { HistoryTurn } from '@/lib/server/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/calls/{id}/turn/stream — a turn, streamed as it happens.
 *
 * Server-sent events: `stt.final` → `intent` → `tool.start`/`tool.end` →
 * `tts.start` → `assistant.delta`* → `assistant.done`. The client speaks the
 * first delta instead of waiting for the whole reply, which is the difference
 * between a demo and something that sounds like a person.
 *
 * The turn is recorded server-side exactly once, on stream completion, so a
 * client that loses its connection mid-sentence does not lose the transcript.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;

  const call = get<CallDoc>('calls', id);
  if (!call || call.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });
  }
  if (call.status !== 'in-progress') {
    return fail('CONFLICT', `Call ${id} is ${call.status}; start a new call to keep talking.`, { requestId: ctx.requestId });
  }

  const body = await readJson<{
    text?: string;
    /** Device-measured transcriber turnaround, reported with the turn. */
    sttMs?: number;
    chunkDelayMs?: number;
  }>(req);
  if (body instanceof NextResponse) return body;
  const text = String(body.text ?? '').trim();
  if (!text) return fail('VALIDATION_ERROR', 'Send the caller transcription in `text`.', { param: 'text', requestId: ctx.requestId });
  if (text.length > 2000) {
    return fail('VALIDATION_ERROR', 'A single turn is capped at 2000 characters.', { param: 'text', requestId: ctx.requestId });
  }

  const config = assistantConfigFor(call.assistantId, String(call.orgId));
  if (!config) return fail('NOT_FOUND', 'The assistant for this call has been deleted.', { requestId: ctx.requestId });

  const history: HistoryTurn[] = call.transcript
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text }));
  const turnIndex = call.transcript.filter((t) => t.role === 'user').length;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const startedAt = Date.now();
      try {
        for await (const event of runTurnStream({
          config,
          history,
          userText: text,
          callId: call.id,
          turnIndex,
          priorIntents: call.analysis.intents ?? [],
          priorSlots: call.analysis.structuredData as Record<string, string>,
          chunkDelayMs: Math.max(0, Math.min(Number(body.chunkDelayMs ?? 0) || 0, 120)),
          orgId: call.orgId,
          bookingId: call.bookingId,
          callerNumber: call.type === 'inbound' ? call.from : undefined,
          timezone: call.analysis.structuredData?.timezone as string | undefined,
        })) {
          send(event.type, event);
          // Stop early if the caller has already hung up.
          const fresh = get<CallDoc>('calls', call.id);
          if (fresh && fresh.status !== 'in-progress') {
            send('call.ended', { callId: call.id });
            break;
          }
        }

        // Record the turn once, with the client's speech-end timestamp when it
        // was given, so voice-to-voice latency is measured rather than guessed.
        const recorded = await appendTurn({
          orgId: ctx.orgId,
          callId: call.id,
          text,
          voice: body.sttMs ? { sttMs: body.sttMs, clientTurnMs: Date.now() - startedAt } : { clientTurnMs: Date.now() - startedAt },
          // Who is on the other end of a browser call, when we know: see the
          // simple turn route.
          viewer: ctx.user ? { name: ctx.user.name, email: ctx.user.email, role: ctx.user.role } : undefined,
        });
        send('turn.recorded', {
          call: recorded.call?.id,
          metrics: recorded.call?.metrics,
          transcriptTurns: recorded.call?.transcript.length,
        });
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'turn failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': ctx.requestId,
    },
  });
}

/** GET is a health probe for the streaming transport. */
export async function GET() {
  return NextResponse.json({ ok: true, transport: 'text/event-stream', events: ['stt.final', 'intent', 'tool.start', 'tool.end', 'guardrail', 'tts.start', 'assistant.delta', 'assistant.done', 'turn.recorded'] });
}
