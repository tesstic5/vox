import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, requireAuth, requirePermission } from '@/lib/server/api';
import { bodyChartTemplateById } from '@/lib/server/clinical/body-charts';
import { documentById, downloadDocumentVersion } from '@/lib/server/clinical-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clinical:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.read');
  if (denied) return denied;
  const { id } = await params;
  const template = bodyChartTemplateById(ctx.orgId, id);
  if (!template) return fail('NOT_FOUND', `No body-chart template with id ${id}.`, { requestId: ctx.requestId });
  const sourceDocument = documentById(ctx.orgId, template.sourceDocumentId);
  if (!sourceDocument || sourceDocument.ownerType !== 'workspace' || sourceDocument.patientId) return fail('CONFLICT', 'This template does not point to an approved workspace-owned source image.', { requestId: ctx.requestId });

  try {
    const result = await downloadDocumentVersion(ctx.orgId, template.sourceDocumentId, template.sourceDocumentVersionId);
    if (result.version.mimeType !== template.sourceMimeType) throw new Error('the pinned source image MIME type no longer matches its body-chart template');
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: template.sourceDocumentId, action: 'view', actor, actorName, detail: `body-chart template ${template.id}; pinned version ${template.sourceDocumentVersionId}` });
    const extension = template.sourceMimeType === 'image/png' ? 'png' : template.sourceMimeType === 'image/webp' ? 'webp' : 'jpg';
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'content-type': template.sourceMimeType,
        'content-length': String(result.bytes.length),
        'content-disposition': `inline; filename="body-chart-${template.id}.${extension}"`,
        'cache-control': 'private, no-store, max-age=0',
        pragma: 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'x-request-id': ctx.requestId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Body-chart source image retrieval failed.';
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('quarantined') || message.includes('archived') || message.includes('MIME') ? 'CONFLICT' : 'INTERNAL_ERROR';
    return fail(code, message, { requestId: ctx.requestId });
  }
}
