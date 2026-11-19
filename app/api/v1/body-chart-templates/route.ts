import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  bodyChartTemplates,
  createBodyChartTemplate,
  setBodyChartTemplateState,
  type BodyChartTemplateDoc,
} from '@/lib/server/clinical/body-charts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.read');
  if (denied) return denied;
  const includeRetired = new URL(req.url).searchParams.get('include') === 'retired';
  return ok(listBody(bodyChartTemplates(ctx.orgId, includeRetired)), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Body-chart template changes require an authenticated staff session.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.write');
  if (denied) return denied;
  const body = await readJson<{
    action?: 'create' | 'set_state';
    id?: string;
    expectedRevision?: number;
    title?: string;
    sourceDocumentId?: string;
    sourceDocumentVersionId?: string;
    state?: BodyChartTemplateDoc['state'];
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  const action = body.action ?? 'create';
  if (!['create', 'set_state'].includes(action)) return fail('VALIDATION_ERROR', 'Body-chart template action must be create or set_state.', { param: 'action', requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = action === 'set_state'
    ? setBodyChartTemplateState({
        orgId: ctx.orgId,
        id: String(body.id ?? ''),
        expectedRevision: Number(body.expectedRevision),
        state: body.state ?? 'retired',
        actorId: actor,
      })
    : createBodyChartTemplate({
        orgId: ctx.orgId,
        title: String(body.title ?? ''),
        sourceDocumentId: String(body.sourceDocumentId ?? ''),
        sourceDocumentVersionId: String(body.sourceDocumentVersionId ?? ''),
        state: body.state,
        actorId: actor,
        actorName,
      });
  if (!result.ok) {
    const code = result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' || result.code === 'FINALISED' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, result.error, { requestId: ctx.requestId, detail: result.conflictId });
  }
  return ok({ template: result.value }, { requestId: ctx.requestId, status: action === 'set_state' ? 200 : 201 });
}
