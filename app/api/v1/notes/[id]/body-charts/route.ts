import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  bodyChartAnnotationConflicts,
  bodyChartAnnotations,
  bodyChartAnnotationVersions,
  bodyChartExport,
  bodyChartOverlaySvg,
  createBodyChartAnnotation,
  resolveBodyChartAnnotationConflict,
  updateBodyChartAnnotation,
  verifyBodyChartAnnotationVersion,
} from '@/lib/server/clinical/body-charts';
import { appendClinicalAccessEvent } from '@/lib/server/clinical-access';
import { incompleteSections, noteById } from '@/lib/server/notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function downloadHeaders(requestId: string, contentType: string, filename: string) {
  return {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
    'content-security-policy': "default-src 'none'; style-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store, max-age=0',
    pragma: 'no-cache',
    'x-request-id': requestId,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const note = noteById(ctx.orgId, id);
  if (!note) return fail('NOT_FOUND', `No clinical note with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: note.clientId });
  if (denied) return denied;

  const annotations = bodyChartAnnotations(ctx.orgId, id);
  const versions = bodyChartAnnotationVersions(ctx.orgId, id);
  const url = new URL(req.url);
  const annotationId = url.searchParams.get('annotationId');
  const versionId = url.searchParams.get('versionId');
  const format = url.searchParams.get('format');
  const current = annotationId ? annotations.find((row) => row.id === annotationId) : undefined;
  const snapshot = versionId ? versions.find((row) => row.id === versionId) : undefined;
  const selected = snapshot ?? current;
  if ((annotationId || versionId) && !selected) return fail('NOT_FOUND', 'That body-chart annotation or immutable version is not linked to this note.', { requestId: ctx.requestId });

  appendClinicalAccessEvent({
    orgId: ctx.orgId,
    resourceType: 'clinical_note',
    resourceId: id,
    patientId: note.clientId,
    action: format === 'svg' || format === 'json' ? 'download' : 'view',
    actorId: ctx.auth === 'key' ? `api:${ctx.key?.id ?? ctx.userId}` : ctx.userId,
    actorLabel: ctx.user?.name ?? ctx.user?.email ?? ctx.key?.name,
    purpose: 'direct_care',
    requestId: ctx.requestId,
    route: `/api/v1/notes/${id}/body-charts`,
  });

  if (selected && format === 'svg') {
    return new NextResponse(bodyChartOverlaySvg(selected), { status: 200, headers: downloadHeaders(ctx.requestId, 'image/svg+xml; charset=utf-8', `body-chart-${selected.id}.svg`) });
  }
  if (selected && format === 'json') {
    return new NextResponse(JSON.stringify(bodyChartExport(selected), null, 2), { status: 200, headers: downloadHeaders(ctx.requestId, 'application/json; charset=utf-8', `body-chart-${selected.id}.json`) });
  }
  return ok({
    object: 'list', data: annotations, total: annotations.length, has_more: false,
    exports: annotations.map(bodyChartExport),
    versions: versions.map((row) => ({ ...row, integrity: verifyBodyChartAnnotationVersion(row) ? 'verified' : 'failed' })),
    conflicts: bodyChartAnnotationConflicts(ctx.orgId, id),
  }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clinical:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Body-chart annotations are clinician-authored clinical evidence and require an authenticated staff session.', { requestId: ctx.requestId });
  const { id } = await params;
  const note = noteById(ctx.orgId, id);
  if (!note) return fail('NOT_FOUND', `No clinical note with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.write', { area: 'clinical', patientId: note.clientId });
  if (denied) return denied;
  const body = await readJson<{
    action?: 'create' | 'update' | 'resolve_conflict'; annotationId?: string; templateId?: string; sectionId?: string;
    expectedRevision?: number; expectedNoteRevision?: number; conflictId?: string;
    resolution?: 'keep_current' | 'use_conflict'; marks?: unknown;
  }>(req, 1024 * 1024);
  if (body instanceof NextResponse) return body;
  const action = body.action ?? 'create';
  if (!['create', 'update', 'resolve_conflict'].includes(action)) return fail('VALIDATION_ERROR', 'Body-chart action must be create, update or resolve_conflict.', { param: 'action', requestId: ctx.requestId });
  const linked = body.annotationId ? bodyChartAnnotations(ctx.orgId, id).find((row) => row.id === body.annotationId) : undefined;
  if (action !== 'create' && !linked) return fail('NOT_FOUND', 'That body-chart annotation is not linked to this clinical note.', { requestId: ctx.requestId });

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const result = action === 'update'
    ? updateBodyChartAnnotation({ orgId: ctx.orgId, id: String(body.annotationId ?? ''), expectedRevision: Number(body.expectedRevision), expectedNoteRevision: Number(body.expectedNoteRevision), marks: body.marks, actorId: actor, actorName })
    : action === 'resolve_conflict'
      ? resolveBodyChartAnnotationConflict({ orgId: ctx.orgId, annotationId: String(body.annotationId ?? ''), conflictId: String(body.conflictId ?? ''), expectedRevision: Number(body.expectedRevision), expectedNoteRevision: Number(body.expectedNoteRevision), resolution: body.resolution === 'use_conflict' ? 'use_conflict' : 'keep_current', actorId: actor, actorName })
      : createBodyChartAnnotation({ orgId: ctx.orgId, noteId: id, templateId: String(body.templateId ?? ''), sectionId: body.sectionId, expectedNoteRevision: Number(body.expectedNoteRevision), marks: body.marks, actorId: actor, actorName });
  if (!result.ok) {
    const code = result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code === 'CONFLICT' || result.code === 'FINALISED' ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, result.error, { requestId: ctx.requestId, detail: result.conflictId });
  }

  const latestNote = noteById(ctx.orgId, id);
  appendClinicalAccessEvent({
    orgId: ctx.orgId, resourceType: 'clinical_note', resourceId: id, patientId: note.clientId,
    action: action === 'create' ? 'create' : 'update', actorId: ctx.userId,
    actorLabel: ctx.user?.name ?? ctx.user?.email, purpose: 'direct_care', requestId: ctx.requestId,
    route: `/api/v1/notes/${id}/body-charts`,
  });
  recordAccess({
    orgId: ctx.orgId, resource: 'note', resourceId: id, action: action === 'create' ? 'create' : 'update',
    actor, actorName, detail: `body chart ${result.value.id}: ${action}`, clinicalAlreadyRecorded: true,
  });
  return ok({
    annotation: result.value,
    noteRevision: latestNote?.revision,
    incomplete: latestNote ? incompleteSections(latestNote) : [],
    conflicts: bodyChartAnnotationConflicts(ctx.orgId, id),
  }, { requestId: ctx.requestId, status: action === 'create' ? 201 : 200 });
}
