import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission, type ApiContext } from '@/lib/server/api';
import { clientById } from '@/lib/server/clients';
import { actorLabel, recordAccess } from '@/lib/server/access-log';
import {
  addPatientAlert,
  endPatientAlert,
  patientAlertsFor,
  redactPatientAlerts,
  type PatientAlertClassification,
  type PatientAlertSeverity,
} from '@/lib/server/patient-alerts';
import { shadowPermissionDecision } from '@/lib/server/permissions';
import { requireClinicalWriteMode } from '@/lib/server/clinical-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function keyHas(ctx: { auth: string; key?: { scopes: string[] } }, scope: string) {
  return ctx.auth !== 'key' || Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes(scope));
}

function mayReadClinical(ctx: ApiContext, patientId: string) {
  if (ctx.auth === 'key') return keyHas(ctx, 'clinical:read');
  return Boolean(ctx.user && shadowPermissionDecision(ctx.user, 'clinical.alerts.read', { area: 'clinical', patientId }).allowed);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No patient with id ${id}.`, { requestId: ctx.requestId });
  const body = await readJson<{
    label?: string;
    detail?: string;
    severity?: PatientAlertSeverity;
    classification?: PatientAlertClassification;
  }>(req);
  if (body instanceof NextResponse) return body;
  // Legacy callers did not send a classification. Defaulting those writes to
  // administrative preserves the existing desk workflow without silently
  // treating unknown content as health data; clinical callers must opt in.
  const classification = body.classification ?? 'administrative';
  if (!['administrative', 'clinical'].includes(classification)) return fail('VALIDATION_ERROR', '`classification` must be administrative or clinical.', { param: 'classification', requestId: ctx.requestId });
  const permission = classification === 'clinical' ? 'clinical.alerts.write' : 'clients.write';
  const denied = requirePermission(ctx, permission, { area: classification === 'clinical' ? 'clinical' : 'clients', patientId: id });
  if (denied) return denied;
  if (classification === 'clinical' && !keyHas(ctx, 'clinical:write')) return fail('FORBIDDEN', 'This API key does not include clinical:write.', { requestId: ctx.requestId });
  if (classification === 'clinical') {
    try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
    catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  }
  if (!String(body.label ?? '').trim()) return fail('VALIDATION_ERROR', '`label` is required.', { param: 'label', requestId: ctx.requestId });
  try {
    const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
    const alert = addPatientAlert({
      orgId: ctx.orgId,
      patientId: id,
      classification,
      label: String(body.label),
      detail: body.detail,
      severity: body.severity,
      actor,
      actorName,
    });
    const patient = clientById(ctx.orgId, id)!;
    const includeClinical = mayReadClinical(ctx, id);
    const alerts = redactPatientAlerts(patientAlertsFor(ctx.orgId, id, { includeClinical }), includeClinical);
    return ok({ ...patient, alerts, alert, classificationDefaulted: body.classification === undefined ? 'administrative' : undefined }, { requestId: ctx.requestId, status: 201 });
  } catch (error) {
    return fail('VALIDATION_ERROR', error instanceof Error ? error.message : 'Could not add the alert.', { requestId: ctx.requestId });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const alertId = new URL(req.url).searchParams.get('alertId') ?? '';
  if (!alertId) return fail('VALIDATION_ERROR', 'Pass `?alertId=`.', { param: 'alertId', requestId: ctx.requestId });
  const includeClinical = mayReadClinical(ctx, id);
  const alert = patientAlertsFor(ctx.orgId, id, { includeClinical: true, includeEnded: true }).find((row) => row.id === alertId);
  if (!alert) return fail('NOT_FOUND', `No alert with id ${alertId}.`, { requestId: ctx.requestId });
  if (alert.classification === 'clinical' && (!includeClinical || !keyHas(ctx, 'clinical:write'))) return fail('FORBIDDEN', 'Clinical alert access is restricted.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, alert.classification === 'clinical' ? 'clinical.alerts.write' : 'clients.write', {
    area: alert.classification === 'clinical' ? 'clinical' : 'clients', patientId: id,
  });
  if (denied) return denied;
  if (alert.classification === 'clinical') {
    try { requireClinicalWriteMode(ctx.orgId, req.headers.get('x-voxera-synthetic-data') === '1'); }
    catch (error) { return fail('FORBIDDEN', error instanceof Error ? error.message : 'Clinical writes are disabled.', { requestId: ctx.requestId }); }
  }
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  try {
    const ended = endPatientAlert({ orgId: ctx.orgId, patientId: id, alertId, actor, actorName });
    return ok(ended, { requestId: ctx.requestId });
  } catch (error) {
    return fail('NOT_FOUND', error instanceof Error ? error.message : 'Alert not found.', { requestId: ctx.requestId });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['clients:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'clients.read', { area: 'clients', patientId: id });
  if (denied) return denied;
  if (!clientById(ctx.orgId, id)) return fail('NOT_FOUND', `No patient with id ${id}.`, { requestId: ctx.requestId });
  const includeClinical = mayReadClinical(ctx, id);
  const alerts = patientAlertsFor(ctx.orgId, id, { includeClinical });
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  recordAccess({ orgId: ctx.orgId, resource: 'client', resourceId: id, action: 'view', actor, actorName, detail: includeClinical ? 'alerts including clinical' : 'administrative alerts only' });
  return ok({ id, alerts: redactPatientAlerts(alerts, includeClinical), clinicalRestricted: !includeClinical }, { requestId: ctx.requestId });
}
