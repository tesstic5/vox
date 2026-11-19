import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { appendTurn } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/calls/:id/turn — send what the caller said.
 *
 * The dashboard's browser test call hits this. Everything the agent does
 * (intent, tool calls, guardrails, latency, cost) comes back in one response.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ text?: string }>(req);
  if (body instanceof NextResponse) return body;

  const text = (body.text ?? '').trim();
  if (!text) return fail('VALIDATION_ERROR', 'Send the caller speech in `text`.', { param: 'text', requestId: ctx.requestId });
  if (text.length > 2000) return fail('VALIDATION_ERROR', 'A single turn is limited to 2000 characters.', { param: 'text', requestId: ctx.requestId });

  const result = await appendTurn({
    orgId: ctx.orgId,
    callId: id,
    text,
    // A call placed from the dashboard is placed by a known person, and the
    // report tool may answer it on the strength of their role — no number to
    // match, no guessing.
    viewer: ctx.user ? { name: ctx.user.name, email: ctx.user.email, role: ctx.user.role } : undefined,
  });
  if ('error' in result) {
    if (result.error === 'not_found') return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });
    if (result.error === 'call_ended') return fail('CONFLICT', 'That call has already ended.', { requestId: ctx.requestId });
    return fail('VALIDATION_ERROR', 'The assistant for this call no longer exists.', { requestId: ctx.requestId });
  }

  return ok({ call: result.call, turn: result.turn }, { requestId: ctx.requestId });
}
