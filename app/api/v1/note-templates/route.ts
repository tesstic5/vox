import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel } from '@/lib/server/access-log';
import { fail, listBody, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  createNoteTemplate,
  noteTemplatesV2,
  reviseNoteTemplate,
  type VersionedNoteTemplateDoc,
} from '@/lib/server/clinical/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.read');
  if (denied) return denied;
  const includeRetired = new URL(req.url).searchParams.get('include') === 'retired';
  const data = noteTemplatesV2(ctx.orgId, { includeRetired });
  return ok(listBody(data), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.write');
  if (denied) return denied;
  const body = await readJson<{
    action?: 'create' | 'revise';
    id?: string;
    expectedRevision?: number;
    name?: string;
    serviceId?: string;
    sections?: unknown;
    state?: VersionedNoteTemplateDoc['state'];
    changeReason?: string;
  }>(req, 512 * 1024);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const action = body.action ?? 'create';
  const result = action === 'revise'
    ? reviseNoteTemplate({
        orgId: ctx.orgId,
        templateId: String(body.id ?? ''),
        expectedRevision: Number(body.expectedRevision),
        name: body.name,
        serviceId: body.serviceId,
        sections: body.sections,
        state: body.state,
        changeReason: String(body.changeReason ?? ''),
        actorId: actor,
        actorName,
      })
    : createNoteTemplate({
        orgId: ctx.orgId,
        name: String(body.name ?? ''),
        serviceId: body.serviceId,
        sections: body.sections,
        state: body.state,
        changeReason: body.changeReason,
        actorId: actor,
        actorName,
      });
  if (!result.ok) {
    const code = result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, result.error, { requestId: ctx.requestId });
  }
  return ok({ template: result.template, version: result.version }, { requestId: ctx.requestId, status: action === 'create' ? 201 : 200 });
}
