import crypto from 'node:crypto';
import { commitBatch, get, nowIso, type Doc } from './db';

export type IdempotencyReceiptDoc = Doc & {
  orgId: string;
  namespace: string;
  keyHash: string;
  requestHash: string;
  status: 'processing' | 'completed' | 'failed';
  responseStatus?: number;
  responseBody?: unknown;
  failure?: string;
  expiresAt: string;
  revision: number;
};

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function receiptId(orgId: string, namespace: string, keyHash: string): string {
  return `idem_${digest(`${orgId}\u0000${namespace}\u0000${keyHash}`).slice(0, 40)}`;
}

export type BeginIdempotencyResult =
  | { kind: 'started'; receipt: IdempotencyReceiptDoc }
  | { kind: 'replay'; receipt: IdempotencyReceiptDoc; status: number; body: unknown }
  | { kind: 'processing'; receipt: IdempotencyReceiptDoc };

export function beginIdempotency(input: {
  orgId: string;
  namespace: string;
  key: string;
  requestBody: unknown;
  ttlHours?: number;
}): BeginIdempotencyResult {
  const rawKey = input.key.trim();
  if (rawKey.length < 8 || rawKey.length > 200) throw new Error('Idempotency-Key must contain 8 to 200 characters');
  const keyHash = digest(rawKey);
  const requestHash = digest(JSON.stringify(input.requestBody ?? null));
  const id = receiptId(input.orgId, input.namespace, keyHash);
  const existing = get<IdempotencyReceiptDoc>('idempotencyReceipts', id);
  if (existing) {
    if (existing.orgId !== input.orgId || existing.namespace !== input.namespace || existing.requestHash !== requestHash) {
      throw new Error('this idempotency key was already used for another request');
    }
    if (existing.status === 'completed') {
      return { kind: 'replay', receipt: existing, status: existing.responseStatus ?? 200, body: existing.responseBody };
    }
    if (existing.status === 'processing' && Date.parse(String(existing.updatedAt ?? existing.createdAt ?? '')) > Date.now() - 10 * 60_000) {
      return { kind: 'processing', receipt: existing };
    }
    const reclaimed = commitBatch({
      upserts: [
        {
          collection: 'idempotencyReceipts',
          doc: { ...existing, status: 'processing', failure: undefined },
          expectedRevision: Number(existing.revision ?? 0),
          expectedOrgId: input.orgId,
        },
      ],
    }).upserts[0] as IdempotencyReceiptDoc;
    return { kind: 'started', receipt: reclaimed };
  }

  const at = nowIso();
  const draft = {
    id,
    orgId: input.orgId,
    namespace: input.namespace,
    keyHash,
    requestHash,
    status: 'processing',
    expiresAt: new Date(Date.now() + Math.max(1, Math.min(168, input.ttlHours ?? 24)) * 60 * 60_000).toISOString(),
    createdAt: at,
  } as IdempotencyReceiptDoc;
  try {
    const receipt = commitBatch({
      upserts: [{ collection: 'idempotencyReceipts', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }],
    }).upserts[0] as IdempotencyReceiptDoc;
    return { kind: 'started', receipt };
  } catch (error) {
    // A concurrent request may have inserted after our first read. Re-read and
    // apply exactly the same mismatch/replay rules rather than trusting it.
    if (error instanceof Error && error.name === 'CommitConflictError') return beginIdempotency(input);
    throw error;
  }
}

export function completeIdempotency(receipt: IdempotencyReceiptDoc, status: number, body: unknown): IdempotencyReceiptDoc {
  return commitBatch({
    upserts: [
      {
        collection: 'idempotencyReceipts',
        doc: { ...receipt, status: 'completed', responseStatus: status, responseBody: body, failure: undefined },
        expectedRevision: Number(receipt.revision ?? 0),
        expectedOrgId: receipt.orgId,
      },
    ],
  }).upserts[0] as IdempotencyReceiptDoc;
}

export function failIdempotency(receipt: IdempotencyReceiptDoc, error: unknown): IdempotencyReceiptDoc {
  return commitBatch({
    upserts: [
      {
        collection: 'idempotencyReceipts',
        doc: {
          ...receipt,
          status: 'failed',
          failure: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        },
        expectedRevision: Number(receipt.revision ?? 0),
        expectedOrgId: receipt.orgId,
      },
    ],
  }).upserts[0] as IdempotencyReceiptDoc;
}
