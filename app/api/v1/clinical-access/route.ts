import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requirePermission } from '@/lib/server/api';
import { clinicalAccessEventCount, clinicalAccessEventsFor, clinicalAccessSummary, type ClinicalAccessResource } from '@/lib/server/clinical-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['privacy:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'audit.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const resourceType = url.searchParams.get('resourceType') ?? undefined;
  const allowed = ['patient', 'clinical_note', 'clinical_alert', 'clinical_document', 'appointment', 'invoice'];
  if (resourceType && !allowed.includes(resourceType)) {
    return fail('VALIDATION_ERROR', `\`resourceType\` must be one of: ${allowed.join(', ')}.`, { param: 'resourceType', requestId: ctx.requestId });
  }
  const limit = Math.max(1, Math.min(2_000, Number(url.searchParams.get('limit') ?? 200) || 200));
  let cursor: { at: string; id: string } | undefined;
  const rawCursor = url.searchParams.get('cursor');
  if (rawCursor) {
    try {
      const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
      if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid');
      cursor = { at: parsed.at, id: parsed.id };
    } catch {
      return fail('VALIDATION_ERROR', '`cursor` is invalid.', { param: 'cursor', requestId: ctx.requestId });
    }
  }
  const filters = {
    orgId: ctx.orgId,
    resourceType: resourceType as ClinicalAccessResource | undefined,
    resourceId: url.searchParams.get('resourceId') ?? undefined,
    patientId: url.searchParams.get('patientId') ?? undefined,
    actorId: url.searchParams.get('actorId') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    beforeAt: cursor?.at,
    beforeId: cursor?.id,
    limit: limit + 1,
  };
  const page = clinicalAccessEventsFor(filters);
  const hasMore = page.length > limit;
  const data = page.slice(0, limit);
  const last = hasMore ? data.at(-1) : undefined;
  const nextCursor = last
    ? Buffer.from(JSON.stringify({ at: last.occurredAt, id: last.id })).toString('base64url')
    : null;
  const countFilters = { ...filters, limit: undefined, beforeAt: undefined, beforeId: undefined };
  return ok({
    object: 'list', data, total: clinicalAccessEventCount(countFilters), has_more: hasMore,
    next_cursor: nextCursor,
    summary: clinicalAccessSummary(ctx.orgId, filters.from, filters.to),
  }, { requestId: ctx.requestId });
}
