import { NextResponse, type NextRequest } from 'next/server';
import { fail, requireAuth, requirePermission } from '@/lib/server/api';
import { get, type Doc } from '@/lib/server/db';
import { buildWorkspaceExport } from '@/lib/server/workspace-export';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import { recordScopeFor } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/workspaces/export — download everything this workspace owns.
 *
 * Session-only and owner/admin-only: this is the whole workspace in one
 * file, so an API key (scoped, automatable, leakable) does not get to
 * ask for it, and neither does a viewer. The export itself is audited.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user || !['owner', 'admin'].includes(ctx.user.role)) {
    return fail('FORBIDDEN', 'A workspace export is for the workspace owner or an admin, signed in.', { requestId: ctx.requestId });
  }
  // The aggregate file crosses several sensitive domains. Holding an admin
  // label alone is not an export grant once a custom role is assigned.
  const exportDenied = requirePermission(ctx, 'clients.export')
    ?? requirePermission(ctx, 'cases.read')
    ?? requirePermission(ctx, 'coverage.sensitive.read')
    ?? requirePermission(ctx, 'clinical.export')
    ?? requirePermission(ctx, 'clinical.documents.export')
    ?? requirePermission(ctx, 'audit.export');
  if (exportDenied) return exportDenied;
  if (ctx.user.roleId && (['clients', 'cases', 'clinical', 'documents'] as const).some((area) => recordScopeFor(ctx.user!, area) !== 'all')) {
    return fail('FORBIDDEN', 'A whole-workspace export requires all-record scope. Use the scoped client or document export instead.', { requestId: ctx.requestId });
  }

  const data = buildWorkspaceExport(ctx.orgId, ctx.user.email);
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user.email });
  recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: '*', action: 'export', actor, actorName, detail: 'authorised whole-workspace export' });
  recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: '*', action: 'export', actor, actorName, detail: 'controlled document manifest included; encrypted storage internals excluded' });
  const org = get<Doc & { slug?: string }>('orgs', ctx.orgId);
  const slug = String(org?.slug ?? ctx.orgId).replace(/[^a-z0-9-]/gi, '-');
  const filename = `voxera-workspace-${slug}-${data.exportedAt.slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-request-id': ctx.requestId,
    },
  });
}
