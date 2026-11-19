import { NextResponse, type NextRequest } from 'next/server';
import { fail, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import { documentById, downloadDocumentVersion } from '@/lib/server/clinical-documents';
import { actorLabel, recordAccess } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function attachmentName(name: string) {
  const safe = name.replace(/[\r\n"\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'document';
  return `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['documents:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const keyDenied = requireApiKeyScopes(ctx, ['documents:download']);
  if (keyDenied) return keyDenied;
  const document = documentById(ctx.orgId, id);
  if (!document) return fail('NOT_FOUND', `No document with id ${id}.`, { requestId: ctx.requestId });
  const denied = requirePermission(ctx, 'clinical.documents.download', { area: 'documents', patientId: document.patientId });
  if (denied) return denied;
  try {
    const result = await downloadDocumentVersion(ctx.orgId, id, new URL(req.url).searchParams.get('versionId') ?? undefined);
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: id, action: 'download', actor, actorName, detail: `version ${result.version.version}` });
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'content-type': result.version.mimeType,
        'content-length': String(result.bytes.length),
        'content-disposition': attachmentName(result.version.originalName),
        'cache-control': 'private, no-store, max-age=0',
        pragma: 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'x-request-id': ctx.requestId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document download failed.';
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('quarantined') || message.includes('metadata') || message.includes('archived') ? 'CONFLICT' : 'INTERNAL_ERROR';
    return fail(code, message, { requestId: ctx.requestId });
  }
}
