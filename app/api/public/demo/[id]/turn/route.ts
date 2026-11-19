import { NextResponse, type NextRequest } from 'next/server';
import { get } from '@/lib/server/db';
import { appendTurn, endCall, type CallDoc } from '@/lib/server/calls';
import { assistantConfigFor } from '@/lib/server/telephony';
import { runTurnStream } from '@/lib/server/agent';
import type { HistoryTurn } from '@/lib/server/agent';
import { verifyDemoToken } from '@/lib/server/demo-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A turn on the public demo line — no account, but still a real pipeline.
 *
 * Auth is a signed token bound to this one call instead of a session. The
 * record is not billed; it becomes eligible for deletion after one hour and is
 * removed by the next maintenance sweep.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { text?: string; token?: string; sttMs?: number; end?: boolean };
  const auth = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? body.token ?? '';
  if (!verifyDemoToken(id, auth)) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'This demo session has expired — start a new call.' } }, { status: 401 });
  }

  const call = get<CallDoc>('calls', id);
  if (!call) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Unknown demo call.' } }, { status: 404 });

  if (body.end || call.status !== 'in-progress') {
    const ended = call.status === 'in-progress' ? endCall({ orgId: String(call.orgId), callId: id, endedReason: 'customer-ended-call' }) : call;
    return NextResponse.json({
      ended: true,
      summary: ended?.analysis.summary,
      durationSeconds: ended?.durationSeconds,
      turns: ended?.metrics.turns ?? 0,
    });
  }

  const text = String(body.text ?? '').trim();
  if (!text) return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Nothing was transcribed — say that again.' } }, { status: 400 });

  const config = assistantConfigFor(call.assistantId, String(call.orgId));
  if (!config) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Demo assistant unavailable.' } }, { status: 404 });

  const history: HistoryTurn[] = call.transcript
    .filter((t) => t.role === 'user' || t.role === 'assistant')
    .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text }));
  const turnIndex = call.transcript.filter((t) => t.role === 'user').length;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        for await (const event of runTurnStream({
          config,
          history,
          userText: text,
          callId: call.id,
          turnIndex,
          chunkDelayMs: 18,
          orgId: String(call.orgId),
        })) {
          send(event.type, event);
        }
        await appendTurn({ orgId: String(call.orgId), callId: call.id, text, voice: body.sttMs ? { sttMs: body.sttMs } : undefined });
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : 'turn failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
  });
}

/** Visitor ended the browser test; close the record for scheduled deletion. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!verifyDemoToken(id, auth)) return NextResponse.json({ ok: false }, { status: 401 });
  const call = get<CallDoc>('calls', id);
  if (call && call.status === 'in-progress') endCall({ orgId: String(call.orgId), callId: id, endedReason: 'customer-ended-call' });
  return NextResponse.json({ ok: true, ended: true });
}
