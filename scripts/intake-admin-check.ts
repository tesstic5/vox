import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { commitBatch, get, insert, list, nowIso, type Doc } from '../lib/server/db';
import { createClient, clientById, updateClientStructuredAddress } from '../lib/server/clients';
import {
  clientRelationshipsFor,
  contactById,
  createClientRelationship,
  createContact,
  createCustomFieldDefinition,
  customFieldValueForTarget,
  setCustomFieldValue,
  updateClientRelationship,
  updateContact,
  updateContactStructuredAddress,
  updateCustomFieldDefinition,
  type CustomFieldDefinitionDoc,
} from '../lib/server/intake-admin';
import {
  createFormAssignment,
  createFormTemplate,
  reviewUpdateSuggestion,
  savePublicForm,
  setFormTemplateState,
  updateSuggestionById,
  updateSuggestionsFor,
} from '../lib/server/forms';
import { validateFormAnswers, validateFormSchema } from '../lib/forms-schema';
import { dataMigrationStates, runPhase1DataMigrations } from '../lib/server/data-migrations';
import { addWaitEntry, matchWaitList } from '../lib/server/diary';
import type { BookingDoc } from '../lib/server/bookings';
import { pgQuery } from '../lib/server/postgres';
import { createReferral, updateReferralStructuredAddress } from '../lib/server/referrals';

function throws(work: () => unknown, pattern: RegExp, label: string, count: () => void) {
  assert.throws(work, pattern, label);
  count();
}

async function main() {
  const engine = process.env.VOXERA_STORE;
  assert.ok(engine === 'sqlite' || engine === 'postgres', 'run this check with VOXERA_STORE=sqlite or postgres');
  assert.ok(process.env.VOXERA_DATA_DIR, 'run this check with an isolated VOXERA_DATA_DIR');
  let checks = 0;
  const passed = () => { checks += 1; };
  const check = (condition: unknown, label: string) => { assert.ok(condition, label); passed(); };

  const orgA = 'org_intake_admin_a';
  const orgB = 'org_intake_admin_b';
  const actor = 'intake-check@voxera.test';
  insert<Doc>('orgs', { id: orgA, name: 'Synthetic Intake A', email: 'a@example.test', createdAt: nowIso() });
  insert<Doc>('orgs', { id: orgB, name: 'Synthetic Intake B', email: 'b@example.test', createdAt: nowIso() });

  const legacyOrg = 'org_intake_legacy_address';
  const legacyAt = nowIso();
  insert<Doc>('orgs', { id: legacyOrg, name: 'Synthetic legacy address', createdAt: legacyAt });
  insert<Doc>('clients', {
    id: 'cli_legacy_address', orgId: legacyOrg, name: 'Legacy Patient', number: '+447700919991',
    address: '12 Old Text Road\nLegacytown\nLE1 2GA', tags: [], alerts: [], consents: {}, createdAt: legacyAt, updatedAt: legacyAt,
  });
  insert<Doc>('contacts', {
    id: 'con_legacy_address', orgId: legacyOrg, kind: 'person', name: 'Legacy Contact', address: 'Contact House, Oldtown',
    referrer: false, payer: false, active: true, createdBy: actor, updatedBy: actor, createdAt: legacyAt, updatedAt: legacyAt,
  });
  insert<Doc>('referrals', {
    id: 'ref_legacy_address', orgId: legacyOrg, source: 'manual', status: 'received', priority: 'routine',
    patient: { name: 'Legacy Referral Patient', address: 'Referral Cottage, Referralville' }, reason: 'Synthetic migration check',
    documentIds: [], receivedAt: legacyAt, createdAt: legacyAt,
  });
  runPhase1DataMigrations(legacyOrg);
  const migratedLegacyClient = get<Doc & { address?: string; structuredAddress?: { legacyText?: string; reviewStatus?: string } }>('clients', 'cli_legacy_address');
  const migratedLegacyContact = get<Doc & { address?: string; structuredAddress?: { legacyText?: string; reviewStatus?: string } }>('contacts', 'con_legacy_address');
  const migratedLegacyReferral = get<Doc & { patient?: { address?: string; structuredAddress?: { legacyText?: string; reviewStatus?: string } } }>('referrals', 'ref_legacy_address');
  check(migratedLegacyClient?.address === '12 Old Text Road\nLegacytown\nLE1 2GA' && migratedLegacyClient.structuredAddress?.legacyText === migratedLegacyClient.address && migratedLegacyClient.structuredAddress.reviewStatus === 'needs_review', 'client address migration should copy legacy text without parsing or discarding it');
  check(migratedLegacyContact?.address === 'Contact House, Oldtown' && migratedLegacyContact.structuredAddress?.legacyText === migratedLegacyContact.address && migratedLegacyContact.structuredAddress.reviewStatus === 'needs_review', 'contact address migration should preserve the source in an explicit review state');
  check(migratedLegacyReferral?.patient?.address === 'Referral Cottage, Referralville' && migratedLegacyReferral.patient.structuredAddress?.legacyText === migratedLegacyReferral.patient.address && migratedLegacyReferral.patient.structuredAddress.reviewStatus === 'needs_review', 'referral address migration should preserve nested legacy patient text without inference');

  runPhase1DataMigrations(orgA);
  check(dataMigrationStates(orgA).every((row) => row.status === 'completed'), 'all checksummed data migrations, including intake administration, should complete');
  check(dataMigrationStates(orgA).some((row) => row.migrationId === 'phase3.intake_administration_record_versions'), 'intake administration data migration should be registered');
  check(dataMigrationStates(orgA).some((row) => row.migrationId === 'phase3.structured_addresses'), 'copy-only structured-address migration should be registered');

  const patientA = createClient(orgA, { name: 'Synthetic Patient A', number: '+447700910001', email: 'patient-a@example.test', dateOfBirth: '1990-01-02', address: '1 Legacy Patient Street, Oldtown' }, actor, { source: 'intake-admin-check' });
  const patientB = createClient(orgB, { name: 'Synthetic Patient B', number: '+447700910002', email: 'patient-b@example.test', dateOfBirth: '1991-02-03' }, actor, { source: 'intake-admin-check' });

  const contact = createContact({ orgId: orgA, kind: 'person', name: 'Synthetic Guardian', email: 'GUARDIAN@example.test', phone: '+44 7700 910003', address: '2 Legacy Contact Street, Oldtown', referrer: false, payer: true, actor });
  check(contact.email === 'guardian@example.test' && contact.phone === '+447700910003' && contact.revision === 1, 'contact details should be normalised and revisioned');
  check(contactById(orgB, contact.id) === undefined, 'a contact must not cross tenant boundaries');
  throws(() => createContact({ orgId: orgA, kind: 'invalid' as never, name: 'Invalid Kind', actor }), /kind is invalid/i, 'runtime contact kind validation should reject forged values', passed);
  throws(() => createContact({ orgId: orgA, name: 'Bad Email', email: 'not-an-email', actor }), /email is invalid/i, 'invalid associated-contact email should be rejected', passed);
  throws(() => updateContact({ orgId: orgA, id: contact.id, expectedRevision: contact.revision - 1, actor, patch: { name: 'Stale' } }), /changed after/i, 'stale contact updates should fail', passed);
  const reviewedContact = updateContactStructuredAddress({
    orgId: orgA, id: contact.id, expectedRevision: contact.revision, actor,
    address: { line1: '2 Contact Street', city: 'Leeds', county: 'West Yorkshire', postcode: 'LS1 1AA', countryCode: 'GB' },
  });
  check(reviewedContact.address === '2 Contact Street, Leeds, West Yorkshire, LS1 1AA, GB' && reviewedContact.structuredAddress?.legacyText === '2 Legacy Contact Street, Oldtown' && reviewedContact.structuredAddress.reviewStatus === 'reviewed', 'contact address review should publish components while retaining the original text');
  throws(() => updateContactStructuredAddress({ orgId: orgA, id: contact.id, expectedRevision: contact.revision, actor, address: { line1: 'Stale', city: 'Leeds' } }), /changed after/i, 'stale contact address review should fail', passed);
  const reviewedPatient = updateClientStructuredAddress({
    orgId: orgA, id: patientA.id, expectedRevision: Number(patientA.revision), actor,
    address: { line1: '1 Patient Street', city: 'York', postcode: 'YO1 1AA', countryCode: 'GB' },
  });
  check(reviewedPatient.structuredAddress?.legacyText === '1 Legacy Patient Street, Oldtown' && reviewedPatient.structuredAddress.reviewStatus === 'reviewed' && reviewedPatient.address?.includes('York'), 'patient address review should be revision checked and preserve legacy evidence');

  const relationship = createClientRelationship({
    orgId: orgA, clientId: patientA.id, contactId: contact.id, relationshipType: 'guardian',
    guardian: true, proxy: true, billing: true, verified: true, effectiveFrom: '2026-09-20', actor,
  });
  check(relationship.verified && relationship.verifiedBy === actor && relationship.revision === 1, 'relationship verification should retain actor evidence');
  check(clientRelationshipsFor(orgA, patientA.id).length === 1, 'active patient relationship should be listed for its tenant');
  throws(() => createClientRelationship({ orgId: orgA, clientId: patientA.id, contactId: contact.id, relationshipType: 'guardian', actor }), /already exists/i, 'duplicate active relationship should be rejected by the domain', passed);
  throws(() => createClientRelationship({ orgId: orgB, clientId: patientB.id, contactId: contact.id, relationshipType: 'guardian', actor }), /contact not found/i, 'cross-tenant relationship targets should be rejected', passed);
  throws(() => createClientRelationship({ orgId: orgA, clientId: patientA.id, contactId: contact.id, relationshipType: 'other', effectiveFrom: '2026-02-30', actor }), /calendar date/i, 'rolled-over calendar dates should be rejected', passed);
  throws(() => updateClientRelationship({ orgId: orgA, clientId: patientA.id, id: relationship.id, expectedRevision: relationship.revision - 1, actor, patch: { verified: false } }), /changed after/i, 'stale relationship updates should fail', passed);

  const duplicateRelationship: Doc = { ...relationship, id: 'rel_forced_duplicate', revision: 0, createdAt: nowIso() };
  throws(() => commitBatch({ upserts: [{ collection: 'clientRelationships', doc: duplicateRelationship, expectedRevision: null, expectedOrgId: orgA }] }), /constraint|unique/i, 'database uniqueness should close the duplicate-relationship race', passed);

  const definition = createCustomFieldDefinition({
    orgId: orgA, targetType: 'client', key: 'mobility_level', label: 'Mobility level', valueType: 'single_choice',
    options: [{ value: 'basic', label: 'Basic' }, { value: 'advanced', label: 'Advanced' }, { value: 'independent', label: 'Independent' }],
    sensitivity: 'sensitive', actor,
  });
  check(definition.key === 'mobility_level' && definition.revision === 1, 'custom-field definitions should use stable keys and revisions');
  throws(() => createCustomFieldDefinition({ ...definition, orgId: orgA, actor } as never), /already exists/i, 'duplicate custom-field key should be rejected', passed);
  throws(() => createCustomFieldDefinition({ orgId: orgA, targetType: 'client', key: 'bad_sensitivity', label: 'Bad sensitivity', valueType: 'text', sensitivity: 'secret' as never, actor }), /sensitivity is invalid/i, 'forged custom-field sensitivity should be rejected at runtime', passed);
  throws(() => updateCustomFieldDefinition({ orgId: orgA, id: definition.id, expectedRevision: definition.revision, actor, patch: { order: Number.NaN } }), /order must be a number/i, 'non-finite custom-field order should be rejected', passed);
  throws(() => setCustomFieldValue({ orgId: orgA, definitionId: definition.id, targetType: 'client', targetId: patientB.id, value: 'basic', actor }), /patient not found/i, 'custom-field values must not cross tenant target boundaries', passed);
  throws(() => setCustomFieldValue({ orgId: orgA, definitionId: definition.id, targetType: 'client', targetId: patientA.id, value: 'invented', actor }), /invalid choice/i, 'typed custom fields should reject values outside their catalogue', passed);

  const contactDefinition = createCustomFieldDefinition({
    orgId: orgA, targetType: 'contact', key: 'preferred_channel', label: 'Preferred channel', valueType: 'single_choice',
    options: [{ value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }], actor,
  });
  const contactValue = setCustomFieldValue({
    orgId: orgA, definitionId: contactDefinition.id, targetType: 'contact', targetId: contact.id,
    value: 'email', actor, expectedRevision: null,
  });
  check(contactValue.value === 'email' && contactValue.source === 'staff' && contactValue.verificationStatus === 'verified', 'associated-contact custom fields should retain typed verified staff values');
  throws(() => setCustomFieldValue({ orgId: orgA, definitionId: contactDefinition.id, targetType: 'contact', targetId: patientA.id, value: 'email', actor, expectedRevision: null }), /contact not found/i, 'contact fields should reject a patient target', passed);

  const referral = createReferral({
    orgId: orgA, actor, patient: { name: 'Synthetic Referral Patient', address: '3 Legacy Referral Lane, Oldtown' },
    reason: 'Synthetic intake administration referral', priority: 'routine',
  }).referral;
  const referralDefinition = createCustomFieldDefinition({
    orgId: orgA, targetType: 'referral', key: 'source_category', label: 'Source category', valueType: 'text', actor,
  });
  const referralValue = setCustomFieldValue({
    orgId: orgA, definitionId: referralDefinition.id, targetType: 'referral', targetId: referral.id,
    value: 'Community', actor, expectedRevision: null,
  });
  check(referralValue.value === 'Community' && customFieldValueForTarget(orgA, referralDefinition.id, 'referral', referral.id)?.id === referralValue.id, 'referral custom fields should use the generic typed-value service');
  const reviewedReferral = updateReferralStructuredAddress({
    orgId: orgA, id: referral.id, expectedRevision: referral.revision, actor,
    address: { line1: '3 Referral Lane', city: 'Sheffield', postcode: 'S1 1AA', countryCode: 'GB' },
  });
  check(reviewedReferral.patient.structuredAddress?.legacyText === '3 Legacy Referral Lane, Oldtown' && reviewedReferral.patient.structuredAddress.reviewStatus === 'reviewed' && reviewedReferral.patient.address?.includes('Sheffield'), 'referral address review should preserve source text and publish structured components');
  throws(() => updateReferralStructuredAddress({ orgId: orgA, id: referral.id, expectedRevision: referral.revision, actor, address: { line1: 'Stale', city: 'Sheffield' } }), /changed after/i, 'stale referral address review should fail', passed);

  const forcedDuplicateDefinition: Doc = { ...definition, id: 'cfd_forced_duplicate', revision: 0, createdAt: nowIso() };
  throws(() => commitBatch({ upserts: [{ collection: 'customFieldDefinitions', doc: forcedDuplicateDefinition, expectedRevision: null, expectedOrgId: orgA }] }), /constraint|unique/i, 'database uniqueness should close the custom-field-key race', passed);

  throws(() => validateFormSchema({ version: 1, title: 'Invalid target', fields: [{ id: 'field_one', key: 'field_one', label: 'Field', type: 'text', updateTarget: 'custom:BAD' }] }), /invalid update target/i, 'form schemas should validate custom update-target syntax', passed);
  const dateSchema = validateFormSchema({ version: 1, title: 'Dates', fields: [{ id: 'date_one', key: 'date_one', label: 'Date', type: 'date', required: true }] });
  throws(() => validateFormAnswers(dateSchema, { date_one: '2026-02-30' }), /valid date/i, 'form answers should reject rolled-over dates', passed);
  throws(() => createFormTemplate({ orgId: orgA, actor, name: 'Missing mapping', schema: { version: 1, title: 'Missing mapping', fields: [{ id: 'missing', key: 'missing', label: 'Missing', type: 'text', updateTarget: 'custom:not_configured' }] } }), /does not exist or is inactive/i, 'templates should reject unresolved custom-field mappings', passed);

  const createdTemplate = createFormTemplate({
    orgId: orgA, actor, name: 'Typed updates', category: 'intake',
    schema: { version: 1, title: 'Typed updates', fields: [{
      id: 'mobility', key: 'mobility', label: 'Mobility level', type: 'single_choice', required: true,
      options: definition.options, updateTarget: 'custom:mobility_level', sensitivity: 'clinical',
    }] },
  });
  const publishedTemplate = setFormTemplateState({ orgId: orgA, id: createdTemplate.template.id, state: 'published', actor, expectedRevision: createdTemplate.template.revision });
  const assignment = createFormAssignment({ orgId: orgA, templateId: publishedTemplate.id, clientId: patientA.id, actor });
  const submitted = savePublicForm({ token: assignment.token, answers: { mobility: 'advanced' }, submit: true, respondent: { relationship: 'self' } });
  check(submitted.response.status === 'submitted', 'mapped public form should submit successfully');
  check(customFieldValueForTarget(orgA, definition.id, 'client', patientA.id) === undefined, 'form submission must not silently mutate a custom field');
  const suggestion = updateSuggestionsFor(orgA, { status: 'pending', clientId: patientA.id }).find((row) => row.responseId === submitted.response.id);
  check(Boolean(suggestion && suggestion.customFieldDefinitionId === definition.id && suggestion.proposedTypedValue === 'advanced'), 'custom mapping should create a typed, reviewable suggestion');
  const accepted = reviewUpdateSuggestion({ orgId: orgA, id: suggestion!.id, accept: true, actor, expectedRevision: suggestion!.revision });
  const firstValue = customFieldValueForTarget(orgA, definition.id, 'client', patientA.id);
  check(Boolean(accepted.customFieldValue && firstValue?.value === 'advanced' && firstValue.source === 'form' && firstValue.verificationStatus === 'verified'), 'explicit acceptance should atomically apply a verified form-sourced custom value');
  check(clientById(orgA, patientA.id)?.name === 'Synthetic Patient A', 'accepting a custom suggestion must not mutate core patient demographics');

  const staleAssignment = createFormAssignment({ orgId: orgA, templateId: publishedTemplate.id, clientId: patientA.id, actor });
  const staleSubmission = savePublicForm({ token: staleAssignment.token, answers: { mobility: 'basic' }, submit: true });
  const staleSuggestion = updateSuggestionsFor(orgA, { status: 'pending', clientId: patientA.id }).find((row) => row.responseId === staleSubmission.response.id)!;
  const intervening = setCustomFieldValue({ orgId: orgA, definitionId: definition.id, targetType: 'client', targetId: patientA.id, value: 'independent', actor, expectedRevision: firstValue!.revision });
  throws(() => reviewUpdateSuggestion({ orgId: orgA, id: staleSuggestion.id, accept: true, actor, expectedRevision: staleSuggestion.revision }), /changed after/i, 'accepted suggestions must not overwrite an intervening staff change', passed);
  check(updateSuggestionById(orgA, staleSuggestion.id)?.status === 'pending' && customFieldValueForTarget(orgA, definition.id, 'client', patientA.id)?.value === intervening.value, 'a stale suggestion conflict should preserve both the pending decision and newer value');
  throws(() => setCustomFieldValue({ orgId: orgA, definitionId: definition.id, targetType: 'client', targetId: patientA.id, value: 'basic', actor }), /expected revision is required/i, 'existing custom-field values should require optimistic revisions', passed);

  const date = '2026-10-05';
  const locationA = 'loc_intake_a';
  const locationB = 'loc_intake_b';
  const waitA = addWaitEntry(orgA, { name: 'Site A Waiter', number: '+447700910011', from: date, to: date, locationId: locationA }, actor);
  const waitB = addWaitEntry(orgA, { name: 'Site B Waiter', number: '+447700910012', from: date, to: date, locationId: locationB }, actor);
  const matches = matchWaitList({ orgId: orgA, booking: { startsAt: `${date}T10:00:00.000Z`, locationId: locationA } as BookingDoc });
  check(matches.some((row) => row.id === waitA.id) && !matches.some((row) => row.id === waitB.id), 'freed slots should match only waiters at the same requested location');
  const unknownLocationMatches = matchWaitList({ orgId: orgA, booking: { startsAt: `${date}T10:00:00.000Z` } as BookingDoc });
  check(!unknownLocationMatches.some((row) => row.id === waitA.id || row.id === waitB.id), 'an unspecified slot location must not satisfy a site-specific wait entry');

  if (engine === 'sqlite') {
    const db = new Database(path.join(process.env.VOXERA_DATA_DIR!, 'voxera-db.sqlite'), { readonly: true });
    const indexes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ['docs_active_client_relationship', 'docs_custom_field_key', 'docs_custom_field_value_target', 'docs_update_suggestions']) {
      check(indexes.has(name), `schema migration should create ${name}`);
    }
    const migration = db.prepare("SELECT checksum FROM schema_migrations WHERE id = '20260920_008_intake_administration'").get() as { checksum?: string } | undefined;
    check(Boolean(migration?.checksum?.length === 64), 'intake administration schema migration should be checksummed and applied');
    db.close();
  } else {
    const indexes = new Set(pgQuery<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'voxera_docs'").map((row) => row.indexname));
    for (const name of ['voxera_docs_active_client_relationship', 'voxera_docs_custom_field_key', 'voxera_docs_custom_field_value_target', 'voxera_docs_update_suggestions']) {
      check(indexes.has(name), `schema migration should create ${name}`);
    }
    const migration = pgQuery<{ checksum: string }>("SELECT checksum FROM voxera_schema_migrations WHERE id = '20260920_008_intake_administration'")[0];
    check(Boolean(migration?.checksum?.length === 64), 'intake administration schema migration should be checksummed and applied');
  }

  const auditActions = new Set(list<Doc>('audit', (row) => row.orgId === orgA).map((row) => String(row.action)));
  for (const action of ['contact.created', 'contact.address_reviewed', 'client.address_reviewed', 'client.relationship_created', 'referral.address_reviewed', 'custom_field.created', 'custom_field.value_set', 'custom_field.form_suggestion_applied']) {
    check(auditActions.has(action), `audit evidence should include ${action}`);
  }

  console.log(`intake-admin-check: ${checks} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
