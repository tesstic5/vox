import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, list, remove, update, nowIso, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function load(req: NextRequest, id: string) {
  const write = !['GET', 'HEAD'].includes(req.method.toUpperCase());
  const ctx = await requireAuth(req, { scopes: [write ? 'numbers:write' : 'numbers:read'] });
  if (ctx instanceof NextResponse) return ctx;
  if (write) {
    const denied = requireConfigRole(ctx);
    if (denied) return denied;
  }
  const number = get<Doc>('numbers', id);
  if (!number || number.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No phone number with id ${id}.`, { requestId: ctx.requestId });
  }
  return { ctx, number };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  return ok(res.number, { requestId: res.ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  const allowed = new Set(['assistantId', 'squadId', 'fallbackNumber', 'label']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` cannot be changed on a phone number.`, { param: unknown, requestId: res.ctx.requestId });

  const patch: Record<string, unknown> = {};
  if (body.assistantId !== undefined) {
    if (body.assistantId !== null && (typeof body.assistantId !== 'string' || !list<Doc>('assistants', (row) => row.orgId === res.ctx.orgId && row.id === body.assistantId).length)) {
      return fail('VALIDATION_ERROR', 'assistantId must name an assistant in this workspace, or be null.', { param: 'assistantId', requestId: res.ctx.requestId });
    }
    patch.assistantId = body.assistantId;
  }
  if (body.squadId !== undefined) {
    if (body.squadId !== null && (typeof body.squadId !== 'string' || !list<Doc>('squads', (row) => row.orgId === res.ctx.orgId && row.id === body.squadId).length)) {
      return fail('VALIDATION_ERROR', 'squadId must name a squad in this workspace, or be null.', { param: 'squadId', requestId: res.ctx.requestId });
    }
    patch.squadId = body.squadId;
  }
  if (body.fallbackNumber !== undefined) {
    const fallback = body.fallbackNumber === null ? null : String(body.fallbackNumber).trim();
    if (fallback !== null && fallback !== '' && !/^\+[1-9]\d{7,14}$/.test(fallback)) {
      return fail('VALIDATION_ERROR', 'fallbackNumber must be E.164 or null.', { param: 'fallbackNumber', requestId: res.ctx.requestId });
    }
    patch.fallbackNumber = fallback || null;
  }
  if (body.label !== undefined) patch.label = String(body.label).trim().slice(0, 120);
  if (!Object.keys(patch).length) return fail('VALIDATION_ERROR', 'Provide at least one editable field.', { requestId: res.ctx.requestId });
  const number = update<Doc>('numbers', id, { ...patch, updatedAt: nowIso() });
  audit({ orgId: res.ctx.orgId, actor: 'dashboard', action: 'number.updated', target: id, detail: Object.keys(patch).join(', ') });
  return ok(number, { requestId: res.ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  if (res.number.carrierId || res.number.carrierSid) {
    return fail('VALIDATION_ERROR', 'Carrier-backed numbers must use the release action so the carrier result is checked before local removal.', {
      param: 'id',
      detail: `/api/v1/phone-numbers/${id}/release`,
      requestId: res.ctx.requestId,
    });
  }
  remove('numbers', id);
  audit({ orgId: res.ctx.orgId, actor: 'dashboard', action: 'number.released', target: id, detail: String(res.number.number) });
  return ok({ id, status: 'released', releasedAt: nowIso() }, { requestId: res.ctx.requestId });
}
