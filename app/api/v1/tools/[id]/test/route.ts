import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { callEndpoint, toolById, toolHeaders } from '@/lib/server/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /v1/tools/{id}/test — calls the tool's endpoint for real and returns what
 * came back.
 *
 * This answers "does my tool actually work?" without placing a phone call: the
 * same `callEndpoint` the runtime uses, the same outbound URL policy, the same
 * timeout — so a green test here means the live path can reach your service.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const tool = toolById(ctx.orgId, id);
  if (!tool) return fail('NOT_FOUND', `No tool with id ${id}.`, { requestId: ctx.requestId });
  if (!tool.endpoint) {
    return fail('VALIDATION_ERROR', `${tool.name} has no endpoint configured — it runs on the built-in executor, which needs nothing to test.`, {
      param: 'endpoint',
      requestId: ctx.requestId,
    });
  }
  const body = await readJson<{ args?: Record<string, unknown>; body?: unknown }>(req);
  if (body instanceof NextResponse) return body;

  const outcome = await callEndpoint({
    endpoint: tool.endpoint,
    method: tool.method,
    headers: toolHeaders(tool),
    args: body.args ?? {},
    body: body.body,
  });
  return ok(
    {
      toolId: tool.id,
      name: tool.name,
      request: { method: outcome.method, url: outcome.url },
      status: outcome.status,
      ok: outcome.ok,
      ms: outcome.ms,
      // The receiver's own words, trimmed to something a developer can read.
      response: outcome.body,
      error: outcome.error,
      hint: outcome.ok ? undefined : 'A live call would see the same result; the built-in executor takes over when this fails.',
    },
    { requestId: ctx.requestId }
  );
}
