import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requirePermission } from '@/lib/server/api';
import { completeDocumentUpload, uploadTokenFor } from '@/lib/server/clinical-documents';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { actorLabel, recordAccess } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireAuth(req, { scopes: ['documents:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const upload = uploadTokenFor(token);
  if (!upload || upload.orgId !== ctx.orgId) return fail('NOT_FOUND', 'Upload token not found.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.documents.write', { area: 'documents', patientId: upload.patientId });
  if (denied) return denied;
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > upload.maxBytes) {
    return fail('PAYLOAD_TOO_LARGE', `Upload exceeds this token's ${upload.maxBytes}-byte limit.`, { requestId: ctx.requestId });
  }
  const mimeType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let originalName = req.headers.get('x-voxera-file-name') ?? 'document';
  try {
    originalName = decodeURIComponent(originalName);
  } catch {
    return fail('VALIDATION_ERROR', 'X-Voxera-File-Name must be a valid encoded filename.', { param: 'x-voxera-file-name', requestId: ctx.requestId });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await req.arrayBuffer());
  } catch {
    return fail('VALIDATION_ERROR', 'Could not read upload bytes.', { requestId: ctx.requestId });
  }
  if (bytes.length > upload.maxBytes) return fail('PAYLOAD_TOO_LARGE', `Upload exceeds this token's ${upload.maxBytes}-byte limit.`, { requestId: ctx.requestId });
  try {
    requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1');
    const result = await completeDocumentUpload({
      token,
      bytes,
      mimeType,
      originalName,
      actor: ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`,
    });
    bytes.fill(0);
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: result.document.id, action: 'create', actor, actorName, detail: `version ${result.version.version} uploaded; quarantined` });
    return ok(result, { requestId: ctx.requestId, status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    bytes.fill(0);
    const message = error instanceof Error ? error.message : 'Could not complete the upload.';
    const code = message.includes('exceed') ? 'PAYLOAD_TOO_LARGE'
      : message.includes('already') || message.includes('changed repeatedly') ? 'CONFLICT'
        : message.includes('disabled') || message.includes('prohibited') ? 'FORBIDDEN'
          : 'VALIDATION_ERROR';
    return fail(code, message, { requestId: ctx.requestId });
  }
}
