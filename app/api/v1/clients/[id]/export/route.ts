import { NextResponse, type NextRequest } from 'next/server';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { fail, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import { clientSubjectAccessManifest } from '@/lib/server/client-export';
import { clientById } from '@/lib/server/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read', 'clients:export'] });
  if (ctx instanceof NextResponse) return ctx;
  const keyDenied = requireApiKeyScopes(ctx, ['clients:export', 'clinical:read', 'documents:export', 'privacy:read']);
  if (keyDenied) return keyDenied;
  const denied = requirePermission(ctx, 'clients.export', { area: 'clients', patientId: id })
    ?? requirePermission(ctx, 'clinical.export', { area: 'clinical', patientId: id })
    ?? requirePermission(ctx, 'clinical.documents.export', { area: 'documents', patientId: id })
    ?? requirePermission(ctx, 'audit.export');
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No client with id ${id}.`, { requestId: ctx.requestId });
  try {
    const manifest = clientSubjectAccessManifest({
      orgId: ctx.orgId, patientId: id, includeClinical: true, includeDocuments: true, includeAccessHistory: true,
    });
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'export', actor, actorName, detail: 'controlled subject-access manifest' });
    return new NextResponse(JSON.stringify(manifest, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="client-${id}-subject-access-${new Date().toISOString().slice(0, 10)}.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': ctx.requestId,
      },
    });
  } catch (error) {
    return fail('INTERNAL_ERROR', error instanceof Error ? error.message : 'The subject-access manifest could not be generated.', { requestId: ctx.requestId });
  }
}

export const POST = GET;
