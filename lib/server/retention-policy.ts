import { list, update, type Doc } from './db';

type RetainedRecord = Doc & {
  archivedAt?: string;
  retentionUntil?: string;
  retentionPolicySource?: string;
};

/**
 * Older builds assigned a seven-year purge date without an operator policy.
 * Remove only those unsupported dates; archived records and their content stay
 * intact. Rows carrying explicit policy evidence are never changed.
 */
export function normalizeLegacyRetentionClaims() {
  const migrated: Record<'clients' | 'notes', number> = { clients: 0, notes: 0 };
  for (const collection of ['clients', 'notes'] as const) {
    for (const record of list<RetainedRecord>(collection)) {
      if (!record.archivedAt || !record.retentionUntil || record.retentionPolicySource) continue;
      update<RetainedRecord>(collection, record.id, { retentionUntil: undefined });
      migrated[collection] += 1;
    }
  }
  return { migrated: migrated.clients + migrated.notes, collections: migrated };
}
