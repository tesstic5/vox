import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth } from '@/lib/server/api';
import { get, type Doc } from '@/lib/server/db';
import { versionsFor } from '@/lib/server/versions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v1/assistants/{id}/versions — immutable history, newest first. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['assistants:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const assistant = get<Doc>('assistants', id);
  if (!assistant || assistant.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No assistant with id ${id}.`, { requestId: ctx.requestId });
  }
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 20) || 20, 100);
  const versions = versionsFor(ctx.orgId, id, limit).map((v) => ({
    id: v.id,
    version: v.version,
    message: v.message,
    createdAt: v.createdAt,
    current: v.version === Number(assistant.version ?? 1),
  }));
  return ok({ object: 'list', data: versions, total: versions.length, assistantId: id }, { requestId: ctx.requestId });
}
