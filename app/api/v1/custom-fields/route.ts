import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createCustomFieldDefinition, customFieldDefinitionsFor, type CustomFieldDefinitionDoc, type CustomFieldTarget, type CustomFieldValueType } from '@/lib/server/intake-admin';
import { CommitConflictError } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TARGETS = new Set(['client', 'referral', 'contact']);
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const rawTarget = params.get('targetType');
  if (rawTarget && !TARGETS.has(rawTarget)) return fail('VALIDATION_ERROR', '`targetType` must be client, referral or contact.', { requestId: ctx.requestId });
  const data = customFieldDefinitionsFor(ctx.orgId, rawTarget as CustomFieldTarget | undefined, params.get('includeInactive') === 'true');
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.manage');
  if (denied) return denied;
  const body = await readJson<Partial<CustomFieldDefinitionDoc>>(req);
  if (body instanceof NextResponse) return body;
  try {
    const row = createCustomFieldDefinition({
      orgId: ctx.orgId, targetType: body.targetType as CustomFieldTarget, key: String(body.key ?? ''), label: String(body.label ?? ''),
      valueType: body.valueType as CustomFieldValueType, options: body.options, sensitivity: body.sensitivity,
      required: body.required, order: body.order, actor: actor(ctx),
    });
    return ok(row, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create the custom field.';
    const storageConflict = error instanceof CommitConflictError || /duplicate key|unique constraint|SQLITE_CONSTRAINT/i.test(message);
    return fail(storageConflict || message.includes('already exists') ? 'CONFLICT' : 'VALIDATION_ERROR', storageConflict ? 'That custom-field key is already in use. Reload the catalogue and try again.' : message, { requestId: ctx.requestId });
  }
}
