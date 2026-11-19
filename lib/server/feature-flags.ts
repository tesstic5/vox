import { commitBatch, find, list, newId, nowIso, type Doc } from './db';

export type FeatureFlagState = 'off' | 'observe' | 'staff' | 'on';
export type FeatureFlagDoc = Doc & {
  orgId: string;
  key: string;
  state: FeatureFlagState;
  updatedBy: string;
  revision: number;
};

export const PHASE1_FEATURE_FLAGS = ['permissions_v2', 'documents_v1'] as const;
export type Phase1FeatureFlag = (typeof PHASE1_FEATURE_FLAGS)[number];

export function featureFlagsFor(orgId: string) {
  return list<FeatureFlagDoc>('featureFlags', (row) => row.orgId === orgId).sort((a, b) => a.key.localeCompare(b.key));
}

export function featureFlagFor(orgId: string, key: string) {
  return find<FeatureFlagDoc>('featureFlags', (row) => row.orgId === orgId && row.key === key);
}

export function ensurePhase1FeatureFlags(orgId: string) {
  const desired: Array<{ key: Phase1FeatureFlag; state: FeatureFlagState }> = [
    { key: 'permissions_v2', state: 'observe' },
    { key: 'documents_v1', state: 'off' },
  ];
  const rows: FeatureFlagDoc[] = [];
  for (const item of desired) {
    const existing = featureFlagFor(orgId, item.key);
    if (existing) { rows.push(existing); continue; }
    const at = nowIso();
    try {
      rows.push(commitBatch({ upserts: [{
        collection: 'featureFlags',
        doc: { id: newId('flag_'), orgId, key: item.key, state: item.state, updatedBy: 'phase1-data-migration', createdAt: at } as FeatureFlagDoc,
        expectedRevision: null, expectedOrgId: orgId,
      }] }).upserts[0] as FeatureFlagDoc);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
      const raced = featureFlagFor(orgId, item.key);
      if (raced) rows.push(raced);
    }
  }
  return rows;
}

export function setFeatureFlag(input: { orgId: string; key: Phase1FeatureFlag; state: FeatureFlagState; actor: string; expectedRevision: number }) {
  if (!PHASE1_FEATURE_FLAGS.includes(input.key)) throw new Error('unknown Phase 1 feature flag');
  if (!['off', 'observe', 'staff', 'on'].includes(input.state)) throw new Error('feature flag state is invalid');
  const existing = featureFlagFor(input.orgId, input.key);
  if (!existing) throw new Error('feature flag not found; run Phase 1 data migrations first');
  return commitBatch({ upserts: [{
    collection: 'featureFlags', doc: { ...existing, state: input.state, updatedBy: input.actor },
    expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
  }] }).upserts[0] as FeatureFlagDoc;
}
