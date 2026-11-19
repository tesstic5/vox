import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createLetter, lettersFor, type LetterDoc, type LetterSnapshot } from '@/lib/server/letters';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ({ name: ctx.user?.name ?? ctx.user?.email ?? ctx.key?.name ?? 'API', email: ctx.user?.email });

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['letters:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.read');
  if (denied) return denied;
  const query = new URL(req.url).searchParams;
  const data = lettersFor(ctx.orgId, { status: (query.get('status') || undefined) as LetterDoc['status'] | undefined, clientId: query.get('clientId') || undefined, referralId: query.get('referralId') || undefined });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['letters:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'letters.write');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ templateId?: string; clientId?: string; referralId?: string; bookingId?: string; recipient?: Partial<LetterSnapshot['recipient']>; custom?: Record<string, string> }>(req, 128 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body.templateId) return fail('VALIDATION_ERROR', '`templateId` is required.', { requestId: ctx.requestId });
  try {
    return ok(createLetter({ orgId: ctx.orgId, templateId: body.templateId, clientId: body.clientId, referralId: body.referralId, bookingId: body.bookingId, recipient: body.recipient, custom: body.custom, actor: actor(ctx) }), { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the letter.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
