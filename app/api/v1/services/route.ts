import { NextResponse, type NextRequest } from 'next/server';
import { applyListQuery, fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { createService, practiceProfile, servicesFor, type ServiceDoc } from '@/lib/server/practice';
import { termsFor } from '@/lib/terms';
import { validateServiceInput } from '@/lib/server/practice-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Services — what can be booked, how long it takes, what it costs.
 *
 * Duration and buffers are the fields the availability engine reads, which is
 * why they are validated here: a zero-length service would make every slot
 * overlap every other one.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  const rows = servicesFor(ctx.orgId, { includeInactive });
  const query = applyListQuery(rows as unknown as Record<string, unknown>[], url.searchParams, {
    fields: ['name', 'code', 'active'],
    sortable: ['name', 'price', 'durationMinutes', 'createdAt'],
    defaultSort: { field: 'name', dir: 'asc' },
    // Same trap as the roster: `includeInactive` is a control parameter the route
    // owns, and a policy without it in `passthrough` turns the request into a 400.
    passthrough: ['limit', 'cursor', 't', 'format', 'includeInactive'],
  });
  if (query.error) {
    return fail('VALIDATION_ERROR', `Unknown filter field \`${query.error.field}\`.`, {
      param: query.error.field,
      detail: `Known fields: ${query.error.known.join(', ')}.`,
      requestId: ctx.requestId,
    });
  }
  return ok(listBody(query.rows as unknown as ServiceDoc[], { terms: termsFor(practiceProfile(ctx.orgId).termPack) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<unknown>(req);
  if (body instanceof NextResponse) return body;
  const checked = validateServiceInput(body, 'create');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const input = checked.value;
  if (servicesFor(ctx.orgId, { includeInactive: true }).some((service) => service.name.toLowerCase() === input.name!.toLowerCase())) {
    return fail('CONFLICT', `A service called ${input.name} already exists.`, { param: 'name', requestId: ctx.requestId });
  }
  const row = createService(ctx.orgId, { ...input, name: input.name! }, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok(row, { requestId: ctx.requestId, status: 201 });
}
