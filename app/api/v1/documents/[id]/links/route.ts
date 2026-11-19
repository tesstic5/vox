import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import {
  createDocumentLink,
  documentById,
  documentLinksFor,
  removeDocumentLink,
  type DocumentLinkRelationship,
  type DocumentOwnerType,
} from '@/lib/server/clinical-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESOURCE_TYPES: DocumentOwnerType[] = ['patient', 'appointment', 'invoice', 'clinical_note', 'referral', 'form_response', 'referral_submission', 'letter', 'workspace'];
const RELATIONSHIPS: Array<Exclude<DocumentLinkRelationship, 'owner'>> = ['related', 'evidence', 'attachment', 'invoice_support', 'appointment_attachment'];

async function context(req: NextRequest, id: string, scope: 'documents:read' | 'documents:write', permission: 'clinical.documents.read' | 'clinical.documents.write') {
  const ctx = await requireAuth(req, { scopes: [scope] });
  if (ctx instanceof NextResponse) return ctx;
  const document = documentById(ctx.orgId, id);
  if (!document) return fail('NOT_FOUND', `No document with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, permission, { area: 'documents', patientId: document.patientId });
  if (denied) return denied;
  return { ctx, document };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await context(req, id, 'documents:read', 'clinical.documents.read');
  if (loaded instanceof NextResponse) return loaded;
  const data = documentLinksFor(loaded.ctx.orgId, id);
  const actor = actorLabel(loaded.ctx.auth, { email: loaded.ctx.user?.email, keyId: loaded.ctx.key?.id });
  recordAccess({ orgId: loaded.ctx.orgId, resource: 'document', resourceId: id, action: 'view', ...actor, detail: 'document links' });
  return ok({ object: 'list', data, total: data.length }, { requestId: loaded.ctx.requestId, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await context(req, id, 'documents:write', 'clinical.documents.write');
  if (loaded instanceof NextResponse) return loaded;
  const body = await readJson<{
    resourceType?: DocumentOwnerType; resourceId?: string; relationship?: Exclude<DocumentLinkRelationship, 'owner'>;
    visibleInPortal?: boolean; expectedDocumentRevision?: number;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!RESOURCE_TYPES.includes(body.resourceType as DocumentOwnerType)) {
    return fail('VALIDATION_ERROR', '`resourceType` is invalid.', { param: 'resourceType', requestId: loaded.ctx.requestId });
  }
  if (!RELATIONSHIPS.includes(body.relationship as Exclude<DocumentLinkRelationship, 'owner'>)) {
    return fail('VALIDATION_ERROR', '`relationship` is invalid.', { param: 'relationship', requestId: loaded.ctx.requestId });
  }
  if (!Number.isSafeInteger(body.expectedDocumentRevision)) {
    return fail('VALIDATION_ERROR', '`expectedDocumentRevision` is required.', { param: 'expectedDocumentRevision', requestId: loaded.ctx.requestId });
  }
  try {
    requireClinicalWriteMode(loaded.ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const saved = createDocumentLink({
      orgId: loaded.ctx.orgId, documentId: id,
      resourceType: body.resourceType!, resourceId: String(body.resourceId ?? ''), relationship: body.relationship!,
      visibleInPortal: body.visibleInPortal, expectedDocumentRevision: body.expectedDocumentRevision!,
      actor: loaded.ctx.user?.email ?? `api:${loaded.ctx.key?.id ?? 'key'}`,
    });
    const actor = actorLabel(loaded.ctx.auth, { email: loaded.ctx.user?.email, keyId: loaded.ctx.key?.id });
    recordAccess({ orgId: loaded.ctx.orgId, resource: 'document', resourceId: id, action: 'update', ...actor, detail: `linked ${saved.link.resourceType}:${saved.link.resourceId}` });
    return ok(saved, { status: 201, requestId: loaded.ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The document link could not be created.';
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') || message.includes('exists') ? 'CONFLICT' : message.includes('disabled') || message.includes('acknowledgement') ? 'FORBIDDEN' : 'VALIDATION_ERROR';
    return fail(code, message, { requestId: loaded.ctx.requestId });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await context(req, id, 'documents:write', 'clinical.documents.write');
  if (loaded instanceof NextResponse) return loaded;
  const body = await readJson<{ linkId?: string; expectedDocumentRevision?: number; expectedLinkRevision?: number }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isSafeInteger(body.expectedDocumentRevision) || !Number.isSafeInteger(body.expectedLinkRevision)) {
    return fail('VALIDATION_ERROR', 'Document and link revisions are required.', { requestId: loaded.ctx.requestId });
  }
  try {
    requireClinicalWriteMode(loaded.ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const saved = removeDocumentLink({
      orgId: loaded.ctx.orgId, documentId: id, linkId: String(body.linkId ?? ''),
      expectedDocumentRevision: body.expectedDocumentRevision!, expectedLinkRevision: body.expectedLinkRevision!,
    });
    const actor = actorLabel(loaded.ctx.auth, { email: loaded.ctx.user?.email, keyId: loaded.ctx.key?.id });
    recordAccess({ orgId: loaded.ctx.orgId, resource: 'document', resourceId: id, action: 'update', ...actor, detail: `unlinked ${saved.removed.resourceType}:${saved.removed.resourceId}` });
    return ok({ removed: saved.removed.id, document: saved.document }, { requestId: loaded.ctx.requestId, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The document link could not be removed.';
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : message.includes('disabled') || message.includes('acknowledgement') ? 'FORBIDDEN' : 'VALIDATION_ERROR';
    return fail(code, message, { requestId: loaded.ctx.requestId });
  }
}
