import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import {
  invoiceJob,
  jobById,
  setJobStatus,
  updateJob,
  visitsFor,
  type EstimateLineInput,
  type JobStatus,
  type SiteAddress,
} from '@/lib/server/field-service';
import { invoiceById } from '@/lib/server/money';
import { fieldActor, fieldFailure, fieldFinanceRole, practitionerJobDenied } from '@/lib/server/field-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: JobStatus[] = ['unscheduled', 'scheduled', 'in_progress', 'completed', 'cancelled'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const job = jobById(ctx.orgId, id);
  if (!job) return fail('NOT_FOUND', 'No such job in this workspace.', { requestId: ctx.requestId });
  const accessDenied = practitionerJobDenied(ctx, id);
  if (accessDenied) return accessDenied;
  return ok(
    {
      job,
      visits: visitsFor(ctx.orgId, { jobId: job.id }),
      invoice: job.invoiceId ? invoiceById(ctx.orgId, job.invoiceId) : undefined,
    },
    { requestId: ctx.requestId }
  );
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const assignedDenied = practitionerJobDenied(ctx, id);
  if (assignedDenied) return assignedDenied;
  const body = await readJson<{ description?: string; siteAddress?: SiteAddress; workSummary?: string; lines?: EstimateLineInput[] }>(req);
  if (body instanceof NextResponse) return body;
  if (body.lines !== undefined) {
    const financeDenied = fieldFinanceRole(ctx);
    if (financeDenied) return financeDenied;
  }
  const result = updateJob({ orgId: ctx.orgId, id, ...body, actor: fieldActor(ctx) });
  const failed = fieldFailure(result, ctx.requestId);
  return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req, { scopes: ['field:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const { id } = await params;
  const assignedDenied = practitionerJobDenied(ctx, id);
  if (assignedDenied) return assignedDenied;
  const body = await readJson<{ action?: string; status?: JobStatus; note?: string }>(req);
  if (body instanceof NextResponse) return body;
  const actor = fieldActor(ctx);

  if (body.action === 'invoice') {
    const financeDenied = fieldFinanceRole(ctx);
    if (financeDenied) return financeDenied;
    const result = invoiceJob({ orgId: ctx.orgId, id, actor });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { status: 201, requestId: ctx.requestId });
  }

  if (body.action === 'reopen') {
    const job = jobById(ctx.orgId, id);
    if (!job) return fail('NOT_FOUND', 'No such job in this workspace.', { requestId: ctx.requestId });
    if (!['completed', 'cancelled'].includes(job.status)) return fail('CONFLICT', 'Only a completed or cancelled job needs reopening.', { requestId: ctx.requestId });
    const target: JobStatus = job.status === 'completed' ? 'scheduled' : 'unscheduled';
    const result = setJobStatus({ orgId: ctx.orgId, id, status: target, note: body.note, actor, reopen: true });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
  }

  if (body.action === 'status' && body.status && STATUSES.includes(body.status)) {
    const result = setJobStatus({ orgId: ctx.orgId, id, status: body.status, note: body.note, actor });
    const failed = fieldFailure(result, ctx.requestId);
    return failed ?? ok(result.ok ? result.value : {}, { requestId: ctx.requestId });
  }

  return fail('VALIDATION_ERROR', '`action` must be status, reopen or invoice; a valid status is required for status.', {
    param: 'action',
    requestId: ctx.requestId,
  });
}
