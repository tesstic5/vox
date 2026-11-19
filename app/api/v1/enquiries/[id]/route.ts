import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { enquiryById, setEnquiryStatus, updateEnquiry, type EnquiryStatus, type EnquiryUrgency, type SiteAddress } from '@/lib/server/field-service';
import { fieldActor, fieldCoordinationRole, fieldFailure, technicianJobIds } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const enquiry = enquiryById(ctx.orgId, id);
  if (!enquiry) return fail('NOT_FOUND', 'No such enquiry in this workspace.', { requestId: ctx.requestId });
  const assignedJobs = technicianJobIds(ctx);
  if (assignedJobs && enquiry.assignedTo !== ctx.userId && !(enquiry.jobId && assignedJobs.has(enquiry.jobId))) {
    return fail('FORBIDDEN', 'Technicians can access only enquiries tied to their assigned work.', { requestId: ctx.requestId });
  }
  return ok(enquiry, { requestId: ctx.requestId });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx) ?? fieldCoordinationRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<{ description?: string; urgency?: EnquiryUrgency; siteAddress?: SiteAddress; assignedTo?: string }>(req);
  if (body instanceof NextResponse) return body;
  const result = updateEnquiry({ orgId: ctx.orgId, id, patch: body, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx) ?? fieldCoordinationRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const body = await readJson<{ action?: string; status?: EnquiryStatus; note?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (body.action !== 'status' || !body.status) {
    return fail('VALIDATION_ERROR', '`action` must be status and `status` is required.', { requestId: ctx.requestId });
  }
  const result = setEnquiryStatus({ orgId: ctx.orgId, id, status: body.status, note: body.note, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
}
