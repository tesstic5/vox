import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, list, update, remove, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { deliverWebhook } from '@/lib/server/webhooks';
import { snapshotAssistant } from '@/lib/server/versions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function load(req: NextRequest, id: string) {
  const write = !['GET', 'HEAD'].includes(req.method.toUpperCase());
  const ctx = await requireAuth(req, { scopes: [write ? 'assistants:write' : 'assistants:read'] });
  if (ctx instanceof NextResponse) return ctx;
  if (write) {
    const denied = requireConfigRole(ctx);
    if (denied) return denied;
  }
  const assistant = get<Doc>('assistants', id);
  if (!assistant || assistant.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No assistant with id ${id}.`, { requestId: ctx.requestId });
  }
  return { ctx, assistant };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  return ok(res.assistant, { requestId: res.ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  if (body.status !== undefined) {
    return fail('VALIDATION_ERROR', 'Status cannot be changed here. Use the publish action after reviewing the assistant.', {
      param: 'status',
      requestId: res.ctx.requestId,
    });
  }
  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'firstMessage', 'systemPrompt', 'model', 'provider', 'voiceId', 'temperature', 'transcriber', 'language', 'tools', 'knowledge', 'serverUrl']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  // Snapshot the state being replaced, so the version you can roll back *to*
  // exists by the time the edit lands.
  snapshotAssistant(res.assistant as Doc & Record<string, unknown>, `Before edit — ${Object.keys(patch).join(', ')}`, res.ctx.auth === 'key' ? `key:${res.ctx.key?.name}` : 'dashboard');

  const next = update<Doc>('assistants', id, {
    ...patch,
    version: Number(res.assistant.version ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  });

  audit({ orgId: res.ctx.orgId, actor: res.ctx.auth === 'key' ? `key:${res.ctx.key?.name}` : 'dashboard', action: 'assistant.updated', target: id, detail: Object.keys(patch).join(', ') });
  void deliverWebhook({ orgId: res.ctx.orgId, event: 'assistant.updated', payload: { type: 'assistant.updated', assistant: next } });

  return ok(next, { requestId: res.ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  // Keep bought/imported numbers and historical calls. Only remove the runtime
  // assignment so no number points at a deleted assistant.
  const assignedNumbers = list<Doc>('numbers', (number) => number.orgId === res.ctx.orgId && number.assistantId === id);
  for (const number of assignedNumbers) update<Doc>('numbers', number.id, { assistantId: null });
  remove('assistants', id);
  audit({
    orgId: res.ctx.orgId,
    actor: res.ctx.auth === 'key' ? `key:${res.ctx.key?.name}` : 'dashboard',
    action: 'assistant.deleted',
    target: id,
    detail: `${assignedNumbers.length} number assignment${assignedNumbers.length === 1 ? '' : 's'} cleared; call history retained`,
  });
  return ok({ id, deleted: true, unassignedNumbers: assignedNumbers.length }, { requestId: res.ctx.requestId });
}
