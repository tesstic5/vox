import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { createLocation, isValidTimezone, locationsFor } from '@/lib/server/practice';
import { validateLocationInput } from '@/lib/server/practice-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Locations. The timezone here is not decoration: rotas are interpreted on the
 * site's clock and slots are returned as instants, so a wrong zone is a diary
 * that slowly drifts by an hour twice a year.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const includeInactive = new URL(req.url).searchParams.get('includeInactive') === 'true';
  return ok(listBody(locationsFor(ctx.orgId, { includeInactive })), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<unknown>(req);
  if (body instanceof NextResponse) return body;
  const checked = validateLocationInput(body, 'create');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const input = checked.value;
  const timezone = input.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) {
    return fail('VALIDATION_ERROR', `\`${timezone}\` is not a recognised IANA timezone (try \`America/New_York\`).`, { param: 'timezone', requestId: ctx.requestId });
  }
  if (locationsFor(ctx.orgId, { includeInactive: true }).some((location) => location.name.toLowerCase() === input.name!.toLowerCase())) {
    return fail('CONFLICT', `A location called ${input.name} already exists.`, { param: 'name', requestId: ctx.requestId });
  }
  const row = createLocation(ctx.orgId, { ...input, name: input.name!, timezone }, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok(row, { requestId: ctx.requestId, status: 201 });
}
