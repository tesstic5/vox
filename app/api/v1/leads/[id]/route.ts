import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { canWorkLeads, LEAD_STATUSES, updateLead } from '@/lib/server/leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/v1/leads/{id} — work one lead: move it along the pipeline,
 * assign it, or add a note. Every change lands in the lead's own log, and
 * status moves land in the audit trail too.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !canWorkLeads(ctx.user)) {
    return fail('FORBIDDEN', 'The sales inbox is for the team that answers the form.', { requestId: ctx.requestId });
  }
  const { id } = await params;
  const body = await readJson<{ status?: string; assignee?: string; note?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (body.status !== undefined && !(LEAD_STATUSES as readonly string[]).includes(body.status)) {
    return fail('VALIDATION_ERROR', `status must be one of: ${LEAD_STATUSES.join(', ')}.`, { param: 'status', requestId: ctx.requestId });
  }
  const lead = updateLead(id, body, ctx.user?.email ?? 'dashboard');
  if (!lead) return fail('NOT_FOUND', 'No such lead.', { requestId: ctx.requestId });
  if (body.status) {
    audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? 'dashboard', action: 'lead.status_changed', target: id, detail: `${lead.company} → ${body.status}` });
  }
  return ok(lead, { requestId: ctx.requestId });
}
