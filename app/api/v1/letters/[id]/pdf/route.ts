import { NextResponse, type NextRequest } from 'next/server';
import { fail, requireAuth, requirePermission } from '@/lib/server/api';
import { letterPdf } from '@/lib/server/letters';
import { recordAccess } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['letters:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.read');
  if (denied) return denied;
  const { id } = await params;
  let result;
  try {
    result = await letterPdf(ctx.orgId, id);
  } catch {
    return fail('CONFLICT', 'The finalised PDF could not be verified. Nothing was downloaded; ask an administrator to check document storage.', { requestId: ctx.requestId });
  }
  if (!result) return fail('NOT_FOUND', 'A finalised PDF is not available for this letter.', { requestId: ctx.requestId });
  if (result.letter.clientId) {
    const scoped = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: result.letter.clientId });
    if (scoped) return scoped;
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: result.letter.clientId, action: 'download', actor: ctx.user?.email ?? ctx.key?.id ?? 'api', detail: `letter PDF ${id}` });
  }
  return new NextResponse(new Uint8Array(result.pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="letter-${id.replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`,
      'cache-control': 'no-store, private',
      etag: `"${result.letter.artifactHash ?? result.version.contentHash}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
