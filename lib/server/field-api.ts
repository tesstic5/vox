import { NextResponse } from 'next/server';
import { fail, type ApiContext } from './api';
import { businessProfileFor } from './business-profile';
import { jobById, visitById, visitsFor, type FieldResult } from './field-service';
import { providersFor } from './practice';

export function fieldActor(ctx: ApiContext) {
  return {
    id: ctx.auth === 'key' ? `key:${ctx.key?.id ?? ctx.userId}` : ctx.userId,
    label: ctx.auth === 'key' ? `API key ${ctx.key?.name ?? ctx.key?.id ?? ''}`.trim() : ctx.user?.email ?? ctx.userId,
  };
}

export function fieldFailure<T>(result: FieldResult<T>, requestId: string): NextResponse | null {
  if (result.ok) return null;
  return fail(result.code, result.error, { detail: result.detail, requestId });
}

export function fieldFinanceRole(ctx: ApiContext): NextResponse | null {
  if (ctx.auth === 'session' && !['owner', 'admin', 'developer'].includes(ctx.user?.role ?? '')) {
    return fail('FORBIDDEN', 'Creating estimates, changing prices and drafting job invoices needs an owner or admin.', {
      requestId: ctx.requestId,
    });
  }
  return null;
}

export function fieldModuleCreateDenied(ctx: ApiContext): NextResponse | null {
  if (businessProfileFor(ctx.orgId).modules.includes('field_service')) return null;
  return fail('FORBIDDEN', 'Enable the Field service module in Business profile before creating new field-service work.', {
    requestId: ctx.requestId,
  });
}

/** Coordinators can create and assign work; technicians act only on assigned work. */
export function fieldCoordinationRole(ctx: ApiContext): NextResponse | null {
  if (ctx.auth !== 'session' || ctx.user?.role !== 'practitioner') return null;
  return fail('FORBIDDEN', 'A technician can update assigned work but cannot create or assign field-service records.', {
    requestId: ctx.requestId,
  });
}

export function technicianProviderIds(ctx: ApiContext): Set<string> | null {
  if (ctx.auth !== 'session' || ctx.user?.role !== 'practitioner') return null;
  return new Set(
    providersFor(ctx.orgId, { includeInactive: true })
      .filter((provider) => provider.userId === ctx.userId)
      .map((provider) => provider.id)
  );
}

export function technicianJobIds(ctx: ApiContext): Set<string> | null {
  const providerIds = technicianProviderIds(ctx);
  if (providerIds === null) return null;
  return new Set(visitsFor(ctx.orgId).filter((visit) => visit.providerId && providerIds.has(visit.providerId)).map((visit) => visit.jobId));
}

export function practitionerJobDenied(ctx: ApiContext, jobId: string): NextResponse | null {
  const jobIds = technicianJobIds(ctx);
  if (jobIds === null || jobIds.has(jobId)) return null;
  return fail('FORBIDDEN', 'Technicians can access only jobs with a visit assigned to their linked technician record.', {
    requestId: ctx.requestId,
  });
}

/** A practitioner can update only a visit assigned to their linked provider record. */
export function practitionerVisitDenied(ctx: ApiContext, providerUserId?: string | null): NextResponse | null {
  if (ctx.auth !== 'session' || ctx.user?.role !== 'practitioner') return null;
  if (providerUserId && providerUserId === ctx.userId) return null;
  return fail('FORBIDDEN', 'Technicians can access only visits assigned to their linked technician record.', {
    requestId: ctx.requestId,
  });
}

export function practitionerVisitByIdDenied(ctx: ApiContext, visitId: string): NextResponse | null {
  const visit = visitById(ctx.orgId, visitId);
  if (!visit) return null;
  const provider = visit.providerId
    ? providersFor(ctx.orgId, { includeInactive: true }).find((row) => row.id === visit.providerId)
    : undefined;
  return practitionerVisitDenied(ctx, provider?.userId);
}

export function practitionerEstimateAllowed(ctx: ApiContext, estimateId: string): boolean {
  const jobIds = technicianJobIds(ctx);
  if (jobIds === null) return true;
  return [...jobIds].some((jobId) => jobById(ctx.orgId, jobId)?.estimateId === estimateId);
}
