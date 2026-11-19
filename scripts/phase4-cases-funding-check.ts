import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'voxera-p4-cases-'));
const dbPath = join(dir, 'voxera-db.sqlite');
process.env.VOXERA_DATA_DIR = dir;
process.env.VOXERA_SECRET = 'test-secret-for-cases-funding-check-32b';

let passed = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  passed++;
}

async function main() {
  const { list, insert } = await import('../lib/server/db');
  list('orgs'); // initializes base SQLite schema and runs migrations
  const { runSqliteSchemaMigrations } = await import('../lib/server/schema-migrations');
  const db = new Database(dbPath);

  // 1. Migration 014 applied
  runSqliteSchemaMigrations(db);
  const latest = db.prepare('SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1').get() as { id: string } | undefined;
  assert(latest?.id === '20260920_014_phase4_cases_funding', 'migration 014 applied');
  db.close();

  // 2. Domain: Payer, Coverage encryption/redaction, Case, Period, Rule, Funding
  const { createPayer, createCoverage, coverageView } = await import('../lib/server/coverage');
  const { createCase, updateCase } = await import('../lib/server/cases');
  const { createFundingPeriod, createServiceRule, commitBookingFunding, fundingPeriodsForCase } = await import('../lib/server/funding');
  const { createCarePlan, createCarePlanGoal, updateCarePlanGoal } = await import('../lib/server/care-plans');

  const orgId = 'org_test_p4';
  const patientId = 'cli_test_p4';
  insert('clients', { id: patientId, orgId, name: 'Test Patient', number: '+447700900123', createdAt: new Date().toISOString() });

  const payerRes = createPayer({
    orgId,
    name: 'AXA Health UK',
    type: 'insurer',
    actorId: 'staff_1',
  });
  assert(payerRes.ok, 'payer created');
  const payer = payerRes.value;
  assert(payer.id.startsWith('pay_'), 'payer id prefix');

  const covRes = createCoverage({
    orgId,
    patientId,
    payerId: payer.id,
    holderRelationship: 'self',
    sensitive: { membershipNumber: 'MEM-99887766', policyNumber: 'POL-11223344' },
    startsOn: '2026-09-01',
    endsOn: '2027-08-31',
    verificationStatus: 'verified',
    actorId: 'staff_1',
  });
  assert(covRes.ok, 'coverage created');
  const cov = covRes.value;
  const masked = coverageView(cov, false);
  assert(!JSON.stringify(masked).includes('MEM-99887766'), 'membershipNumber masked by default');
  assert(String(masked.membershipMasked ?? '').endsWith('7766'), 'membershipMasked shows last 4');
  const revealed = coverageView(cov, true);
  assert(revealed.sensitive?.membershipNumber === 'MEM-99887766', 'membershipNumber revealed when authorized');

  const caseRes = createCase({
    orgId,
    patientId,
    name: 'Knee Rehab',
    number: 'CASE-001',
    type: 'insurance',
    trackingMode: 'appointments',
    limitAppointments: 2,
    startsOn: '2026-09-01',
    endsOn: '2026-12-31',
    coverageId: cov.id,
    limitPolicy: 'block',
    enforcementMode: 'enforced',
    actorId: 'staff_1',
  });
  assert(caseRes.ok, `case created: ${caseRes.ok ? '' : caseRes.error}`);
  const c = caseRes.value;
  assert(c.status === 'draft', 'case starts as draft');

  const periodRes = createFundingPeriod({
    orgId,
    caseId: c.id,
    startsOn: '2026-09-01',
    endsOn: '2026-12-31',
    allowed: { appointments: 2, minutes: 120, budgetMinor: 20000 },
    rollover: { appointments: 0, minutes: 0, budgetMinor: 0 },
    actorId: 'staff_1',
  });
  assert(periodRes.ok, 'funding period created');
  assert(periodRes.value.revision === 1, 'period starts at revision 1');

  const ruleRes = createServiceRule({
    orgId,
    caseId: c.id,
    startsOn: '2026-09-01',
    unit: 'appointment',
    fundedPriceMinor: 8000,
    taxRateBps: 2000,
    requiresAuthorisation: false,
    noShowPolicy: 'consume',
    lateCancelPolicy: 'release',
    lateCancellationHours: 24,
    actorId: 'staff_1',
  });
  assert(ruleRes.ok, 'service rule created');

  const activeRes = updateCase({
    orgId,
    id: c.id,
    expectedRevision: c.revision,
    patch: { status: 'active' },
    actorId: 'staff_1',
  });
  assert(activeRes.ok && activeRes.value.status === 'active', 'case activated');

  // Commit booking 1 (8000 + 20% tax = 9600 minor)
  const alloc1 = commitBookingFunding({
    orgId,
    booking: {
      id: 'bkg_1',
      orgId,
      clientId: patientId,
      caseId: c.id,
      coverageId: cov.id,
      startsAt: '2026-09-25T10:00:00.000Z',
      durationMinutes: 45,
      status: 'confirmed',
      revision: 1,
    },
    expectedRevision: null,
    actorId: 'staff_1',
    reason: 'booking.create',
  });
  assert(alloc1.ok && alloc1.value.fundingAllocation?.budgetMinor === 9600, `deterministic tax arithmetic 8000 + 20% = 9600: ${JSON.stringify(alloc1)}`);
  assert(alloc1.value.fundingAllocation?.state === 'committed', 'allocation state is committed');

  // Settle booking 1 as completed -> used
  const settled = commitBookingFunding({
    orgId,
    booking: {
      ...alloc1.value,
      status: 'completed',
    },
    expectedRevision: alloc1.value.revision,
    actorId: 'staff_1',
    reason: 'booking.completed',
  });
  assert(settled.ok && settled.value.fundingAllocation?.state === 'used', `completed booking settles to used: ${JSON.stringify(settled)}`);

  // Commit booking 2
  const alloc2 = commitBookingFunding({
    orgId,
    booking: {
      id: 'bkg_2',
      orgId,
      clientId: patientId,
      caseId: c.id,
      coverageId: cov.id,
      startsAt: '2026-09-26T10:00:00.000Z',
      durationMinutes: 45,
      status: 'confirmed',
      revision: 1,
    },
    expectedRevision: null,
    actorId: 'staff_1',
    reason: 'booking.create',
  });
  assert(alloc2.ok, 'booking 2 committed');

  // Booking 3 should be blocked (limit 2 appointments)
  const alloc3 = commitBookingFunding({
    orgId,
    booking: {
      id: 'bkg_3',
      orgId,
      clientId: patientId,
      caseId: c.id,
      coverageId: cov.id,
      startsAt: '2026-09-27T10:00:00.000Z',
      durationMinutes: 45,
      status: 'confirmed',
      revision: 1,
    },
    expectedRevision: null,
    actorId: 'staff_1',
    reason: 'booking.create',
  });
  assert(!alloc3.ok, 'booking 3 blocked by enforced appointment limit');

  // Reverse booking 2 via cancellation
  const reversed = commitBookingFunding({
    orgId,
    booking: {
      ...alloc2.value,
      status: 'cancelled',
    },
    expectedRevision: alloc2.value.revision,
    actorId: 'staff_1',
    reason: 'booking.cancelled',
  });
  assert(reversed.ok, 'booking 2 cancelled/reversed');

  const periods = fundingPeriodsForCase(orgId, c.id);
  assert(periods[0]?.used.appointments === 1, '1 used appointment');
  assert(periods[0]?.committed.appointments === 0, '0 committed after reversal');

  // 3. Care plan optimistic concurrency
  const planRes = createCarePlan({
    orgId,
    patientId,
    caseId: c.id,
    title: 'Physio Rehab Plan',
    actorId: 'clinician_1',
  });
  assert(planRes.ok, 'care plan created');
  const goalRes = createCarePlanGoal({
    orgId,
    carePlanId: planRes.value.id,
    goal: 'Walk 1km pain-free',
    actions: ['Daily 10m walk'],
    actorId: 'clinician_1',
  });
  assert(goalRes.ok, 'care plan goal created');
  const updatedGoal = updateCarePlanGoal({
    orgId,
    id: goalRes.value.id,
    expectedRevision: goalRes.value.revision,
    patch: { status: 'active' },
    actorId: 'clinician_1',
  });
  assert(updatedGoal.ok && updatedGoal.value.revision === goalRes.value.revision + 1, 'goal revision incremented');

  const conflict = updateCarePlanGoal({
    orgId,
    id: goalRes.value.id,
    expectedRevision: goalRes.value.revision, // stale revision
    patch: { status: 'achieved' },
    actorId: 'clinician_1',
  });
  assert(!conflict.ok && conflict.code === 'CONFLICT', 'stale revision rejected (no last-write-wins)');

  console.log(`PASS: ${passed} assertions passed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
