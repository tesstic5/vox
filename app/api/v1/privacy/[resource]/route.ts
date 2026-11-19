import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requirePermission } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import { find } from '@/lib/server/db';
import { enqueueDomainJob } from '@/lib/server/domain-jobs';
import {
  communicationDataPoliciesFor,
  createDeletionRequest,
  createLegalHold,
  deletionRequestsFor,
  externalAttestationsFor,
  legalHoldsFor,
  processingActivitiesFor,
  processorsFor,
  recordExternalAttestation,
  recordRecoveryEvidence,
  recoveryEvidenceFor,
  releaseLegalHold,
  retentionPoliciesFor,
  retentionReviewManifestsFor,
  saveCommunicationDataPolicy,
  saveProcessingActivity,
  saveProcessorRecord,
  saveRetentionPolicy,
  transitionDeletionRequest,
  type CommunicationDataPolicyDoc,
  type DeletionRequestDoc,
  type ExternalAttestationDoc,
  type ExternalAttestationType,
  type ProcessingActivityDoc,
  type ProcessorRecordDoc,
  type RetentionPolicyDoc,
} from '@/lib/server/privacy-governance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESOURCES = ['processing-activities', 'processors', 'retention-policies', 'retention-previews', 'communication-policies', 'legal-holds', 'deletion-requests', 'external-reviews', 'recovery-evidence'] as const;
type Resource = (typeof RESOURCES)[number];

function asResource(value: string): Resource | undefined {
  return (RESOURCES as readonly string[]).includes(value) ? value as Resource : undefined;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  const { resource: raw } = await params;
  const resource = asResource(raw);
  if (!resource) return fail('NOT_FOUND', `Unknown privacy resource. Supported: ${RESOURCES.join(', ')}.`);
  const ctx = await requireAuth(req, { scopes: ['privacy:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requirePermission(ctx, 'privacy.read');
  if (denied) return denied;
  const data = resource === 'processing-activities' ? processingActivitiesFor(ctx.orgId)
    : resource === 'processors' ? processorsFor(ctx.orgId)
      : resource === 'retention-policies' ? retentionPoliciesFor(ctx.orgId)
        : resource === 'retention-previews' ? retentionReviewManifestsFor(ctx.orgId)
          : resource === 'communication-policies' ? communicationDataPoliciesFor(ctx.orgId)
          : resource === 'legal-holds' ? legalHoldsFor(ctx.orgId)
          : resource === 'deletion-requests' ? deletionRequestsFor(ctx.orgId)
            : resource === 'external-reviews' ? externalAttestationsFor(ctx.orgId)
              : recoveryEvidenceFor(ctx.orgId);
  return ok({ object: 'list', data, total: data.length }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  const { resource: raw } = await params;
  const resource = asResource(raw);
  if (!resource) return fail('NOT_FOUND', `Unknown privacy resource. Supported: ${RESOURCES.join(', ')}.`);
  const ctx = await requireAuth(req, { scopes: ['privacy:write'] });
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session' || !ctx.user) return fail('FORBIDDEN', 'Privacy governance changes require a signed-in person.', { requestId: ctx.requestId });
  const denied = requirePermission(ctx, resource === 'legal-holds' ? 'privacy.holds.manage' : 'privacy.manage');
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;
  const actor = ctx.user.email;

  try {
    let saved: unknown;
    switch (resource) {
      case 'processing-activities': {
        const existing = body.id ? find<ProcessingActivityDoc>('processingActivities', (row) => row.id === body.id && row.orgId === ctx.orgId) : undefined;
        if (body.id && !existing) return fail('NOT_FOUND', 'Processing activity not found.', { requestId: ctx.requestId });
        saved = saveProcessingActivity({
          orgId: ctx.orgId, existing, name: String(body.name ?? ''), purpose: String(body.purpose ?? ''),
          article6Basis: String(body.article6Basis ?? ''), article9Condition: body.article9Condition ? String(body.article9Condition) : undefined,
          dataSubjects: Array.isArray(body.dataSubjects) ? body.dataSubjects.map(String) : [],
          dataCategories: Array.isArray(body.dataCategories) ? body.dataCategories.map(String) : [],
          recipients: Array.isArray(body.recipients) ? body.recipients.map(String) : [],
          internationalTransfers: body.internationalTransfers === true,
          transferSafeguards: body.transferSafeguards ? String(body.transferSafeguards) : undefined,
          retentionPolicyIds: Array.isArray(body.retentionPolicyIds) ? body.retentionPolicyIds.map(String) : [],
          owner: String(body.owner ?? ''), status: body.status as ProcessingActivityDoc['status'] | undefined, actor,
        });
        break;
      }
      case 'processors': {
        const existing = body.id ? find<ProcessorRecordDoc>('processorRecords', (row) => row.id === body.id && row.orgId === ctx.orgId) : undefined;
        if (body.id && !existing) return fail('NOT_FOUND', 'Processor record not found.', { requestId: ctx.requestId });
        saved = saveProcessorRecord({
          orgId: ctx.orgId, existing, name: String(body.name ?? ''), service: String(body.service ?? ''), purpose: String(body.purpose ?? ''),
          role: String(body.role ?? 'unknown') as ProcessorRecordDoc['role'],
          hostingRegions: Array.isArray(body.hostingRegions) ? body.hostingRegions.map(String) : [],
          receivesHealthData: body.receivesHealthData === true,
          dpaStatus: String(body.dpaStatus ?? 'not_reviewed') as ProcessorRecordDoc['dpaStatus'],
          dpaReference: body.dpaReference ? String(body.dpaReference) : undefined,
          transferMechanism: body.transferMechanism ? String(body.transferMechanism) : undefined,
          subprocessorListReviewedAt: body.subprocessorListReviewedAt ? String(body.subprocessorListReviewedAt) : undefined,
          active: body.active !== false, owner: String(body.owner ?? ''),
        });
        break;
      }
      case 'retention-policies': {
        const existing = body.id ? find<RetentionPolicyDoc>('retentionPolicies', (row) => row.id === body.id && row.orgId === ctx.orgId) : undefined;
        if (body.id && !existing) return fail('NOT_FOUND', 'Retention policy not found.', { requestId: ctx.requestId });
        saved = saveRetentionPolicy({
          orgId: ctx.orgId, existing, name: String(body.name ?? ''), recordClass: String(body.recordClass ?? ''),
          trigger: String(body.trigger ?? 'created_at') as RetentionPolicyDoc['trigger'], durationDays: Number(body.durationDays),
          disposition: String(body.disposition ?? 'review') as RetentionPolicyDoc['disposition'], rationale: String(body.rationale ?? ''),
          status: body.status as RetentionPolicyDoc['status'] | undefined, actor,
          activationConfirmation: body.activationConfirmation ? String(body.activationConfirmation) : undefined,
        });
        break;
      }
      case 'retention-previews': {
        saved = enqueueDomainJob({
          orgId: ctx.orgId,
          type: 'retention.preview',
          payload: { actor, asOf: body.asOf ? String(body.asOf) : undefined, limit: body.limit === undefined ? undefined : Number(body.limit) },
          dedupeKey: `retention-preview:${String(body.asOf ?? new Date().toISOString().slice(0, 10))}`,
          maxAttempts: 5,
        });
        break;
      }
      case 'communication-policies': {
        const existing = body.id ? find<CommunicationDataPolicyDoc>('communicationDataPolicies', (row) => row.id === body.id && row.orgId === ctx.orgId) : undefined;
        if (body.id && !existing) return fail('NOT_FOUND', 'Communication data policy not found.', { requestId: ctx.requestId });
        saved = saveCommunicationDataPolicy({
          orgId: ctx.orgId,
          existing,
          channel: String(body.channel ?? '') as CommunicationDataPolicyDoc['channel'],
          recordingPurpose: String(body.recordingPurpose ?? ''),
          transcriptPurpose: String(body.transcriptPurpose ?? ''),
          noticeVersion: String(body.noticeVersion ?? ''),
          contentRetentionDays: Number(body.contentRetentionDays),
          metadataRetentionDays: Number(body.metadataRetentionDays),
          allowedRoles: Array.isArray(body.allowedRoles) ? body.allowedRoles.map(String) : [],
          assistantExposure: String(body.assistantExposure ?? 'minimum_context') as CommunicationDataPolicyDoc['assistantExposure'],
          status: String(body.status ?? 'draft') as CommunicationDataPolicyDoc['status'],
          actor,
        });
        break;
      }
      case 'legal-holds': {
        if (body.action === 'release') {
          saved = releaseLegalHold({ orgId: ctx.orgId, id: String(body.id ?? ''), actor, reason: String(body.reason ?? '') });
        } else {
          saved = createLegalHold({
            orgId: ctx.orgId, scopeType: String(body.scopeType ?? '') as 'workspace' | 'patient' | 'resource' | 'record_class',
            scopeId: String(body.scopeId ?? ''), recordClass: body.recordClass ? String(body.recordClass) : undefined,
            reason: String(body.reason ?? ''), actor,
          });
        }
        break;
      }
      case 'deletion-requests': {
        if (body.action === 'transition') {
          saved = transitionDeletionRequest({
            orgId: ctx.orgId, id: String(body.id ?? ''), to: String(body.to ?? '') as DeletionRequestDoc['status'], actor,
            note: body.note ? String(body.note) : undefined, assignedTo: body.assignedTo ? String(body.assignedTo) : undefined,
            legalBasisDecision: body.legalBasisDecision ? String(body.legalBasisDecision) : undefined,
          });
        } else {
          saved = createDeletionRequest({
            orgId: ctx.orgId, patientId: body.patientId ? String(body.patientId) : undefined,
            requesterType: String(body.requesterType ?? 'other') as DeletionRequestDoc['requesterType'],
            requesterReference: String(body.requesterReference ?? ''), scope: String(body.scope ?? ''),
            dueAt: body.dueAt ? String(body.dueAt) : undefined, actor,
          });
        }
        break;
      }
      case 'external-reviews':
        saved = recordExternalAttestation({
          orgId: ctx.orgId, type: String(body.type ?? '') as ExternalAttestationType,
          reviewerName: String(body.reviewerName ?? ''), reviewerOrganisation: String(body.reviewerOrganisation ?? ''),
          independent: body.independent === true, scope: String(body.scope ?? ''),
          outcome: String(body.outcome ?? 'not_approved') as ExternalAttestationDoc['outcome'],
          reportReference: String(body.reportReference ?? ''), reportSha256: body.reportSha256 ? String(body.reportSha256) : undefined,
          reviewedAt: String(body.reviewedAt ?? ''), expiresAt: String(body.expiresAt ?? ''),
          actionsOpen: Number(body.actionsOpen ?? 0), actor,
        });
        break;
      case 'recovery-evidence':
        saved = recordRecoveryEvidence({
          orgId: ctx.orgId, backupReference: String(body.backupReference ?? ''), restoreTestedAt: String(body.restoreTestedAt ?? ''),
          testedBy: String(body.testedBy ?? ''), recoveryPointMinutes: body.recoveryPointMinutes === undefined ? undefined : Number(body.recoveryPointMinutes),
          recoveryTimeMinutes: body.recoveryTimeMinutes === undefined ? undefined : Number(body.recoveryTimeMinutes),
          outcome: String(body.outcome ?? 'failed') as 'passed' | 'failed', evidenceReference: String(body.evidenceReference ?? ''),
        });
        break;
    }
    audit({ orgId: ctx.orgId, actor, action: `privacy.${resource}.saved`, target: String((saved as { id?: string })?.id ?? resource) });
    return ok(saved, { requestId: ctx.requestId, status: body.id ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : `Could not save ${resource}.`;
    const code = message.includes('not found') ? 'NOT_FOUND' : message.includes('revision') || message.includes('changed') ? 'CONFLICT' : 'VALIDATION_ERROR';
    return fail(code, message, { requestId: ctx.requestId });
  }
}
