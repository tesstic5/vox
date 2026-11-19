import { NextResponse, type NextRequest } from 'next/server';
import { ok, requireAuth, requirePermission } from '@/lib/server/api';
import { documentsFor, migrateLegacyFileMetadata } from '@/lib/server/clinical-documents';
import { list, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';
import { actorLabel, recordAccess } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['documents:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.documents.read');
  if (denied) return denied;
  const legacy = list<Doc & { orgId?: string }>('files', (row) => row.orgId === ctx.orgId);
  const migrated = documentsFor(ctx.orgId, { includeArchived: true })
    .filter((row) => row.status === 'metadata_only' && row.legacySource?.collection === 'files');
  const migratedSourceIds = new Set(migrated.map((row) => row.legacySource!.id));
  const pending = legacy.filter((row) => !migratedSourceIds.has(row.id)).length;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: '*', action: 'list', actor, actorName, detail: 'legacy metadata migration status' });
  return ok({ legacyRows: legacy.length, metadataOnlyDocuments: migrated.length, pending }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['documents:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clinical.documents.write');
  if (denied) return denied;
  const result = migrateLegacyFileMetadata(ctx.orgId, ctx.user?.email ?? `api:${ctx.key?.id ?? 'key'}`);
  audit({
    orgId: ctx.orgId,
    actor: ctx.user?.email ?? 'api',
    action: 'documents.legacy_metadata_migrated',
    target: 'files',
    detail: `${result.migrated} migrated, ${result.existing} already present; no byte availability claimed`,
  });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'document', resourceId: '*', action: 'create', actor, actorName, detail: `${result.migrated} metadata-only document(s) migrated` });
  return ok(result, { requestId: ctx.requestId });
}
