#!/usr/bin/env npx tsx
import assert from 'node:assert/strict';
import { flushNow, insert, list, remove, update, type Doc } from '../lib/server/db';
import { createLocation, createProvider, setRota } from '../lib/server/practice';
import { createJob, createVisit, enquiriesFor, visitById } from '../lib/server/field-service';
import { runFieldTool } from '../lib/server/field-tools';

const orgId = 'org_FIELD_TOOLS_CHECK';
const actor = { id: 'check', label: 'field-tools-check' };
const collections = ['orgs', 'clients', 'fieldEnquiries', 'fieldEstimates', 'estimateTokens', 'fieldJobs', 'fieldVisits', 'locations', 'providers', 'services', 'rota', 'bookings', 'audit'];
let checks = 0;

function cleanup() {
  for (const collection of collections) {
    for (const row of list<Doc & { orgId?: string }>(collection, (doc) => doc.orgId === orgId || doc.id === orgId)) remove(collection, row.id);
  }
  flushNow();
}

function result(call: Awaited<ReturnType<typeof runFieldTool>>) {
  assert.ok(call);
  checks += 1;
  return JSON.parse(call.result) as Record<string, unknown>;
}

async function main() {
  cleanup();
  try {
    insert('orgs', {
      id: orgId,
      name: 'Field Tool Check',
      businessProfile: { version: 1, type: 'contractor', modules: ['customers', 'schedule', 'field_service', 'money', 'assistants'], updatedAt: new Date().toISOString() },
    } as Doc);
    const location = createLocation(orgId, { name: 'Main dispatch', timezone: 'UTC' }, actor.label);
    const provider = createProvider(orgId, { name: 'Assigned technician', locationIds: [location.id] }, actor.label);
    setRota(orgId, { providerId: provider.id, locationId: location.id, windows: Array.from({ length: 7 }, (_, weekday) => ({ weekday, start: '08:00', end: '18:00' })) }, actor.label);

    const ctx = { orgId, callId: 'call_FIELD_TOOL', callerNumber: '+15555550144', timezone: 'UTC' };
    const missing = result(await runFieldTool({ ctx, name: 'capture_field_enquiry', args: { name: 'Morgan Caller' } }));
    assert.equal(missing.captured, false);
    assert.equal(enquiriesFor(orgId).length, 0);
    checks += 2;

    const captured = result(await runFieldTool({
      ctx,
      name: 'capture_field_enquiry',
      args: {
        name: 'Morgan Caller',
        description: 'The kitchen tap is leaking under the sink',
        urgency: 'soon',
        addressLine1: '22 Test Avenue',
        city: 'Test City',
        region: 'TC',
        postalCode: '20002',
        country: 'US',
      },
    }));
    assert.equal(captured.captured, true);
    assert.equal(enquiriesFor(orgId).length, 1);
    checks += 2;

    const duplicate = result(await runFieldTool({
      ctx,
      name: 'capture_field_enquiry',
      args: { name: 'Morgan Caller', description: 'retry', addressLine1: '22 Test Avenue', city: 'Test City' },
    }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(enquiriesFor(orgId).length, 1);
    checks += 2;

    const enquiry = enquiriesFor(orgId)[0];
    const jobResult = createJob({ orgId, enquiryId: enquiry.id, actor });
    if (!jobResult.ok) throw new Error(jobResult.error);
    const visitResult = createVisit({ orgId, jobId: jobResult.value.id, durationMinutes: 45, travelBufferMinutes: 15, actor });
    if (!visitResult.ok) throw new Error(visitResult.error);
    checks += 2;

    const day = new Date(Date.now() + 5 * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    const scheduled = result(await runFieldTool({
      ctx,
      name: 'schedule_approved_visit',
      args: { jobReference: jobResult.value.reference, visitReference: visitResult.value.reference, date, time: '10:00' },
    }));
    assert.equal(scheduled.scheduled, true);
    assert.ok(visitById(orgId, visitResult.value.id)?.bookingId);
    checks += 2;

    const second = result(await runFieldTool({
      ctx,
      name: 'schedule_approved_visit',
      args: { jobReference: jobResult.value.reference, visitReference: visitResult.value.reference, date, time: '11:00' },
    }));
    assert.equal(second.alreadyScheduled, true);
    assert.equal(second.needsHuman, true);
    checks += 2;

    const wrongCaller = result(await runFieldTool({
      ctx: { ...ctx, callId: 'call_WRONG', callerNumber: '+15555550999' },
      name: 'schedule_approved_visit',
      args: { jobReference: jobResult.value.reference, visitReference: visitResult.value.reference, date, time: '11:00' },
    }));
    assert.equal(wrongCaller.reason, 'approved_job_not_found');
    checks += 1;

    const org = list<Doc>('orgs', (row) => row.id === orgId)[0];
    update('orgs', orgId, { businessProfile: { ...(org.businessProfile as object), modules: ['customers'] } } as never);
    const disabled = result(await runFieldTool({
      ctx: { ...ctx, callId: 'call_DISABLED' },
      name: 'capture_field_enquiry',
      args: { name: 'No Module', description: 'Needs repair', addressLine1: '1 Anywhere', city: 'Town' },
    }));
    assert.equal(disabled.reason, 'field_service_module_disabled');
    checks += 1;

    console.log(`field-tools-check: ${checks} checks passed`);
  } finally {
    cleanup();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
