import { NextResponse, type NextRequest } from 'next/server';
import { fail, listBody, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { addRotaChange, normalizeWindows, providerById, rotaChangesFor } from '@/lib/server/practice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One-off availability: a day off, a holiday, an extra Saturday.
 *
 * These never touch the weekly rota, so cancelling Tuesday does not quietly
 * change what "Tuesdays" means for the rest of the year.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const rows = rotaChangesFor(ctx.orgId, {
    providerId: url.searchParams.get('providerId') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  return ok(listBody(rows), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ providerId?: string; date?: string; kind?: string; windows?: unknown; reason?: string }>(req);
  if (body instanceof NextResponse) return body;

  const providerId = String(body.providerId ?? '');
  if (!providerById(ctx.orgId, providerId)) return fail('VALIDATION_ERROR', `No provider with id ${providerId}.`, { param: 'providerId', requestId: ctx.requestId });
  const date = String(body.date ?? '');
  if (!DATE.test(date)) return fail('VALIDATION_ERROR', '`date` must be `YYYY-MM-DD`.', { param: 'date', requestId: ctx.requestId });
  const kind = body.kind === 'extra' ? 'extra' : body.kind === 'off' ? 'off' : null;
  if (!kind) return fail('VALIDATION_ERROR', '`kind` must be "off" or "extra".', { param: 'kind', requestId: ctx.requestId });

  let windows;
  if (kind === 'extra') {
    const normalized = normalizeWindows(body.windows ?? [{ weekday: 0, start: '09:00', end: '17:00' }]);
    if (normalized.error) return fail('VALIDATION_ERROR', normalized.error, { param: 'windows', requestId: ctx.requestId });
    windows = normalized.windows;
  }

  const row = addRotaChange(ctx.orgId, { providerId, date, kind, windows, reason: body.reason }, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
  return ok(row, { requestId: ctx.requestId, status: 201 });
}
