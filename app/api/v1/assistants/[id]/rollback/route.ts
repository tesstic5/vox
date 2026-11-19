import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { update, get, nowIso, type Doc } from '@/lib/server/db';
import { restoreVersion, snapshotAssistant } from '@/lib/server/versions';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /v1/assistants/{id}/rollback — restore a version as a new version. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['assistants:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ version?: number }>(req);
  if (body instanceof NextResponse) return body;
  const version = Number(body.version);
  if (!version || Number.isNaN(version)) {
    return fail('VALIDATION_ERROR', 'Send the `version` number to restore.', { param: 'version', requestId: ctx.requestId });
  }

  const result = restoreVersion(ctx.orgId, id, version, 'dashboard');
  if (!result) return fail('NOT_FOUND', `No version ${version} for assistant ${id}.`, { requestId: ctx.requestId });

  const saved = update<Doc & Record<string, unknown>>('assistants', id, result.updated);
  if (!saved) return fail('INTERNAL_ERROR', 'Rollback failed.', { requestId: ctx.requestId });

  const snapshot = snapshotAssistant(saved, `Rollback to v${version}`, 'dashboard');
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'assistant.rollback', target: id, detail: `from v${result.target.version + 1} to v${version}` });

  return ok(
    { id, rolledBackTo: version, version: snapshot.version, assistant: get<Doc>('assistants', id), at: nowIso() },
    { requestId: ctx.requestId }
  );
}
