import assert from 'node:assert/strict';
import path from 'node:path';
import { dbStats, flushNow, get, insert, list, newId, nowIso, remove, type Doc } from '../lib/server/db';
import { normalizeLegacyInferredCallClaims } from '../lib/server/calls';
import { normalizeLegacyRetentionClaims } from '../lib/server/retention-policy';
import { normalizeLegacyToolHeaders, toolHeaders } from '../lib/server/tools';
import { normalizeLegacyWebhookSecrets, webhookSecret } from '../lib/server/webhooks';

const configured = process.env.VOXERA_DATA_DIR;
assert(configured, 'VOXERA_DATA_DIR must point at a copied data directory');
const active = path.resolve(process.cwd(), 'data');
const target = path.resolve(configured);
assert.notEqual(target, active, 'refusing to run migration check against the working data directory');
assert.equal(process.env.VOXERA_MIGRATION_CHECK, '1', 'set VOXERA_MIGRATION_CHECK=1 to confirm this is an isolated copy');

const stamp = `migration_check_${Date.now()}`;
const orgId = `${stamp}_org`;
const ids = {
  assistant: `${stamp}_assistant`,
  callUnsupported: `${stamp}_call_unsupported`,
  callExplicit: `${stamp}_call_explicit`,
  usage: `${stamp}_usage`,
  numberUnsupported: `${stamp}_number_unsupported`,
  numberExplicit: `${stamp}_number_explicit`,
  clientUnsupported: `${stamp}_client_unsupported`,
  clientExplicit: `${stamp}_client_explicit`,
  noteUnsupported: `${stamp}_note_unsupported`,
  noteExplicit: `${stamp}_note_explicit`,
  tool: `${stamp}_tool`,
  webhook: `${stamp}_webhook`,
};

// Force both versioned migration paths on the copy, even if the working store
// has already recorded one of them. The fixtures make each policy observable.
remove('migrations', 'migration_call_claims_recheck_v3');
remove('migrations', 'migration_number_rental_claims_v2');
remove('migrations', 'migration_legacy_number_capabilities_v1');

insert<Doc>('assistants', { id: ids.assistant, orgId, name: 'Migration fixture', containment: 97, createdAt: nowIso() });
const callBase = {
  orgId,
  assistantId: ids.assistant,
  from: '+15550000001',
  to: '+15550000002',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationSeconds: 30,
  transcript: [{ role: 'user', text: 'hello', at: 1, seconds: 1 }],
  guardrails: [],
  analysis: {
    summary: 'Caller raised a request and the agent resolved it',
    successEvaluation: 'true',
    sentiment: 'positive',
    intent: 'support',
    structuredData: {},
    score: 100,
  },
  cost: { platform: 1, stt: 1, tts: 1, llm: 1, telephony: 1, total: 5 },
  createdAt: nowIso(),
};
insert<Doc>('calls', { id: ids.callUnsupported, ...callBase });
insert<Doc>('calls', {
  id: ids.callExplicit,
  ...callBase,
  costSource: 'provider_import',
  analysis: { ...callBase.analysis, evaluationSource: 'human' },
});
insert<Doc>('usageEvents', { id: ids.usage, orgId, cost: { total: 4 }, createdAt: nowIso() });
insert<Doc>('numbers', { id: ids.numberUnsupported, orgId, number: '+15550000003', monthlyCost: 12.5, createdAt: nowIso() });
insert<Doc>('numbers', {
  id: ids.numberExplicit,
  orgId,
  number: '+15550000004',
  monthlyCost: 9.25,
  monthlyCostSource: 'carrier_response',
  createdAt: nowIso(),
});
insert<Doc>('clients', {
  id: ids.clientUnsupported,
  orgId,
  archivedAt: '2025-01-01T00:00:00.000Z',
  retentionUntil: '2032-01-01T00:00:00.000Z',
  name: 'Preserved client',
  createdAt: nowIso(),
});
insert<Doc>('clients', {
  id: ids.clientExplicit,
  orgId,
  archivedAt: '2025-01-01T00:00:00.000Z',
  retentionUntil: '2032-01-01T00:00:00.000Z',
  retentionPolicySource: 'explicit',
  name: 'Policy client',
  createdAt: nowIso(),
});
insert<Doc>('notes', {
  id: ids.noteUnsupported,
  orgId,
  archivedAt: '2025-01-01T00:00:00.000Z',
  retentionUntil: '2032-01-01T00:00:00.000Z',
  body: 'Preserved note',
  createdAt: nowIso(),
});
insert<Doc>('notes', {
  id: ids.noteExplicit,
  orgId,
  archivedAt: '2025-01-01T00:00:00.000Z',
  retentionUntil: '2032-01-01T00:00:00.000Z',
  retentionPolicySource: 'environment',
  body: 'Policy note',
  createdAt: nowIso(),
});
insert<Doc>('tools', {
  id: ids.tool,
  orgId,
  name: 'migration_tool',
  headers: { authorization: 'Bearer migration-secret' },
  createdAt: nowIso(),
});
insert<Doc>('webhooks', {
  id: ids.webhook,
  orgId,
  url: 'https://example.test/hook',
  events: ['call.ended'],
  secret: 'migration-webhook-secret',
  active: true,
  createdAt: nowIso(),
});
flushNow();

const allowed = new Map<string, Set<string>>([
  ['calls', new Set(['cost', 'analysis', 'updatedAt'])],
  ['usageEvents', new Set(['cost', 'updatedAt'])],
  ['numbers', new Set(['monthlyCost', 'status', 'provider', 'legacyUnavailable', 'unavailableReason', 'updatedAt'])],
  ['assistants', new Set(['evaluatedCalls', 'containment', 'updatedAt'])],
  ['tools', new Set(['headers', 'headersSealed', 'headerNames', 'updatedAt'])],
  ['webhooks', new Set(['secret', 'secretSealed', 'updatedAt'])],
  ['clients', new Set(['retentionUntil', 'updatedAt'])],
  ['notes', new Set(['retentionUntil', 'updatedAt'])],
]);

function withoutAllowed(collection: string, doc: Doc) {
  const copy = structuredClone(doc);
  for (const field of allowed.get(collection) ?? []) delete copy[field];
  return copy;
}

const collections = Object.keys(dbStats());
const before = new Map<string, Map<string, Doc>>();
for (const collection of collections) {
  before.set(collection, new Map(list<Doc>(collection).map((doc) => [doc.id, structuredClone(doc)])));
}

const first = {
  claims: normalizeLegacyInferredCallClaims(),
  retention: normalizeLegacyRetentionClaims(),
  tools: normalizeLegacyToolHeaders(),
  webhooks: normalizeLegacyWebhookSecrets(),
};
flushNow();

for (const [collection, rows] of before) {
  const afterRows = new Map(list<Doc>(collection).map((doc) => [doc.id, doc]));
  for (const [id, doc] of rows) {
    const after = afterRows.get(id);
    assert(after, `${collection}/${id} was deleted`);
    assert.deepEqual(withoutAllowed(collection, after), withoutAllowed(collection, doc), `${collection}/${id} changed outside its allowed migration fields`);
  }
}

assert.equal((get<Doc>('calls', ids.callUnsupported)?.cost as { total?: number })?.total, 0);
assert.equal((get<Doc>('calls', ids.callUnsupported)?.analysis as { successEvaluation?: string })?.successEvaluation, 'not_evaluated');
assert.equal((get<Doc>('calls', ids.callExplicit)?.cost as { total?: number })?.total, 5);
assert.equal((get<Doc>('calls', ids.callExplicit)?.analysis as { successEvaluation?: string })?.successEvaluation, 'true');
assert.equal(get<Doc>('numbers', ids.numberUnsupported)?.monthlyCost, undefined);
assert.equal(get<Doc>('numbers', ids.numberUnsupported)?.status, 'unavailable');
assert.equal(get<Doc>('numbers', ids.numberUnsupported)?.legacyUnavailable, true);
assert.equal(get<Doc>('numbers', ids.numberExplicit)?.monthlyCost, 9.25);
assert.equal(get<Doc>('numbers', ids.numberExplicit)?.status, 'unavailable');
assert.equal(get<Doc>('clients', ids.clientUnsupported)?.retentionUntil, undefined);
assert.equal(get<Doc>('clients', ids.clientExplicit)?.retentionUntil, '2032-01-01T00:00:00.000Z');
assert.equal(get<Doc>('notes', ids.noteUnsupported)?.retentionUntil, undefined);
assert.equal(get<Doc>('notes', ids.noteExplicit)?.retentionUntil, '2032-01-01T00:00:00.000Z');
assert.deepEqual(toolHeaders(get<Doc>('tools', ids.tool) as never), { authorization: 'Bearer migration-secret' });
assert.equal(webhookSecret(get<Doc>('webhooks', ids.webhook) as never), 'migration-webhook-secret');
assert.equal(get<Doc>('tools', ids.tool)?.headers, undefined);
assert.equal(get<Doc>('webhooks', ids.webhook)?.secret, undefined);

const afterFirst = new Map<string, string>();
for (const collection of Object.keys(dbStats())) afterFirst.set(collection, JSON.stringify(list<Doc>(collection)));
const second = {
  claims: normalizeLegacyInferredCallClaims(),
  retention: normalizeLegacyRetentionClaims(),
  tools: normalizeLegacyToolHeaders(),
  webhooks: normalizeLegacyWebhookSecrets(),
};
flushNow();
for (const [collection, json] of afterFirst) {
  assert.equal(JSON.stringify(list<Doc>(collection)), json, `${collection} changed on the second migration pass`);
}
assert.equal(second.claims.migrated, false);
assert.equal(second.retention.migrated, 0);
assert.equal(second.tools.migrated, 0);
assert.equal(second.webhooks.migrated, 0);

console.log(JSON.stringify({ ok: true, target, first, second, preservedCollections: before.size }, null, 2));
