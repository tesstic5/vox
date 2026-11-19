import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireApiKeyScopes, requireAuth, requirePermission } from '@/lib/server/api';
import {
  customFieldDefinitionById,
  customFieldDefinitionsFor,
  customFieldValuesFor,
  setCustomFieldValue,
} from '@/lib/server/intake-admin';
import { referralById } from '@/lib/server/referrals';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';
import { permissionDecision } from '@/lib/server/permissions';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.read');
  if (denied) return denied;
  const { id } = await params;
  if (!referralById(ctx.orgId, id)) return fail('NOT_FOUND', 'Referral not found.', { requestId: ctx.requestId });
  const values = customFieldValuesFor(ctx.orgId, 'referral', id);
  const valueByDefinition = new Map(values.map((row) => [row.definitionId, row]));
  const canReadRestricted = ctx.auth === 'key'
    ? Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('clinical:read'))
    : Boolean(ctx.user && permissionDecision(ctx.user, 'clinical.read', { area: 'clinical' }).allowed);
  const data = customFieldDefinitionsFor(ctx.orgId, 'referral')
    .filter((definition) => definition.sensitivity === 'administrative' || canReadRestricted)
    .map((definition) => ({ definition, value: valueByDefinition.get(definition.id) }));
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['referrals:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'referrals.write');
  if (denied) return denied;
  const { id } = await params;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Referral writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{ definitionId?: string; value?: unknown; expectedRevision?: number | null }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.definitionId) return fail('VALIDATION_ERROR', '`definitionId` is required.', { requestId: ctx.requestId });
  const definition = customFieldDefinitionById(ctx.orgId, body.definitionId);
  if (!definition || definition.targetType !== 'referral') return fail('NOT_FOUND', 'Custom-field definition not found.', { requestId: ctx.requestId });
  if (definition.sensitivity !== 'administrative') {
    const scopeDenied = requireApiKeyScopes(ctx, ['clinical:write']);
    if (scopeDenied) return scopeDenied;
    const clinicalDenied = requirePermission(ctx, 'clinical.write', { area: 'clinical' });
    if (clinicalDenied) return clinicalDenied;
  }
  if (!(body.expectedRevision === null || Number.isInteger(body.expectedRevision))) return fail('VALIDATION_ERROR', '`expectedRevision` is required; use null only when creating the first value.', { requestId: ctx.requestId });
  try {
    const row = setCustomFieldValue({
      orgId: ctx.orgId,
      definitionId: body.definitionId,
      targetType: 'referral',
      targetId: id,
      value: body.value,
      source: 'staff',
      verificationStatus: 'verified',
      actor: actor(ctx),
      expectedRevision: body.expectedRevision,
    });
    return ok(row, { requestId: ctx.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save the custom-field value.';
    const conflict = error instanceof CommitConflictError || /duplicate key|unique constraint|revision changed|SQLITE_CONSTRAINT/i.test(message);
    return fail(message.includes('not found') ? 'NOT_FOUND' : conflict || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', conflict ? 'This custom-field value changed while it was being saved. Reload the referral and try again.' : message, { requestId: ctx.requestId });
  }
}
