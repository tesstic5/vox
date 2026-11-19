import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { locationById, normalizeWindows, providerById, rotaChangesFor, rotaFor, rotaForOrg, setRota, type RotaBreak } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The weekly rota, per provider per location.
 *
 * `GET /rota` with no parameters returns every rota in the workspace, which is
 * what the dashboard editor loads in one request instead of N.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const providerId = url.searchParams.get('providerId');
  const locationId = url.searchParams.get('locationId');
  const today = new Date().toISOString().slice(0, 10);

  if (providerId && locationId) {
    const row = rotaFor(ctx.orgId, providerId, locationId);
    return ok(
      {
        providerId,
        locationId,
        windows: row?.windows ?? [],
        breaks: row?.breaks ?? [],
        changes: rotaChangesFor(ctx.orgId, { providerId, from: today }).slice(0, 20),
      },
      { requestId: ctx.requestId }
    );
  }

  const rows = rotaForOrg(ctx.orgId);
  return ok(
    {
      object: 'list',
      data: rows,
      total: rows.length,
      changes: rotaChangesFor(ctx.orgId, { from: today }).slice(0, 50),
    },
    { requestId: ctx.requestId }
  );
}

export async function PUT(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ providerId?: string; locationId?: string; windows?: unknown; breaks?: RotaBreak[] }>(req);
  if (body instanceof NextResponse) return body;

  const providerId = String(body.providerId ?? '');
  const locationId = String(body.locationId ?? '');
  if (!providerById(ctx.orgId, providerId)) return fail('VALIDATION_ERROR', `No provider with id ${providerId}.`, { param: 'providerId', requestId: ctx.requestId });
  if (!locationById(ctx.orgId, locationId)) return fail('VALIDATION_ERROR', `No location with id ${locationId}.`, { param: 'locationId', requestId: ctx.requestId });

  const normalized = normalizeWindows(body.windows ?? []);
  if (normalized.error) return fail('VALIDATION_ERROR', normalized.error, { param: 'windows', requestId: ctx.requestId });

  const row = setRota(
    ctx.orgId,
    { providerId, locationId, windows: normalized.windows ?? [], breaks: body.breaks },
    ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard'
  );
  return ok(row ?? { providerId, locationId, windows: [], breaks: [] }, { requestId: ctx.requestId });
}
