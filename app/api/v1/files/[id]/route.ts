import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, list, remove, update, nowIso, type Doc } from '@/lib/server/db';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function load(req: NextRequest, id: string) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const file = get<Doc>('files', id);
  if (!file || file.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No file with id ${id}.`, { requestId: ctx.requestId });
  }
  return { ctx, file };
}

/** A legacy metadata row; no read mutates it or invents an indexing result. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  return ok(
    {
      id: res.file.id,
      name: res.file.name ?? 'Unnamed file record',
      bytes: Number(res.file.bytes ?? 0),
      purpose: res.file.purpose ?? 'unknown',
      sha256: res.file.sha256 ?? null,
      createdAt: res.file.createdAt,
      capability: 'metadata_only',
      status: 'unavailable',
      note: 'No uploaded bytes or retrieval index are present for this legacy metadata record.',
    },
    { requestId: res.ctx.requestId }
  );
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await load(req, id);
  if (res instanceof NextResponse) return res;
  // Detach from every assistant that credited answers to this file, and say
  // which ones — the response is what a client uses to invalidate its cache.
  const attachedTo: string[] = [];
  for (const assistant of list<Doc & { orgId?: string; knowledgeFiles?: string[] }>('assistants', (a) => a.orgId === res.ctx.orgId)) {
    const files = assistant.knowledgeFiles ?? [];
    if (!files.includes(id)) continue;
    update('assistants', assistant.id, { knowledgeFiles: files.filter((f) => f !== id) });
    attachedTo.push(String(assistant.id));
  }
  remove('files', id);
  audit({ orgId: res.ctx.orgId, actor: 'dashboard', action: 'file.deleted', target: id, detail: String(res.file.name) });
  return ok({ id, deleted: true, detachedFrom: attachedTo, at: nowIso() }, { requestId: res.ctx.requestId });
}
