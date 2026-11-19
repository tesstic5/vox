#!/usr/bin/env npx tsx
/** End-to-end domain probe for the contractor workflow. Uses a disposable tenant. */
import assert from 'node:assert/strict';
import { flushNow, insert, list, remove, update, type Doc } from '../lib/server/db';
import { createLocation, createProvider, createService, setRota } from '../lib/server/practice';
import {
  createEnquiry,
  createEstimate,
  createJob,
  createVisit,
  decideEstimate,
  estimateById,
  invoiceJob,
  jobById,
  publicEstimate,
  reviseSharedEstimate,
  scheduleVisit,
  setJobStatus,
  setVisitStatus,
  shareEstimate,
  visitsFor,
} from '../lib/server/field-service';

const orgId = 'org_FIELD_SERVICE_CHECK';
const actor = { id: 'user_FIELD_SERVICE_CHECK', label: 'field-service-check' };
const collections = [
  'orgs', 'users', 'clients', 'fieldEnquiries', 'fieldEstimates', 'estimateTokens', 'fieldJobs', 'fieldVisits',
  'locations', 'providers', 'services', 'rota', 'rotaChanges', 'bookings', 'invoices', 'payments', 'audit', 'notificationJobs',
];

function cleanup() {
  for (const collection of collections) {
    for (const row of list<Doc & { orgId?: string }>(collection, (doc) => doc.orgId === orgId || doc.id === orgId)) remove(collection, row.id);
  }
  flushNow();
}

let checks = 0;
function check(value: unknown, message: string) {
  assert.ok(value, message);
  checks += 1;
}
function succeeds<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(result.ok, true, result.ok ? 'expected a successful result' : result.error);
  checks += 1;
  return (result as { ok: true; value: T }).value;
}
function fails(result: { ok: true; value: unknown } | { ok: false; code: string }, code: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
  checks += 1;
}

cleanup();
try {
  insert('orgs', {
    id: orgId,
    name: 'Field Service Check',
    businessProfile: { version: 1, type: 'contractor', modules: ['calls', 'clients', 'field_service', 'diary', 'money'], updatedAt: new Date().toISOString() },
  } as Doc);

  const location = createLocation(orgId, { name: 'Dispatch base', timezone: 'UTC' }, actor.label);
  const service = createService(orgId, { name: 'Field visit', durationMinutes: 60, active: true }, actor.label);
  const provider = createProvider(orgId, { name: 'Test technician', locationIds: [location.id], serviceIds: [service.id] }, actor.label);
  setRota(orgId, {
    providerId: provider.id,
    locationId: location.id,
    windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: '08:00', end: '18:00' })),
    breaks: [{ start: '12:00', end: '12:30', label: 'Lunch' }],
  }, actor.label);

  fails(createEnquiry({ orgId, customer: { name: 'A', number: '' }, description: 'x', siteAddress: { line1: '', city: '' }, actor, source: 'manual' }), 'VALIDATION_ERROR');

  const enquiry = succeeds(createEnquiry({
    orgId,
    customer: { name: 'Taylor Customer', number: '+15555550101', email: 'taylor@example.test' },
    description: 'Replace a failed circulation pump',
    urgency: 'soon',
    siteAddress: { line1: '10 Test Street', city: 'Testville', region: 'TS', postalCode: '10001', country: 'US' },
    actor,
    source: 'manual',
  }));
  check(enquiry.reference.startsWith('ENQ-'), 'enquiry reference');
  check(!createJob({ orgId: 'org_other', enquiryId: enquiry.id, actor }).ok, 'cross-tenant enquiry cannot become a job');

  const estimate = succeeds(createEstimate({
    orgId,
    enquiryId: enquiry.id,
    lines: [
      { description: 'Replacement circulation pump', quantity: 1, unitAmountMinor: 32_500, taxRatePct: 10 },
      { description: 'Installation labour', quantity: 2, unitAmountMinor: 7_500, taxRatePct: 10 },
    ],
    currency: 'USD',
    validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    notes: 'Subject to safe access.',
    actor,
  }));
  assert.equal(estimate.totalMinor, 52_250);
  checks += 1;

  const shared = succeeds(shareEstimate({ orgId, id: estimate.id, actor, ttlDays: 3 }));
  check(!list<Doc & { tokenHash?: string; orgId: string }>('estimateTokens', (row) => row.orgId === orgId).some((row) => row.tokenHash === shared.token), 'raw acceptance token is not stored');
  const publicView = succeeds(publicEstimate(shared.token));
  assert.equal(publicView.estimate.reference, estimate.reference);
  checks += 1;

  const decision = succeeds(decideEstimate({ token: shared.token, decision: 'accepted', name: 'Taylor Customer', email: 'taylor@example.test' }));
  assert.equal(decision.decision, 'accepted');
  checks += 1;
  fails(decideEstimate({ token: shared.token, decision: 'accepted', name: 'Taylor Customer' }), 'CONFLICT');
  check(estimateById(orgId, estimate.id)?.status === 'accepted', 'estimate accepted');

  const job = succeeds(createJob({ orgId, estimateId: estimate.id, actor }));
  check(job.reference.startsWith('JOB-'), 'job reference');
  fails(createJob({ orgId, estimateId: estimate.id, actor }), 'CONFLICT');
  fails(invoiceJob({ orgId, id: job.id, actor }), 'CONFLICT');

  const visitOne = succeeds(createVisit({ orgId, jobId: job.id, durationMinutes: 60, travelBufferMinutes: 15, instructions: 'Call on arrival', actor }));
  const visitTwo = succeeds(createVisit({ orgId, jobId: job.id, durationMinutes: 60, travelBufferMinutes: 0, actor }));

  const day = new Date(Date.now() + 3 * 86_400_000);
  day.setUTCHours(10, 0, 0, 0);
  const startsAt = day.toISOString();
  const scheduled = succeeds(scheduleVisit({ orgId, id: visitOne.id, startsAt, providerId: provider.id, locationId: location.id, serviceId: service.id, actor }));
  check(Boolean(scheduled.bookingId), 'visit owns a diary booking');
  fails(scheduleVisit({ orgId, id: visitTwo.id, startsAt, providerId: provider.id, locationId: location.id, serviceId: service.id, actor }), 'CONFLICT');
  fails(setVisitStatus({ orgId, id: visitOne.id, status: 'unassigned', actor }), 'CONFLICT');
  succeeds(setVisitStatus({ orgId, id: visitOne.id, status: 'en_route', actor }));
  succeeds(setVisitStatus({ orgId, id: visitOne.id, status: 'on_site', actor }));
  succeeds(setVisitStatus({ orgId, id: visitOne.id, status: 'completed', note: 'Pump replaced and tested', actor }));
  fails(setJobStatus({ orgId, id: job.id, status: 'completed', actor }), 'CONFLICT');
  succeeds(setVisitStatus({ orgId, id: visitTwo.id, status: 'cancelled', note: 'Not required', actor }));

  const liveJob = jobById(orgId, job.id);
  check(liveJob?.status === 'in_progress' || liveJob?.status === 'scheduled', 'visit state reconciles onto job');
  succeeds(setJobStatus({ orgId, id: job.id, status: 'completed', note: 'All work checked', actor }));
  const invoiceResult = succeeds(invoiceJob({ orgId, id: job.id, actor }));
  assert.equal(invoiceResult.invoice.lines.length, 2);
  assert.equal(invoiceResult.invoice.totalMinor, estimate.totalMinor);
  checks += 1;
  fails(invoiceJob({ orgId, id: job.id, actor }), 'CONFLICT');
  fails(setJobStatus({ orgId, id: job.id, status: 'scheduled', actor, reopen: true }), 'CONFLICT');

  // A revision invalidates the old public link and carries a clean draft version.
  const revisionEstimate = succeeds(createEstimate({
    orgId,
    clientId: enquiry.clientId,
    siteAddress: enquiry.siteAddress,
    description: 'Alternative repair',
    lines: [{ description: 'Repair labour', quantity: 1, unitAmountMinor: 10_000, taxRatePct: 0 }],
    currency: 'USD',
    actor,
  }));
  const revisionShare = succeeds(shareEstimate({ orgId, id: revisionEstimate.id, actor }));
  const revised = succeeds(reviseSharedEstimate({ orgId, id: revisionEstimate.id, actor }));
  assert.equal(revised.version, 2);
  assert.equal(revised.status, 'draft');
  checks += 1;
  fails(publicEstimate(revisionShare.token), 'CONFLICT');

  // Expired links are terminal even if the estimate's valid-until date is later.
  const expiringEstimate = succeeds(createEstimate({
    orgId,
    clientId: enquiry.clientId,
    siteAddress: enquiry.siteAddress,
    lines: [{ description: 'Diagnostic visit', quantity: 1, unitAmountMinor: 5_000, taxRatePct: 0 }],
    actor,
  }));
  const expiring = succeeds(shareEstimate({ orgId, id: expiringEstimate.id, actor }));
  const tokenRow = list<{ id: string; orgId: string; estimateId: string } & Doc>('estimateTokens', (row) => row.orgId === orgId && row.estimateId === expiringEstimate.id)[0];
  update('estimateTokens', tokenRow.id, { expiresAt: new Date(Date.now() - 1_000).toISOString() } as never);
  fails(publicEstimate(expiring.token), 'CONFLICT');

  check(visitsFor('org_other', { jobId: job.id }).length === 0, 'visit query is tenant scoped');
  console.log(`field-service-check: ${checks} checks passed`);
} finally {
  cleanup();
}
