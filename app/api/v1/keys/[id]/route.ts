import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { update, get } from '@/lib/server/db';
import type { ApiKeyDoc } from '@/lib/server/auth';
import { audit } from '@/lib/server/audit';
import { nowIso } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing API keys requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const key = get<ApiKeyDoc>('apiKeys', id);
  if (!key || key.orgId !== ctx.orgId) return fail('NOT_FOUND', `No key with id ${id}.`, { requestId: ctx.requestId });

  update<ApiKeyDoc>('apiKeys', id, { revokedAt: nowIso() } as Partial<ApiKeyDoc>);
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'key.revoked', target: id, detail: `${key.prefix}_…${key.last4}` });
  return ok({ id, revoked: true, revokedAt: nowIso() }, { requestId: ctx.requestId });
}
