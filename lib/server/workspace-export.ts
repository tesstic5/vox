/**
 * Whole-workspace export.
 *
 * Clients export as CSV and reports export as CSV, but until now a
 * workspace could not take *everything* with it — the portability
 * question every serious buyer (and every GDPR conversation) asks.
 * This is that download: one JSON file with the workspace's own rows
 * from every collection, in the shape the store holds them.
 *
 * Two deliberate exclusions, both about not exporting things that are
 * not the workspace's data to carry:
 *
 *   - **Operational collections** (`sessions`, `authTokens`,
 *     `rateBuckets`, `scheduler`, `apiRequests`, …) — machinery, not
 *     records. They expire on their own and mean nothing off this box.
 *   - **Secrets, wherever they sit.** Any field whose name smells like
 *     a credential (`passwordHash`, `keyHash`, `secret`, `token`, …)
 *     is replaced with `[redacted]`, recursively. An export that leaks
 *     password hashes is worse than no export.
 *
 * Platform-level collections without an `orgId` (sales leads) are
 * never included: the filter is "rows that belong to this workspace",
 * and a row with no workspace does not belong to one.
 */

import { audit } from './audit';
import { dbStats, list, type Doc } from './db';
import { documentExportManifest } from './clinical-documents';
import { coverageView, type ClientCoverageDoc } from './coverage';

const EXCLUDED = new Set([
  'sessions',
  'authTokens',
  'rateBuckets',
  'scheduler',
  'counters',
  'apiRequests',
  'salesLeads',
  'carrierCalls',
  'demoCalls',
  // Provider credentials are excluded wholesale. A recursively redacted sealed
  // envelope or fingerprint is still credential material and has no portability
  // value to the workspace controller.
  'integrationCredentials',
  // Raw encrypted-document internals never enter a generic export. The typed
  // manifest below includes authorised metadata and scan evidence while omitting
  // object keys, ciphertext locations and wrapped encryption keys.
  'clinicalDocuments',
  'documentLinks',
  'clinicalDocumentVersions',
  'documentScanEvents',
  'documentUploadTokens',
]);

const SECRET_KEY = /password|passwd|secret|token|hash|credential|api[-_]?key|private[-_]?key/i;
const INTEGRITY_DIGEST = /^(?:contentHash|previousHash|signedHash|lastSnapshotHash|sha256|plaintextSha256|evidenceHash)$/i;

export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) && !INTEGRITY_DIGEST.test(k) ? '[redacted]' : scrubSecrets(v),
      ])
    );
  }
  return value;
}

export type WorkspaceExport = {
  format: 'voxera-workspace-export';
  version: 2;
  exportedAt: string;
  orgId: string;
  counts: Record<string, number>;
  collections: Record<string, Doc[]>;
  clinicalDocuments: ReturnType<typeof documentExportManifest>;
};

export function buildWorkspaceExport(orgId: string, actor: string): WorkspaceExport {
  const names = Object.keys(dbStats()).filter((n) => !EXCLUDED.has(n)).sort();
  const collections: Record<string, Doc[]> = {};
  const counts: Record<string, number> = {};

  for (const name of names) {
    const rows = list<Doc>(name).filter((doc) => {
      if (name === 'orgs') return doc.id === orgId;
      return (doc as { orgId?: string }).orgId === orgId;
    });
    if (!rows.length) continue;
    const portableRows = name === 'clientCoverages'
      ? (rows as ClientCoverageDoc[]).map((row) => coverageView(row, true))
      : rows;
    collections[name] = scrubSecrets(portableRows) as Doc[];
    counts[name] = rows.length;
  }

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const clinicalDocuments = documentExportManifest(orgId);
  audit({ orgId, actor, action: 'workspace.exported', target: orgId, detail: `${total} rows across ${Object.keys(counts).length} collections; ${clinicalDocuments.documents.length} controlled document manifest row(s)` });

  return {
    format: 'voxera-workspace-export',
    version: 2,
    exportedAt: new Date().toISOString(),
    orgId,
    counts,
    collections,
    clinicalDocuments,
  };
}
