import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, publicOrigin, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { createFormAssignment, formAssignmentsFor, markFormAssignmentSent, type FormAssignmentDoc } from '@/lib/server/forms';
import { clientById } from '@/lib/server/clients';
import { queueMessage } from '@/lib/server/messages';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const actor = (ctx: Exclude<Awaited<ReturnType<typeof requireAuth>>, NextResponse>) => ctx.user?.email ?? ctx.key?.id ?? 'api';
const safe = ({ tokenHash: _tokenHash, ...row }: FormAssignmentDoc) => row;

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.read');
  if (denied) return denied;
  const query = new URL(req.url).searchParams;
  const data = formAssignmentsFor(ctx.orgId, {
    clientId: query.get('clientId') || undefined,
    templateId: query.get('templateId') || undefined,
    status: (query.get('status') || undefined) as FormAssignmentDoc['status'] | undefined,
  }).map(safe);
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['forms:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'forms.assign');
  if (denied) return denied;
  try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
  catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  const body = await readJson<{
    templateId?: string; clientId?: string; bookingId?: string; referralId?: string; relatedContactId?: string;
    expiresAt?: string; send?: boolean; channel?: 'email' | 'sms'; to?: string;
    reminderPolicy?: FormAssignmentDoc['reminderPolicy'];
  }>(req, 64 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body.templateId) return fail('VALIDATION_ERROR', '`templateId` is required.', { param: 'templateId', requestId: ctx.requestId });
  const client = body.clientId ? clientById(ctx.orgId, body.clientId) : undefined;
  if (body.clientId && !client) return fail('NOT_FOUND', 'Client not found.', { requestId: ctx.requestId });
  const channel = body.channel ?? 'email';
  const to = String(body.to ?? (channel === 'email' ? client?.email : client?.number) ?? '').trim();
  if (body.send && !to) return fail('VALIDATION_ERROR', `No ${channel} destination is available.`, { param: 'to', requestId: ctx.requestId });
  try {
    const created = createFormAssignment({
      orgId: ctx.orgId, templateId: body.templateId, clientId: body.clientId, bookingId: body.bookingId,
      referralId: body.referralId, relatedContactId: body.relatedContactId, expiresAt: body.expiresAt,
      reminderPolicy: body.reminderPolicy, actor: actor(ctx),
    });
    const publicUrl = `${publicOrigin(req)}/forms/${encodeURIComponent(created.token)}`;
    let assignment = created.assignment;
    let message;
    if (body.send) {
      message = queueMessage({
        orgId: ctx.orgId, clientId: body.clientId, bookingId: body.bookingId, channel, to,
        subject: channel === 'email' ? 'A secure form from your care team' : undefined,
        body: `Please complete your secure form: ${publicUrl}\n\nThis private link expires ${new Date(assignment.expiresAt).toLocaleDateString('en-GB')}.`,
        source: 'form-assignment', kind: 'manual', meta: { assignmentId: assignment.id },
      });
      assignment = markFormAssignmentSent({ orgId: ctx.orgId, id: assignment.id, messageId: message.id, actor: actor(ctx) });
    }
    return ok({ assignment: safe(assignment), publicUrl, message }, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not assign the form.';
    return fail(message.includes('not found') ? 'NOT_FOUND' : message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR', message, { requestId: ctx.requestId });
  }
}
