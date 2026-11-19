import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { remove, list, update, type Doc } from '@/lib/server/db';
import { toolById, toolForApi, toolsUsedBy, updateTool, type ToolDoc } from '@/lib/server/tools';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const tool = toolById(ctx.orgId, id);
  if (!tool) return fail('NOT_FOUND', `No tool with id ${id}.`, { requestId: ctx.requestId });
  return ok({ ...toolForApi(tool), usedBy: toolsUsedBy(ctx.orgId).get(tool.name) ?? [] }, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<Partial<ToolDoc>>(req);
  if (body instanceof NextResponse) return body;
  if (!toolById(ctx.orgId, id)) return fail('NOT_FOUND', `No tool with id ${id}.`, { requestId: ctx.requestId });

  const patch: Partial<ToolDoc> = {};
  for (const key of ['name', 'description', 'method', 'endpoint', 'headers'] as const) {
    if (key in body) patch[key] = body[key] as never;
  }
  const updated = updateTool(ctx.orgId, id, patch);
  return ok(updated ? toolForApi(updated) : updated, { requestId: ctx.requestId });
}

/**
 * Deleting a tool also detaches it from every assistant. Leaving the name in an
 * assistant's tool list would offer the model a function with nothing behind it
 * — the kind of thing that only shows up as a confusing turn in production.
 *
 * A tool the built-in executors implement (`lookup_order`, the booking tools) is
 * removed from your workspace only; the vocabulary itself lives in the runtime.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const tool = toolById(ctx.orgId, id);
  if (!tool) return fail('NOT_FOUND', `No tool with id ${id}.`, { requestId: ctx.requestId });

  let detached = 0;
  for (const assistant of list<Doc & { tools?: string[] }>('assistants', (a) => a.orgId === ctx.orgId)) {
    const names = assistant.tools ?? [];
    if (!names.includes(tool.name)) continue;
    update('assistants', assistant.id, { tools: names.filter((n) => n !== tool.name) });
    detached += 1;
  }

  remove('tools', id);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'tool.deleted', target: id, detail: `${tool.name} (detached from ${detached} assistant${detached === 1 ? '' : 's'})` });
  return ok({ id, deleted: true, detachedFrom: detached }, { requestId: ctx.requestId });
}
