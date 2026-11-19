import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { clientById } from '@/lib/server/clients';
import {
  addPatientContactPoint,
  contactPointsFor,
  endPatientContactPoint,
  type ContactKind,
  type ContactLabel,
} from '@/lib/server/patient-identity';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  const patient = clientById(ctx.orgId, id);
  if (!patient) return fail('NOT_FOUND', `No patient with id ${id}.`, { requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'view', actor, actorName, detail: 'contact points' });
  const data = contactPointsFor(ctx.orgId, id);
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No patient with id ${id}.`, { requestId: ctx.requestId });
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{
    kind?: ContactKind;
    label?: ContactLabel;
    value?: string;
    primary?: boolean;
    verified?: boolean;
    allowShared?: boolean;
    sharedReason?: string;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.kind || !['phone', 'email'].includes(body.kind)) return fail('VALIDATION_ERROR', '`kind` must be phone or email.', { param: 'kind', requestId: ctx.requestId });
  try {
    const point = addPatientContactPoint({
      orgId: ctx.orgId,
      patientId: id,
      kind: body.kind,
      label: body.label,
      value: String(body.value ?? ''),
      primary: body.primary,
      verified: body.verified,
      source: 'staff',
      allowShared: body.allowShared,
      sharedReason: body.sharedReason,
    });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'update', actor, actorName, detail: `${body.kind} contact added` });
    return ok(point, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not add the contact point.';
    return fail(message.includes('another patient') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id });
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const contactPointId = new URL(req.url).searchParams.get('contactPointId') ?? '';
  if (!contactPointId) return fail('VALIDATION_ERROR', '`contactPointId` is required.', { param: 'contactPointId', requestId: ctx.requestId });
  try {
    const point = endPatientContactPoint({ orgId: ctx.orgId, patientId: id, contactPointId });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'update', actor, actorName, detail: `${point.kind} contact ended` });
    return ok(point, { requestId: ctx.requestId });
  } catch (error) {
    return fail('NOT_FOUND', error instanceof Error ? error.message : 'Contact point not found.', { requestId: ctx.requestId });
  }
}
