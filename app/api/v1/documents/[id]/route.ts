import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import {
  archiveDocument,
  documentById,
  documentLinksFor,
  documentVersionsFor,
  latestScanEvent,
  type ClinicalDocumentDoc,
} from '@/lib/server/clinical-documents';
import { commitBatch } from '@/lib/server/db';
import { actorLabel, recordAccess, recordView } from '@/lib/server/access-log';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['documents:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const document = documentById(ctx.orgId, id);
  if (!document) return fail('NOT_FOUND', `No document with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.documents.read', { area: 'documents', patientId: document.patientId });
  if (denied) return denied;
  const versions = documentVersionsFor(ctx.orgId, id).map((version) => ({ ...version, envelope: undefined, objectKey: undefined, scan: latestScanEvent(ctx.orgId, version.id) }));
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordView({ orgId: ctx.orgId, resource: 'document', resourceId: id, actor, actorName });
  return ok({ ...document, links: documentLinksFor(ctx.orgId, id), versions }, { requestId: ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['documents:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const document = documentById(ctx.orgId, id);
  if (!document) return fail('NOT_FOUND', `No document with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.documents.write', { area: 'documents', patientId: document.patientId });
  if (denied) return denied;
  const body = await readJson<{ title?: string; category?: string; archive?: boolean; expectedRevision?: number }>(req);
  if (body instanceof NextResponse) return body;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== Number(document.revision ?? 0)) {
    return fail('CONFLICT', 'The document changed after this screen loaded. Reload it before saving.', { param: 'expectedRevision', requestId: ctx.requestId });
  }
  try {
    if (body.archive) {
      const archived = archiveDocument({ orgId: ctx.orgId, id, actor: ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`, expectedRevision: body.expectedRevision });
      const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
      recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: id, action: 'archive', actor, actorName });
      return ok(archived, { requestId: ctx.requestId });
    }
    const title = body.title === undefined ? document.title : body.title.trim();
    const category = body.category === undefined ? document.category : body.category.trim();
    if (!title || title.length > 180 || !category || category.length > 120) throw new Error('title and category are required and must fit their limits');
    const updated = commitBatch({
      upserts: [{
        collection: 'clinicalDocuments',
        doc: { ...document, title, category } as ClinicalDocumentDoc,
        expectedRevision: Number(document.revision ?? 0), expectedOrgId: ctx.orgId,
      }],
    }).upserts[0] as ClinicalDocumentDoc;
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: id, action: 'update', actor, actorName, detail: 'document metadata updated' });
    return ok(updated, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the document.';
    return fail(error instanceof Error && error.name === 'CommitConflictError' ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
