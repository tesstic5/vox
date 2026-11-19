import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import {
  createDocumentUploadToken,
  documentExportManifest,
  documentLinksFor,
  documentsFor,
  resolveDocumentOwnerPatientId,
  type DocumentOwnerType,
} from '@/lib/server/clinical-documents';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { shadowPermissionDecision } from '@/lib/server/permissions';
import { recordAccess, actorLabel } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['documents:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const patientId = url.searchParams.get('patientId') ?? undefined;
  const denied = requirePermission(ctx, 'clinical.documents.read', { area: 'documents', patientId });
  if (denied) return denied;
  let documents = documentsFor(ctx.orgId, {
    patientId,
    ownerType: (url.searchParams.get('ownerType') as DocumentOwnerType | null) ?? undefined,
    ownerId: url.searchParams.get('ownerId') ?? undefined,
    includeArchived: url.searchParams.get('includeArchived') === 'true',
  });
  if (ctx.auth === 'session' && ctx.user?.roleId && !patientId) {
    documents = documents.filter((document) => !document.patientId || shadowPermissionDecision(ctx.user!, 'clinical.documents.read', { area: 'documents', patientId: document.patientId }).allowed);
  }
  if (url.searchParams.get('view') === 'export') {
    const keyDenied = requireApiKeyScopes(ctx, ['documents:export']);
    if (keyDenied) return keyDenied;
    const exportDenied = requirePermission(ctx, 'clinical.documents.export', { area: 'documents', patientId });
    if (exportDenied) return exportDenied;
    const manifest = documentExportManifest(ctx.orgId, { patientId, documentIds: documents.map((document) => document.id) });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: patientId ?? '*', action: 'export', actor, actorName, detail: 'document manifest' });
    return new NextResponse(JSON.stringify(manifest, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="clinical-document-manifest-${new Date().toISOString().slice(0, 10)}.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': ctx.requestId,
      },
    });
  }
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: patientId ?? '*', action: 'list', actor, actorName, detail: `${documents.length} document metadata row(s)` });
  return ok({
    object: 'list', data: documents.map((document) => ({ ...document, links: documentLinksFor(ctx.orgId, document.id) })), total: documents.length,
    note: 'Metadata-only legacy rows have no retrievable bytes. Pending, unavailable, error and infected versions remain quarantined.',
  }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['documents:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    documentId?: string;
    ownerType?: DocumentOwnerType;
    ownerId?: string;
    patientId?: string;
    title?: string;
    category?: string;
    allowedMimeTypes?: string[];
    maxBytes?: number;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.ownerType || !['patient', 'appointment', 'invoice', 'clinical_note', 'referral', 'form_response', 'referral_submission', 'letter', 'workspace'].includes(body.ownerType)) {
    return fail('VALIDATION_ERROR', '`ownerType` must be patient, appointment, invoice, clinical_note, referral, form_response, referral_submission, letter or workspace.', { param: 'ownerType', requestId: ctx.requestId });
  }
  let patientId: string | undefined;
  try {
    patientId = resolveDocumentOwnerPatientId(ctx.orgId, body.ownerType, String(body.ownerId ?? ''), body.patientId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document owner could not be resolved.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
  const denied = requirePermission(ctx, 'clinical.documents.write', { area: 'documents', patientId });
  if (denied) return denied;
  try {
    requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const created = createDocumentUploadToken({
      orgId: ctx.orgId,
      documentId: body.documentId,
      ownerType: body.ownerType,
      ownerId: String(body.ownerId ?? ''),
      patientId,
      title: String(body.title ?? ''),
      category: body.category,
      allowedMimeTypes: body.allowedMimeTypes,
      maxBytes: body.maxBytes,
      actor: ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`,
    });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: String(created.upload.documentId), action: 'create', actor, actorName, detail: 'single-use upload capability issued' });
    return ok({
      upload: created.upload,
      token: created.token,
      method: 'PUT',
      uploadPath: `/api/v1/documents/uploads/${encodeURIComponent(created.token)}`,
      expiresAt: created.upload.expiresAt,
      note: 'The token is returned once, stored only as a hash, and the completed version remains quarantined until a scanner returns clean.',
    }, { requestId: ctx.requestId, status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the upload token.';
    return fail(message.includes('disabled') || message.includes('prohibited') ? 'FORBIDDEN' : message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
