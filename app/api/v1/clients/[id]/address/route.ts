import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireDeskRole, requirePermission } from '@/lib/server/api';
import { clientById, updateClientStructuredAddress } from '@/lib/server/clients';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { actorLabel } from '@/lib/server/access-log';
import { CommitConflictError } from '@/lib/server/db';
import type { StructuredAddressInput } from '@/lib/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const denied = requirePermission(ctx, 'clients.write', { area: 'clients', patientId: id }) ?? requireDeskRole(ctx);
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', 'Patient not found.', { requestId: ctx.requestId });
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Patient writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ expectedRevision?: number; address?: StructuredAddressInput }>(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.expectedRevision)) return fail('VALIDATION_ERROR', '`expectedRevision` is required.', { param: 'expectedRevision', requestId: ctx.requestId });
  if (!body.address) return fail('VALIDATION_ERROR', '`address` is required.', { param: 'address', requestId: ctx.requestId });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  try {
    return ok(updateClientStructuredAddress({
      orgId: ctx.orgId,
      id,
      address: body.address,
      expectedRevision: body.expectedRevision!,
      actor,
      actorName,
    }), { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review the address.';
    const conflict = error instanceof CommitConflictError || /changed|revision|constraint/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'VALIDATION_ERROR', conflict ? 'This patient changed while the address was being saved. Reload the record and try again.' : message, { requestId: ctx.requestId });
  }
}
