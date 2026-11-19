/**
 * Assistant version history.
 *
 * Every accepted publish or edit writes an immutable snapshot. Rollback copies
 * an old snapshot forward as a new version rather than rewriting history, so a
 * rollback is itself auditable and reversible.
 */

import { get, insert, list, newId, nowIso, type Doc } from './db';
import { audit } from './audit';

export type VersionDoc = Doc & {
  assistantId: string;
  orgId: string;
  version: number;
  message: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

export function snapshotAssistant(
  assistant: Doc & Record<string, unknown>,
  message: string,
  actor: string
): VersionDoc {
  const version = Number(assistant.version ?? 1);
  const existing = list<VersionDoc>(
    'assistantVersions',
    (v) => v.assistantId === assistant.id && v.version === version
  );
  if (existing.length) return existing[0];

  const snapshot = insert<VersionDoc>('assistantVersions', {
    id: newId('ver_'),
    assistantId: String(assistant.id),
    orgId: String(assistant.orgId),
    version,
    message,
    snapshot: { ...assistant },
    createdAt: nowIso(),
  });
  audit({ orgId: String(assistant.orgId), actor, action: 'assistant.version', target: String(assistant.id), detail: `v${version} — ${message}` });
  return snapshot;
}

export function versionsFor(orgId: string, assistantId: string, limit = 20) {
  return list<VersionDoc>('assistantVersions', (v) => v.orgId === orgId && v.assistantId === assistantId)
    .sort((a, b) => b.version - a.version)
    .slice(0, limit);
}

export function restoreVersion(orgId: string, assistantId: string, version: number, actor: string) {
  const target = list<VersionDoc>('assistantVersions', (v) => v.orgId === orgId && v.assistantId === assistantId).find(
    (v) => v.version === version
  );
  if (!target) return undefined;
  const fresh = get<Doc & Record<string, unknown>>('assistants', assistantId);
  if (!fresh) return undefined;

  // Copy the old snapshot forward under a new version number.
  const nextVersion = Number(fresh.version ?? 1) + 1;
  const { id: _id, orgId: _orgId, createdAt: _createdAt, ...restorable } = target.snapshot as Record<string, unknown>;
  void _id;
  void _orgId;
  void _createdAt;
  const updated = { ...fresh, ...restorable, version: nextVersion, updatedAt: nowIso() };
  return { target, updated };
}
