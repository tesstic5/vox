import { NextResponse, type NextRequest } from 'next/server';
import { applyListQuery, fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import {
  createProvider,
  deleteProvider,
  locationsFor,
  practiceProfile,
  providersFor,
  servicesFor,
  updateProvider,
  type ProviderDoc,
} from '@/lib/server/practice';
import { termsFor } from '@/lib/terms';
import { validateProviderInput } from '@/lib/server/practice-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Providers — the people whose diaries exist.
 *
 * Neutral name on the wire (see `lib/terms.ts`): a clinic reads "practitioners",
 * a services company reads "technicians", and the data has one shape either way.
 * `assignableTo` is resolved here so a client never has to join by hand.
 */
function withNames(orgId: string, row: ProviderDoc) {
  const services = new Map(servicesFor(orgId, { includeInactive: true }).map((s) => [s.id, s.name]));
  const locations = new Map(locationsFor(orgId, { includeInactive: true }).map((l) => [l.id, l.name]));
  return {
    ...row,
    assignableTo: row.serviceIds.map((id) => ({ id, name: services.get(id) ?? id })),
    worksAt: row.locationIds.map((id) => ({ id, name: locations.get(id) ?? id })),
  };
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get('includeInactive') === 'true';

  let rows = providersFor(ctx.orgId, { includeInactive });
  const query = applyListQuery(rows as unknown as Record<string, unknown>[], url.searchParams, {
    fields: ['name', 'title', 'email', 'colour', 'active'],
    aliases: {},
    sortable: ['name', 'createdAt'],
    defaultSort: { field: 'name', dir: 'asc' },
    // `includeInactive` is read a few lines up, not filtered on — without this the
    // parser rejected it as an unknown field and the whole list 400'd, so
    // `?includeInactive=true` (and any URL carrying it) could never see the roster.
    passthrough: ['limit', 'cursor', 't', 'format', 'includeInactive'],
  });
  if (query.error) {
    return fail('VALIDATION_ERROR', `Unknown filter field \`${query.error.field}\`.`, {
      param: query.error.field,
      detail: `Known fields: ${query.error.known.join(', ')}.`,
      requestId: ctx.requestId,
    });
  }
  rows = query.rows as unknown as ProviderDoc[];
  return ok(listBody(rows.map((r) => withNames(ctx.orgId, r)), { terms: termsFor(practiceProfile(ctx.orgId).termPack) }), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<unknown>(req);
  if (body instanceof NextResponse) return body;
  const checked = validateProviderInput(body, 'create');
  if ('error' in checked) return fail('VALIDATION_ERROR', checked.error, { param: checked.param, requestId: ctx.requestId });
  const input = checked.value;

  // New assignments may point only at active records. Retired labels remain
  // resolvable for history, but cannot quietly return to an active roster.
  const serviceIds = input.serviceIds ?? [];
  const locationIds = input.locationIds ?? [];
  const knownServices = new Set(servicesFor(ctx.orgId).map((s) => s.id));
  const knownLocations = new Set(locationsFor(ctx.orgId).map((l) => l.id));
  const badService = serviceIds.find((id) => !knownServices.has(id));
  const badLocation = locationIds.find((id) => !knownLocations.has(id));
  if (badService) return fail('VALIDATION_ERROR', `No active service with id ${badService} in this workspace.`, { param: 'serviceIds', requestId: ctx.requestId });
  if (badLocation) return fail('VALIDATION_ERROR', `No active location with id ${badLocation} in this workspace.`, { param: 'locationIds', requestId: ctx.requestId });

  const row = createProvider(ctx.orgId, { ...input, name: input.name!, serviceIds, locationIds }, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok(withNames(ctx.orgId, row), { requestId: ctx.requestId, status: 201 });
}
