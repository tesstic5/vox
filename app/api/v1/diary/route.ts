import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { diaryRange } from '@/lib/server/diary';
import { addDays, dateStrIn } from '@/lib/server/availability';
import { locationById, practiceProfile, practiceTimezone, termsForOrg } from '@/lib/server/practice';
import { permissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/diary — the calendar, in one request.
 *
 * `from`/`to` are calendar dates in the requested site's clock; `view` is a
 * convenience that turns "3 days from Tuesday" into a range so the dashboard and
 * any other client draw the same window. Every appointment comes back with the
 * names it needs (provider, service, site, client) and its position on the local
 * grid, because a calendar that resolves four lookups per block per render is a
 * calendar that feels slow.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);

  const locationId = url.searchParams.get('locationId') ?? undefined;
  if (locationId && !locationById(ctx.orgId, locationId)) {
    return fail('NOT_FOUND', `No location with id ${locationId}.`, { param: 'locationId', requestId: ctx.requestId });
  }
  // The same clock the grid itself uses (the site's, or the practice's first
  // site), because it decides *which* day "today" is. A UTC default here would
  // open the all-sites view one day out for a practice west of Greenwich.
  const timezone = practiceTimezone(ctx.orgId, locationId ? locationById(ctx.orgId, locationId) : undefined);
  const view = url.searchParams.get('view') ?? 'day';
  const spanDays = view === 'day' ? 1 : view === '3day' ? 3 : view === 'workweek' ? 5 : view === 'week' ? 7 : 0;
  if (!spanDays) {
    return fail('VALIDATION_ERROR', '`view` must be `day`, `3day`, `workweek` or `week` (or pass `from` and `to`).', { param: 'view', requestId: ctx.requestId });
  }

  // A work week starts on the practice's configured week start, not on whatever
  // day happens to be on screen — "the week" is a business unit, not a window.
  let from = url.searchParams.get('from') ?? dateStrIn(timezone);
  if (view === 'workweek') {
    const profile = practiceProfile(ctx.orgId);
    const [y, m, d] = from.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const offset = (dow - (profile.weekStart ?? 1) + 7) % 7;
    from = addDays(from, -offset);
  }
  const to = url.searchParams.get('to') ?? addDays(from, spanDays - 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return fail('VALIDATION_ERROR', '`from` and `to` must be `YYYY-MM-DD`.', { param: 'from', requestId: ctx.requestId });
  }

  const includeClinicalAlerts = ctx.auth === 'key'
    ? Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('clinical:read'))
    : Boolean(ctx.user && permissionDecision(ctx.user, 'clinical.alerts.read', { area: 'clinical' }).allowed);
  const result = diaryRange({
    orgId: ctx.orgId,
    from,
    to,
    providerId: url.searchParams.get('providerId') ?? undefined,
    locationId,
    includeClinicalAlerts,
  });
  const profile = practiceProfile(ctx.orgId);
  return ok(
    {
      ...result,
      range: { from, to, view, days: spanDays },
      terms: termsForOrg(ctx.orgId),
      policy: { minNoticeMinutes: profile.minNoticeMinutes, maxAdvanceDays: profile.maxAdvanceDays, slotStepMinutes: profile.slotStepMinutes, weekStart: profile.weekStart },
    },
    { requestId: ctx.requestId }
  );
}
