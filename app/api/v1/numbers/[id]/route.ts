import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, list, remove, update, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['numbers:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const number = get<Doc>('numbers', id);
  if (!number || number.orgId !== ctx.orgId) return fail('NOT_FOUND', `No number with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{ assistantId?: string | null; label?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (body.assistantId) {
    const exists = list<Doc>('assistants', (a) => a.id === body.assistantId && a.orgId === ctx.orgId)[0];
    if (!exists) return fail('VALIDATION_ERROR', `No assistant with id ${body.assistantId}.`, { param: 'assistantId', requestId: ctx.requestId });
  }
  const patch: Record<string, unknown> = {};
  if (body.assistantId !== undefined) patch.assistantId = body.assistantId;
  if (body.label !== undefined) patch.label = String(body.label).trim().slice(0, 120);
  if (!Object.keys(patch).length) return fail('VALIDATION_ERROR', 'Provide assistantId or label.', { requestId: ctx.requestId });

  const next = update<Doc>('numbers', id, patch);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.updated', target: id, detail: Object.keys(patch).join(', ') });
  return ok(next, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['numbers:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const number = get<Doc>('numbers', id);
  if (!number || number.orgId !== ctx.orgId) return fail('NOT_FOUND', `No number with id ${id}.`, { requestId: ctx.requestId });
  if (number.carrierId || number.carrierSid) {
    return fail('VALIDATION_ERROR', 'Carrier-backed numbers must use the release action so the carrier result is checked before local removal.', {
      param: 'id',
      detail: `/api/v1/phone-numbers/${id}/release`,
      requestId: ctx.requestId,
    });
  }
  update<Doc>('numbers', id, { status: 'released', assistantId: null, releasedAt: new Date().toISOString() });
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'number.released', target: id });
  remove('numbers', id);
  return ok({ id, released: true }, { requestId: ctx.requestId });
}
