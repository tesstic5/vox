import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { contactsFor, createContact, type ContactDoc } from '@/lib/server/intake-admin';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read');
  if (denied) return denied;
  const url = new URL(req.url);
  const data = contactsFor(ctx.orgId, {
    q: url.searchParams.get('q') ?? undefined,
    active: url.searchParams.has('active') ? url.searchParams.get('active') === 'true' : undefined,
    referrer: url.searchParams.has('referrer') ? url.searchParams.get('referrer') === 'true' : undefined,
    payer: url.searchParams.has('payer') ? url.searchParams.get('payer') === 'true' : undefined,
  });
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.write');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Contact writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<Partial<ContactDoc>>(req);
  if (body instanceof NextResponse) return body;
  try {
    const row = createContact({
      orgId: ctx.orgId, kind: body.kind, name: String(body.name ?? ''), email: body.email, phone: body.phone,
      address: body.address, referrer: body.referrer, payer: body.payer, notes: body.notes, actor: actor(ctx),
    });
    return ok(row, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the contact.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT/i.test(message);
    return fail(storageConflict ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'The contact could not be created because the record changed. Try again.' : message, { requestId: ctx.requestId });
  }
}
