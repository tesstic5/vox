import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { endCall, type CallDoc } from '@/lib/server/calls';
import { get, remove } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const call = get<CallDoc>('calls', id);
  if (!call || call.orgId !== ctx.orgId) return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });
  return ok(call, { requestId: ctx.requestId });
}

/** PATCH /v1/calls/:id — currently used to end a call. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  const call = get<CallDoc>('calls', id);
  if (!call || call.orgId !== ctx.orgId) return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });

  const allowed = new Set(['status', 'endedReason', 'summary']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` cannot be changed on a call.`, { param: unknown, requestId: ctx.requestId });
  if (body.status !== 'ended') {
    return fail('VALIDATION_ERROR', 'PATCH currently accepts only `status: "ended"`.', { param: 'status', requestId: ctx.requestId });
  }
  const endedReason = body.endedReason === undefined ? undefined : String(body.endedReason).trim().slice(0, 80);
  const summary = body.summary === undefined ? undefined : String(body.summary).trim().slice(0, 2_000);
  const ended = endCall({ orgId: ctx.orgId, callId: id, endedReason, summary });
  if (!ended) return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });
  return ok(ended, { requestId: ctx.requestId });
}

/** DELETE /v1/calls/:id — permanently removes one tenant-owned call record. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;

  const call = get<CallDoc>('calls', id);
  if (!call || call.orgId !== ctx.orgId) return fail('NOT_FOUND', `No call with id ${id}.`, { requestId: ctx.requestId });

  remove('calls', id);
  audit({
    orgId: ctx.orgId,
    actor: ctx.auth === 'key' ? `key:${ctx.key?.name}` : (ctx.user?.email ?? 'dashboard'),
    action: 'call.deleted',
    target: id,
    detail: `${call.type} · ${call.startedAt}`,
  });
  return ok({ id, deleted: true }, { requestId: ctx.requestId });
}
