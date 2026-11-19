import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createLetterCorrection, letterById, letterVersion, queueLetterEmail, reviseLetter, transitionLetter } from '@/lib/server/letters';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { recordAccess } from '@/lib/server/access-log';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['letters:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.read');
  if (denied) return denied;
  const { id } = await params;
  const letter = letterById(ctx.orgId, id);
  if (!letter) return fail('NOT_FOUND', 'Letter not found.', { requestId: ctx.requestId });
  if (letter.clientId) {
    const scoped = requirePermission(ctx, 'clinical.read', { area: 'clinical', patientId: letter.clientId });
    if (scoped) return scoped;
    recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: letter.clientId, action: 'view', actor: actor(ctx), detail: `letter ${id}` });
  }
  return ok({ letter, version: letterVersion(ctx.orgId, id) }, { requestId: ctx.requestId });
}

type Body = { action?: 'revise' | 'submit' | 'approve' | 'finalise' | 'cancel' | 'email' | 'correct'; expectedRevision?: number; subject?: string; body?: string; footer?: string; to?: string; reason?: string };

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['letters:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const body = await readJson<Body>(req, 256 * 1024);
  if (body instanceof NextResponse) return body;
  const permission = body.action === 'approve' || body.action === 'correct' ? 'letters.approve' : body.action === 'email' ? 'letters.send' : 'letters.write';
  const denied = requirePermission(ctx, permission);
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  if (!body.action || !Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`action` and `expectedRevision` are required.', { requestId: ctx.requestId });
  try {
    const result = await (body.action === 'revise'
      ? reviseLetter({ orgId: ctx.orgId, id, subject: String(body.subject ?? ''), body: String(body.body ?? ''), footer: body.footer, actor: actor(ctx), expectedRevision: body.expectedRevision! })
      : body.action === 'email'
        ? queueLetterEmail({ orgId: ctx.orgId, id, to: body.to, actor: actor(ctx), expectedRevision: body.expectedRevision! })
        : body.action === 'correct'
          ? createLetterCorrection({ orgId: ctx.orgId, id, reason: String(body.reason ?? ''), actor: actor(ctx), expectedRevision: body.expectedRevision! })
          : transitionLetter({ orgId: ctx.orgId, id, action: body.action, actor: actor(ctx), expectedRevision: body.expectedRevision! }));
    return ok(result, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update the letter.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : storageConflict || message.includes('changed') || message.includes('only') || message.includes('must') || message.includes('already') || message.includes('cannot') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'This letter changed while its correction or transition was being saved. Reload it and try again.' : message, { requestId: ctx.requestId });
  }
}
