import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { createTool, toolForApi, toolsFor, toolsUsedBy, type ToolDoc } from '@/lib/server/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tools: the functions an assistant may call.
 *
 * The same tools the dashboard edits, on the same collection the runtime reads,
 * so `GET /v1/tools` and the dashboard table can never disagree.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const assistantId = url.searchParams.get('assistantId');
  const usedBy = toolsUsedBy(ctx.orgId);

  let tools = toolsFor(ctx.orgId);
  if (assistantId) {
    tools = tools.filter((t) => (usedBy.get(t.name) ?? []).includes(assistantId));
  }
  return ok(
    listBody(tools.map((t) => ({ ...toolForApi(t), usedBy: usedBy.get(t.name) ?? [] }))),
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<Partial<ToolDoc>>(req);
  if (body instanceof NextResponse) return body;

  const name = String(body.name ?? '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{1,63}$/.test(name)) {
    return fail('VALIDATION_ERROR', '`name` must be a valid identifier — letters, digits and underscores, starting with a letter.', {
      param: 'name',
      requestId: ctx.requestId,
    });
  }
  if (toolsFor(ctx.orgId).some((t) => t.name === name)) {
    return fail('CONFLICT', `A tool named ${name} already exists in this workspace.`, { param: 'name', requestId: ctx.requestId });
  }
  if (body.endpoint && !/^https?:\/\//.test(String(body.endpoint))) {
    return fail('VALIDATION_ERROR', '`endpoint` must be an absolute http(s) URL.', { param: 'endpoint', requestId: ctx.requestId });
  }
  const tool = createTool(ctx.orgId, { ...body, name });
  return ok({ ...toolForApi(tool), usedBy: [] }, { requestId: ctx.requestId, status: 201 });
}
