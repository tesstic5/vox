/** Encrypted, immutable and quarantine-first clinical document lane. */

import crypto from 'node:crypto';
import {
  CommitConflictError,
  commitBatch,
  find,
  get,
  list,
  newId,
  nowIso,
  withEntityLock,
  withEntityLockAsync,
  type Doc,
} from './db';
import { blobStore } from './blob-store';
import { decryptDocumentBytes, encryptDocumentBytes, type DocumentAad, type DocumentEnvelope } from './document-crypto';
import { domainJobDraft, type DomainJobDoc } from './domain-jobs';
import { scanForMalware, type MalwareScanResult } from './malware-scanner';
import { activeLegalHolds } from './privacy-governance';

export type DocumentOwnerType = 'patient' | 'appointment' | 'invoice' | 'clinical_note' | 'referral' | 'form_response' | 'referral_submission' | 'letter' | 'workspace';
export type DocumentLinkRelationship = 'owner' | 'related' | 'evidence' | 'attachment' | 'invoice_support' | 'appointment_attachment' | 'referral_attachment' | 'form_attachment' | 'letter_artifact';
export type ClinicalDocumentStatus = 'active' | 'archived' | 'metadata_only';

export type ClinicalDocumentDoc = Doc & {
  orgId: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  patientId?: string;
  title: string;
  category: string;
  status: ClinicalDocumentStatus;
  currentVersionId?: string;
  versionCount: number;
  currentScanStatus?: DocumentScanEventDoc['status'];
  linkCount: number;
  legacySource?: { collection: 'files'; id: string; metadataOnly: true; originalBytesClaim?: number; originalSha256?: string | null };
  createdBy: string;
  archivedAt?: string;
  archivedBy?: string;
  revision: number;
};

export type ClinicalDocumentLinkDoc = Doc & {
  orgId: string;
  documentId: string;
  patientId?: string;
  resourceType: DocumentOwnerType;
  resourceId: string;
  relationship: DocumentLinkRelationship;
  visibleInPortal: false;
  createdBy: string;
  revision: number;
};

export type ClinicalDocumentVersionDoc = Doc & {
  orgId: string;
  documentId: string;
  patientId?: string;
  version: number;
  originalName: string;
  mimeType: string;
  plaintextBytes: number;
  plaintextSha256: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  objectKey: string;
  envelope: DocumentEnvelope;
  /** Upload-backed versions name their one-time token; trusted server-generated artifacts do not. */
  uploadTokenId?: string;
  source?: 'upload' | 'generated';
  uploadedBy: string;
  revision: number;
};

export type DocumentScanEventDoc = Doc & {
  orgId: string;
  documentId: string;
  versionId: string;
  patientId?: string;
  status: MalwareScanResult['status'];
  scanner: string;
  checkedAt: string;
  detail: string;
  evidenceHash?: string;
  jobId: string;
  attempt: number;
  revision: number;
};

export type DocumentUploadTokenDoc = Doc & {
  orgId: string;
  tokenHash: string;
  documentId?: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  patientId?: string;
  title: string;
  category: string;
  allowedMimeTypes: string[];
  maxBytes: number;
  status: 'active' | 'consumed' | 'expired' | 'revoked';
  expiresAt: string;
  createdBy: string;
  consumedAt?: string;
  versionId?: string;
  revision: number;
};

export type LegacyFileDoc = Doc & {
  orgId: string;
  name?: string;
  bytes?: number;
  purpose?: string;
  sha256?: string | null;
  clientId?: string;
  patientId?: string;
  createdBy?: string;
};

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const DEFAULT_DOCUMENT_MAX_BYTES = Math.max(
  1_048_576,
  Math.min(100 * 1_048_576, Number(process.env.VOXERA_DOCUMENT_MAX_BYTES ?? 25 * 1_048_576) || 25 * 1_048_576),
);

function cleanName(value: string) {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  return clean || 'document';
}

function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3])) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (!bytes.includes(0)) return 'text/plain';
  return undefined;
}

export function resolveDocumentOwnerPatientId(orgId: string, ownerType: DocumentOwnerType, ownerId: string, claimedPatientId?: string) {
  const collection = ownerType === 'patient' ? 'clients'
    : ownerType === 'appointment' ? 'bookings'
      : ownerType === 'invoice' ? 'invoices'
        : ownerType === 'clinical_note' ? 'notes'
          : ownerType === 'referral' ? 'referrals'
            : ownerType === 'form_response' ? 'formResponses'
              : ownerType === 'referral_submission' ? 'referralFormSubmissions'
                : ownerType === 'letter' ? 'letters'
                  : 'orgs';
  const row = find<Doc & { orgId?: string; clientId?: string; patientId?: string; convertedClientId?: string }>(
    collection,
    (item) => item.id === ownerId && (ownerType === 'workspace' ? item.id === orgId : item.orgId === orgId),
  );
  if (!row) throw new Error(`${ownerType} owner not found in this workspace`);
  const linkedPatientId = ownerType === 'patient'
    ? ownerId
    : ownerType === 'workspace'
      ? undefined
      : row.patientId ?? row.clientId ?? row.convertedClientId;
  const mayPrecedePatient = ownerType === 'referral' || ownerType === 'form_response' || ownerType === 'referral_submission' || ownerType === 'letter';
  if (ownerType !== 'workspace' && !linkedPatientId && !mayPrecedePatient) {
    throw new Error(`${ownerType} owner is not linked to a patient; review it before attaching clinical bytes`);
  }
  if (claimedPatientId && linkedPatientId && claimedPatientId !== linkedPatientId) {
    throw new Error('claimed patient does not match the document owner');
  }
  if (linkedPatientId && !find<Doc & { orgId?: string }>('clients', (item) => item.id === linkedPatientId && item.orgId === orgId)) {
    throw new Error('linked patient not found in this workspace');
  }
  return linkedPatientId;
}

function documentLinkId(orgId: string, documentId: string, resourceType: DocumentOwnerType, resourceId: string, relationship: DocumentLinkRelationship) {
  return `dlink_${crypto.createHash('sha256').update(`${orgId}:${documentId}:${resourceType}:${resourceId}:${relationship}`).digest('hex').slice(0, 40)}`;
}

function documentLinkDraft(input: {
  orgId: string;
  documentId: string;
  documentPatientId?: string;
  resourceType: DocumentOwnerType;
  resourceId: string;
  relationship: DocumentLinkRelationship;
  visibleInPortal?: boolean;
  actor: string;
  createdAt?: string;
}): ClinicalDocumentLinkDoc {
  if (input.visibleInPortal) throw new Error('document portal visibility is unavailable until the explicit portal-sharing phase');
  const linkedPatientId = resolveDocumentOwnerPatientId(input.orgId, input.resourceType, input.resourceId);
  if (linkedPatientId && input.documentPatientId !== linkedPatientId) {
    throw new Error('linked record belongs to a different patient');
  }
  return {
    id: documentLinkId(input.orgId, input.documentId, input.resourceType, input.resourceId, input.relationship),
    orgId: input.orgId,
    documentId: input.documentId,
    patientId: input.documentPatientId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    relationship: input.relationship,
    visibleInPortal: false,
    createdBy: input.actor,
    createdAt: input.createdAt ?? nowIso(),
  } as ClinicalDocumentLinkDoc;
}

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createDocumentUploadToken(input: {
  orgId: string;
  documentId?: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  patientId?: string;
  title: string;
  category?: string;
  allowedMimeTypes?: string[];
  maxBytes?: number;
  actor: string;
}): { token: string; upload: DocumentUploadTokenDoc } {
  const patientId = resolveDocumentOwnerPatientId(input.orgId, input.ownerType, input.ownerId, input.patientId);
  if (input.documentId) {
    const existing = documentById(input.orgId, input.documentId);
    if (!existing || existing.status === 'metadata_only') throw new Error('a byte version can only be added to an active document');
    if (existing.ownerType !== input.ownerType || existing.ownerId !== input.ownerId) throw new Error('document owner cannot be changed by an upload token');
    if (existing.patientId !== patientId) throw new Error('document patient linkage cannot be changed by an upload token');
  }
  const title = input.title.trim();
  if (!title || title.length > 180) throw new Error('title must contain 1 to 180 characters');
  const allowedMimeTypes = [...new Set((input.allowedMimeTypes ?? [...DOCUMENT_MIME_TYPES]).filter((mime) => (DOCUMENT_MIME_TYPES as readonly string[]).includes(mime)))];
  if (!allowedMimeTypes.length) throw new Error('at least one supported MIME type is required');
  const maxBytes = Math.max(1, Math.min(DEFAULT_DOCUMENT_MAX_BYTES, Math.floor(input.maxBytes ?? DEFAULT_DOCUMENT_MAX_BYTES)));
  const token = `vup_${crypto.randomBytes(32).toString('base64url')}`;
  const at = nowIso();
  const draft = {
    id: newId('upt_'), orgId: input.orgId, tokenHash: tokenHash(token), documentId: input.documentId,
    ownerType: input.ownerType, ownerId: input.ownerId, patientId, title, category: input.category?.trim().slice(0, 120) || 'clinical_document',
    allowedMimeTypes, maxBytes, status: 'active', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    createdBy: input.actor, createdAt: at,
  } as DocumentUploadTokenDoc;
  const upload = commitBatch({ upserts: [{ collection: 'documentUploadTokens', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as DocumentUploadTokenDoc;
  return { token, upload };
}

export function uploadTokenFor(token: string) {
  const hash = tokenHash(token);
  return list<DocumentUploadTokenDoc>('documentUploadTokens', (row) => row.tokenHash === hash)[0];
}

export function documentById(orgId: string, id: string) {
  return find<ClinicalDocumentDoc>('clinicalDocuments', (row) => row.id === id && row.orgId === orgId);
}

export function documentLinksFor(orgId: string, documentId: string) {
  return list<ClinicalDocumentLinkDoc>('documentLinks', (row) => row.orgId === orgId && row.documentId === documentId)
    .sort((a, b) => Number(a.relationship !== 'owner') - Number(b.relationship !== 'owner') || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function documentLinksForResource(orgId: string, resourceType: DocumentOwnerType, resourceId: string) {
  return list<ClinicalDocumentLinkDoc>(
    'documentLinks',
    (row) => row.orgId === orgId && row.resourceType === resourceType && row.resourceId === resourceId,
  ).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createDocumentLink(input: {
  orgId: string;
  documentId: string;
  resourceType: DocumentOwnerType;
  resourceId: string;
  relationship: Exclude<DocumentLinkRelationship, 'owner'>;
  visibleInPortal?: boolean;
  actor: string;
  expectedDocumentRevision: number;
}) {
  return withEntityLock('clinical-document-link', `${input.orgId}:${input.documentId}`, () => {
    const document = documentById(input.orgId, input.documentId);
    if (!document) throw new Error('document not found');
    if (Number(document.revision ?? 0) !== input.expectedDocumentRevision) throw new Error('document changed after it was loaded');
    const link = documentLinkDraft({
      orgId: input.orgId, documentId: document.id, documentPatientId: document.patientId,
      resourceType: input.resourceType, resourceId: input.resourceId, relationship: input.relationship,
      visibleInPortal: input.visibleInPortal, actor: input.actor,
    });
    if (documentLinksFor(input.orgId, document.id).some((row) =>
      row.resourceType === link.resourceType && row.resourceId === link.resourceId && row.relationship === link.relationship,
    )) throw new Error('document link already exists');
    const committed = commitBatch({ upserts: [
      { collection: 'documentLinks', doc: link, expectedRevision: null, expectedOrgId: input.orgId },
      {
        collection: 'clinicalDocuments', doc: { ...document, linkCount: Number(document.linkCount ?? documentLinksFor(input.orgId, document.id).length) + 1 },
        expectedRevision: input.expectedDocumentRevision, expectedOrgId: input.orgId,
      },
    ] }).upserts;
    return {
      link: committed.find((row) => row.id === link.id) as ClinicalDocumentLinkDoc,
      document: committed.find((row) => row.id === document.id) as ClinicalDocumentDoc,
    };
  });
}

export function removeDocumentLink(input: {
  orgId: string;
  documentId: string;
  linkId: string;
  expectedDocumentRevision: number;
  expectedLinkRevision: number;
}) {
  return withEntityLock('clinical-document-link', `${input.orgId}:${input.documentId}`, () => {
    const document = documentById(input.orgId, input.documentId);
    if (!document) throw new Error('document not found');
    const link = get<ClinicalDocumentLinkDoc>('documentLinks', input.linkId);
    if (!link || link.orgId !== input.orgId || link.documentId !== document.id) throw new Error('document link not found');
    if (link.relationship === 'owner') throw new Error('the canonical owner link cannot be removed');
    if (Number(document.revision ?? 0) !== input.expectedDocumentRevision || Number(link.revision ?? 0) !== input.expectedLinkRevision) {
      throw new Error('document link changed after it was loaded');
    }
    const committed = commitBatch({
      upserts: [{
        collection: 'clinicalDocuments', doc: { ...document, linkCount: Math.max(1, Number(document.linkCount ?? documentLinksFor(input.orgId, document.id).length) - 1) },
        expectedRevision: input.expectedDocumentRevision, expectedOrgId: input.orgId,
      }],
      deletes: [{ collection: 'documentLinks', id: link.id, expectedRevision: input.expectedLinkRevision, expectedOrgId: input.orgId }],
    });
    return { removed: link, document: committed.upserts[0] as ClinicalDocumentDoc };
  });
}

export function documentVersionById(orgId: string, id: string) {
  return find<ClinicalDocumentVersionDoc>('clinicalDocumentVersions', (row) => row.id === id && row.orgId === orgId);
}

export function documentVersionsFor(orgId: string, documentId: string) {
  return list<ClinicalDocumentVersionDoc>('clinicalDocumentVersions', (row) => row.orgId === orgId && row.documentId === documentId)
    .sort((a, b) => b.version - a.version);
}

export function latestScanEvent(orgId: string, versionId: string) {
  return list<DocumentScanEventDoc>('documentScanEvents', (row) => row.orgId === orgId && row.versionId === versionId)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || b.attempt - a.attempt)[0];
}

export function documentsFor(orgId: string, options: { patientId?: string; ownerType?: DocumentOwnerType; ownerId?: string; includeArchived?: boolean } = {}) {
  const linkedIds = options.ownerType || options.ownerId
    ? new Set(list<ClinicalDocumentLinkDoc>('documentLinks', (link) =>
        link.orgId === orgId && (!options.ownerType || link.resourceType === options.ownerType) && (!options.ownerId || link.resourceId === options.ownerId),
      ).map((link) => link.documentId))
    : undefined;
  return list<ClinicalDocumentDoc>(
    'clinicalDocuments',
    (document) => {
      const directOwnerMatch = (!options.ownerType || document.ownerType === options.ownerType) && (!options.ownerId || document.ownerId === options.ownerId);
      return document.orgId === orgId && (!options.patientId || document.patientId === options.patientId) &&
        (directOwnerMatch || Boolean(linkedIds?.has(document.id))) &&
        (options.includeArchived || document.status !== 'archived');
    },
  ).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
}

export async function completeDocumentUpload(input: {
  token: string;
  bytes: Buffer;
  mimeType: string;
  originalName: string;
  actor: string;
}): Promise<{ document: ClinicalDocumentDoc; version: ClinicalDocumentVersionDoc; scanStatus: 'pending' }> {
  const lockId = crypto.createHash('sha256').update(input.token).digest('hex');
  return withEntityLockAsync('clinical-document-upload', lockId, () => completeDocumentUploadLocked(input));
}

async function completeDocumentUploadLocked(input: {
  token: string;
  bytes: Buffer;
  mimeType: string;
  originalName: string;
  actor: string;
}): Promise<{ document: ClinicalDocumentDoc; version: ClinicalDocumentVersionDoc; scanStatus: 'pending' }> {
  const initial = uploadTokenFor(input.token);
  if (!initial) throw new Error('upload token is invalid');
  if (initial.status === 'consumed' && initial.versionId) {
    const version = documentVersionById(initial.orgId, initial.versionId);
    const document = version ? documentById(initial.orgId, version.documentId) : undefined;
    if (version && document) return { document, version, scanStatus: 'pending' };
  }
  if (initial.status !== 'active' || Date.parse(initial.expiresAt) <= Date.now()) throw new Error('upload token is expired or no longer active');
  if (input.bytes.length < 1 || input.bytes.length > initial.maxBytes) throw new Error(`upload must contain 1 to ${initial.maxBytes} bytes`);
  if (!initial.allowedMimeTypes.includes(input.mimeType)) throw new Error('MIME type is not allowed by this upload token');
  const sniffed = sniffMime(input.bytes);
  if (!sniffed || sniffed !== input.mimeType) throw new Error(`file signature does not match declared MIME type ${input.mimeType}`);
  const originalName = cleanName(input.originalName);
  const store = blobStore();
  const documentId = initial.documentId ?? newId('doc_');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = uploadTokenFor(input.token);
    if (!token || token.status !== 'active' || Date.parse(token.expiresAt) <= Date.now()) {
      if (token?.versionId) {
        const replayVersion = documentVersionById(token.orgId, token.versionId);
        const replayDocument = replayVersion && documentById(token.orgId, replayVersion.documentId);
        if (replayVersion && replayDocument) return { document: replayDocument, version: replayVersion, scanStatus: 'pending' };
      }
      throw new Error('upload token was already consumed');
    }
    const existingDocument = documentById(token.orgId, documentId);
    const versionNumber = (existingDocument?.versionCount ?? 0) + 1;
    const versionId = newId('dver_');
    const objectKey = `v1/${crypto.randomBytes(16).toString('hex')}/${crypto.randomBytes(16).toString('hex')}`;
    const aad: DocumentAad = { orgId: token.orgId, documentId, versionId, version: versionNumber, objectKey };
    const encrypted = encryptDocumentBytes(input.bytes, aad);
    await store.put(objectKey, encrypted.ciphertext);
    const at = nowIso();
    const version = {
      id: versionId, orgId: token.orgId, documentId, patientId: token.patientId, version: versionNumber,
      originalName, mimeType: input.mimeType, plaintextBytes: input.bytes.length, plaintextSha256: encrypted.plaintextSha256,
      ciphertextBytes: encrypted.ciphertext.length, ciphertextSha256: encrypted.ciphertextSha256,
      objectKey, envelope: encrypted.envelope, uploadTokenId: token.id, source: 'upload', uploadedBy: input.actor, createdAt: at,
    } as ClinicalDocumentVersionDoc;
    const document = {
      ...(existingDocument ?? {}),
      id: documentId, orgId: token.orgId, ownerType: token.ownerType, ownerId: token.ownerId, patientId: token.patientId,
      title: token.title, category: token.category, status: 'active', currentVersionId: versionId,
      versionCount: versionNumber, currentScanStatus: 'unavailable',
      linkCount: existingDocument ? Math.max(1, Number(existingDocument.linkCount ?? documentLinksFor(token.orgId, documentId).length)) : 1,
      createdBy: existingDocument?.createdBy ?? token.createdBy,
      createdAt: existingDocument?.createdAt ?? at,
    } as ClinicalDocumentDoc;
    const ownerLink = existingDocument ? undefined : documentLinkDraft({
      orgId: token.orgId, documentId, documentPatientId: token.patientId,
      resourceType: token.ownerType, resourceId: token.ownerId, relationship: 'owner',
      actor: token.createdBy, createdAt: at,
    });
    const job = domainJobDraft({
      orgId: token.orgId, type: 'clinical-document.scan', payload: { documentId, versionId },
      dedupeKey: `scan:${versionId}`, maxAttempts: 12,
    });
    try {
      const result = commitBatch({
        upserts: [
          { collection: 'clinicalDocumentVersions', doc: version, expectedRevision: null, expectedOrgId: token.orgId },
          {
            collection: 'clinicalDocuments', doc: document,
            expectedRevision: existingDocument ? Number(existingDocument.revision ?? 0) : null,
            expectedOrgId: token.orgId,
          },
          ...(ownerLink ? [{ collection: 'documentLinks', doc: ownerLink, expectedRevision: null, expectedOrgId: token.orgId }] : []),
          {
            collection: 'documentUploadTokens',
            doc: { ...token, status: 'consumed', consumedAt: at, versionId },
            expectedRevision: Number(token.revision ?? 0), expectedOrgId: token.orgId,
          },
          { collection: 'domainJobs', doc: job, expectedRevision: null, expectedOrgId: token.orgId },
        ],
      });
      return {
        version: result.upserts.find((row) => row.id === versionId) as ClinicalDocumentVersionDoc,
        document: result.upserts.find((row) => row.id === documentId) as ClinicalDocumentDoc,
        scanStatus: 'pending',
      };
    } catch (error) {
      await store.delete(objectKey).catch(() => undefined);
      if (!(error instanceof CommitConflictError)) throw error;
      const consumed = uploadTokenFor(input.token);
      if (consumed?.status === 'consumed' && consumed.versionId) {
        const replayVersion = documentVersionById(consumed.orgId, consumed.versionId);
        const replayDocument = replayVersion && documentById(consumed.orgId, replayVersion.documentId);
        if (replayVersion && replayDocument) return { document: replayDocument, version: replayVersion, scanStatus: 'pending' };
      }
    }
  }
  throw new Error('document changed repeatedly while the upload completed; request a fresh upload token');
}

/**
 * Persist bytes produced by Voxera itself (for example, a finalised letter PDF).
 *
 * Generated artifacts use the same encrypted object store and immutable document
 * metadata as uploads, but are marked clean at creation because no untrusted file
 * crossed the boundary. The deterministic owner/category id makes retries and
 * competing finalise requests converge on one immutable artifact.
 */
export async function persistGeneratedDocument(input: {
  orgId: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  patientId?: string;
  title: string;
  category: string;
  originalName: string;
  mimeType: string;
  bytes: Buffer;
  actor: string;
}): Promise<{ document: ClinicalDocumentDoc; version: ClinicalDocumentVersionDoc; scan: DocumentScanEventDoc }> {
  if (!input.bytes.length) throw new Error('generated artifact must not be empty');
  if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(input.mimeType)) throw new Error('generated artifact MIME type is not supported');
  const patientId = resolveDocumentOwnerPatientId(input.orgId, input.ownerType, input.ownerId, input.patientId);
  const category = input.category.trim().slice(0, 120) || 'generated_artifact';
  const title = input.title.trim().slice(0, 180);
  if (!title) throw new Error('generated artifact title is required');
  const plaintextSha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const identity = `${input.orgId}:${input.ownerType}:${input.ownerId}:${category}`;
  const documentId = `doc_gen_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;

  return withEntityLockAsync('clinical-generated-document', documentId, async () => {
    const existing = documentById(input.orgId, documentId);
    if (existing) {
      const version = existing.currentVersionId ? documentVersionById(input.orgId, existing.currentVersionId) : undefined;
      const scan = version ? latestScanEvent(input.orgId, version.id) : undefined;
      if (!version || !scan || version.plaintextSha256 !== plaintextSha256 || version.mimeType !== input.mimeType || scan.status !== 'clean') {
        throw new Error('a different or incomplete generated artifact already exists for this record');
      }
      return { document: existing, version, scan };
    }

    const versionId = `dver_gen_${crypto.createHash('sha256').update(`${documentId}:${plaintextSha256}`).digest('hex').slice(0, 40)}`;
    const objectKey = `v1/generated/${crypto.randomBytes(16).toString('hex')}/${crypto.randomBytes(16).toString('hex')}`;
    const aad: DocumentAad = { orgId: input.orgId, documentId, versionId, version: 1, objectKey };
    const encrypted = encryptDocumentBytes(input.bytes, aad);
    const store = blobStore();
    await store.put(objectKey, encrypted.ciphertext);
    const at = nowIso();
    const version = {
      id: versionId,
      orgId: input.orgId,
      documentId,
      patientId,
      version: 1,
      originalName: cleanName(input.originalName),
      mimeType: input.mimeType,
      plaintextBytes: input.bytes.length,
      plaintextSha256: encrypted.plaintextSha256,
      ciphertextBytes: encrypted.ciphertext.length,
      ciphertextSha256: encrypted.ciphertextSha256,
      objectKey,
      envelope: encrypted.envelope,
      source: 'generated',
      uploadedBy: input.actor,
      createdAt: at,
    } as ClinicalDocumentVersionDoc;
    const document = {
      id: documentId,
      orgId: input.orgId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      patientId,
      title,
      category,
      status: 'active',
      currentVersionId: versionId,
      versionCount: 1,
      currentScanStatus: 'clean',
      linkCount: 1,
      createdBy: input.actor,
      createdAt: at,
    } as ClinicalDocumentDoc;
    const ownerLink = documentLinkDraft({
      orgId: input.orgId,
      documentId,
      documentPatientId: patientId,
      resourceType: input.ownerType,
      resourceId: input.ownerId,
      relationship: 'owner',
      actor: input.actor,
      createdAt: at,
    });
    const scan = {
      id: `dscan_gen_${crypto.createHash('sha256').update(versionId).digest('hex').slice(0, 40)}`,
      orgId: input.orgId,
      documentId,
      versionId,
      patientId,
      status: 'clean',
      scanner: 'voxera-generated-artifact-v1',
      checkedAt: at,
      detail: 'Trusted bytes generated by Voxera; no external upload was accepted.',
      evidenceHash: crypto.createHash('sha256').update(`generated:${plaintextSha256}:${input.mimeType}`).digest('hex'),
      jobId: `generated:${input.ownerType}:${input.ownerId}`,
      attempt: 1,
      createdAt: at,
    } as DocumentScanEventDoc;

    try {
      const committed = commitBatch({ upserts: [
        { collection: 'clinicalDocumentVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
        { collection: 'clinicalDocuments', doc: document, expectedRevision: null, expectedOrgId: input.orgId },
        { collection: 'documentLinks', doc: ownerLink, expectedRevision: null, expectedOrgId: input.orgId },
        { collection: 'documentScanEvents', doc: scan, expectedRevision: null, expectedOrgId: input.orgId },
      ] }).upserts;
      return {
        version: committed.find((row) => row.id === versionId) as ClinicalDocumentVersionDoc,
        document: committed.find((row) => row.id === documentId) as ClinicalDocumentDoc,
        scan: committed.find((row) => row.id === scan.id) as DocumentScanEventDoc,
      };
    } catch (error) {
      await store.delete(objectKey).catch(() => undefined);
      if (error instanceof CommitConflictError) {
        const winner = documentById(input.orgId, documentId);
        const winnerVersion = winner?.currentVersionId ? documentVersionById(input.orgId, winner.currentVersionId) : undefined;
        const winnerScan = winnerVersion ? latestScanEvent(input.orgId, winnerVersion.id) : undefined;
        if (winner && winnerVersion && winnerScan && winnerVersion.plaintextSha256 === plaintextSha256 && winnerScan.status === 'clean') {
          return { document: winner, version: winnerVersion, scan: winnerScan };
        }
      }
      throw error;
    }
  });
}

async function plaintextForVersion(version: ClinicalDocumentVersionDoc) {
  const ciphertext = await blobStore().get(version.objectKey);
  if (ciphertext.length !== version.ciphertextBytes || crypto.createHash('sha256').update(ciphertext).digest('hex') !== version.ciphertextSha256) {
    throw new Error('encrypted object integrity check failed');
  }
  const aad: DocumentAad = {
    orgId: version.orgId, documentId: version.documentId, versionId: version.id, version: version.version, objectKey: version.objectKey,
  };
  const plaintext = decryptDocumentBytes(ciphertext, version.envelope, aad);
  if (plaintext.length !== version.plaintextBytes || crypto.createHash('sha256').update(plaintext).digest('hex') !== version.plaintextSha256) {
    throw new Error('decrypted document integrity check failed');
  }
  return plaintext;
}

export async function runDocumentScanJob(job: DomainJobDoc) {
  const versionId = String(job.payload.versionId ?? '');
  const version = documentVersionById(job.orgId, versionId);
  if (!version) throw new Error('document version for scan job no longer exists');
  const plaintext = await plaintextForVersion(version);
  const scan = await scanForMalware(plaintext);
  plaintext.fill(0);
  const eventId = `dscan_${crypto.createHash('sha256').update(`${job.id}:${job.attempts}`).digest('hex').slice(0, 40)}`;
  const event = {
    id: eventId, orgId: job.orgId, documentId: version.documentId, versionId: version.id, patientId: version.patientId,
    status: scan.status, scanner: scan.scanner, checkedAt: scan.checkedAt, detail: scan.detail,
    evidenceHash: scan.evidenceHash, jobId: job.id, attempt: job.attempts, createdAt: scan.checkedAt,
  } as DocumentScanEventDoc;
  const document = documentById(job.orgId, version.documentId);
  const upserts: Array<{ collection: string; doc: Doc; expectedRevision?: number | null; expectedOrgId: string }> = [
    { collection: 'documentScanEvents', doc: event, expectedRevision: null, expectedOrgId: job.orgId },
  ];
  if (document?.currentVersionId === version.id) {
    upserts.push({
      collection: 'clinicalDocuments', doc: { ...document, currentScanStatus: scan.status },
      expectedRevision: Number(document.revision ?? 0), expectedOrgId: job.orgId,
    });
  }
  try {
    commitBatch({ upserts });
  } catch (error) {
    if (!(error instanceof CommitConflictError)) throw error;
    // A newer upload can race the scan summary update. The immutable scan event
    // is still required; append it without touching the now-newer document.
    if (!get<DocumentScanEventDoc>('documentScanEvents', event.id)) {
      commitBatch({ upserts: [{ collection: 'documentScanEvents', doc: event, expectedRevision: null, expectedOrgId: job.orgId }] });
    }
  }
  if (scan.status === 'error' || scan.status === 'unavailable') throw new Error(scan.detail);
}

export async function downloadDocumentVersion(orgId: string, documentId: string, versionId?: string) {
  const document = documentById(orgId, documentId);
  if (!document) throw new Error('document not found');
  if (document.status === 'metadata_only') throw new Error('legacy metadata has no uploaded bytes');
  if (document.status === 'archived') throw new Error('document is archived');
  const wanted = versionId ?? document.currentVersionId;
  const version = wanted ? documentVersionById(orgId, wanted) : undefined;
  if (!version || version.documentId !== document.id) throw new Error('document version not found');
  const scan = latestScanEvent(orgId, version.id);
  if (!scan || scan.status !== 'clean') throw new Error(`document remains quarantined${scan ? ` (${scan.status})` : ' (scan pending)'}`);
  const bytes = await plaintextForVersion(version);
  return { document, version, bytes, scan };
}

export function archiveDocument(input: { orgId: string; id: string; actor: string; expectedRevision?: number }) {
  return withEntityLock('privacy-governance', input.orgId, () => {
    const document = documentById(input.orgId, input.id);
    if (!document) throw new Error('document not found');
    const chartTemplates = list<Doc>('bodyChartTemplates', (row) => row.orgId === input.orgId && row.sourceDocumentId === document.id);
    if (chartTemplates.length) throw new Error(`document is pinned by ${chartTemplates.length} body-chart template(s); preserve its source image`);
    const holds = activeLegalHolds({ orgId: input.orgId, patientId: document.patientId, resourceId: document.id, recordClass: 'clinical_document' });
    if (holds.length) throw new Error(`${holds.length} active legal hold(s) prevent archiving this document`);
    return commitBatch({
      upserts: [{ collection: 'clinicalDocuments', doc: { ...document, status: 'archived', archivedAt: nowIso(), archivedBy: input.actor }, expectedRevision: input.expectedRevision ?? Number(document.revision ?? 0), expectedOrgId: input.orgId }],
    }).upserts[0] as ClinicalDocumentDoc;
  });
}

function legacyDocumentId(orgId: string, sourceId: string) {
  return `doc_legacy_${crypto.createHash('sha256').update(`${orgId}:${sourceId}`).digest('hex').slice(0, 32)}`;
}

export function migrateLegacyFileMetadata(orgId: string, actor = 'migration') {
  const files = list<LegacyFileDoc>('files', (file) => file.orgId === orgId);
  let migrated = 0;
  let existing = 0;
  for (const file of files) {
    const id = legacyDocumentId(orgId, file.id);
    if (documentById(orgId, id)) {
      existing += 1;
      continue;
    }
    const patientId = file.patientId ?? file.clientId;
    const row = {
      id, orgId, ownerType: patientId ? 'patient' : 'workspace', ownerId: patientId ?? orgId, patientId,
      title: cleanName(String(file.name ?? 'Legacy file metadata')), category: String(file.purpose ?? 'legacy').slice(0, 120),
      status: 'metadata_only', versionCount: 0, linkCount: 1, legacySource: {
        collection: 'files', id: file.id, metadataOnly: true, originalBytesClaim: Number(file.bytes ?? 0), originalSha256: file.sha256 ?? null,
      },
      createdBy: file.createdBy ?? actor, createdAt: file.createdAt ?? nowIso(),
    } as ClinicalDocumentDoc;
    const ownerLink = documentLinkDraft({
      orgId, documentId: id, documentPatientId: patientId,
      resourceType: row.ownerType, resourceId: row.ownerId, relationship: 'owner',
      actor: row.createdBy, createdAt: String(row.createdAt),
    });
    try {
      commitBatch({ upserts: [
        { collection: 'clinicalDocuments', doc: row, expectedRevision: null, expectedOrgId: orgId },
        { collection: 'documentLinks', doc: ownerLink, expectedRevision: null, expectedOrgId: orgId },
      ] });
      migrated += 1;
    } catch (error) {
      if (error instanceof CommitConflictError) existing += 1;
      else throw error;
    }
  }
  return { scanned: files.length, migrated, existing, metadataOnly: migrated + existing };
}

export function backfillDocumentLinks(orgId: string, actor = 'data-migration') {
  let created = 0;
  let existing = 0;
  for (const document of documentsFor(orgId, { includeArchived: true })) {
    const links = documentLinksFor(orgId, document.id);
    const ownerLink = links.find((link) =>
      link.resourceType === document.ownerType && link.resourceId === document.ownerId && link.relationship === 'owner',
    );
    if (ownerLink && Number(document.linkCount ?? 0) === links.length) {
      existing += 1;
      continue;
    }
    const upserts: Array<{ collection: string; doc: Doc; expectedRevision: number | null; expectedOrgId: string }> = [{
      collection: 'clinicalDocuments', doc: { ...document, linkCount: Math.max(1, links.length + (ownerLink ? 0 : 1)) },
      expectedRevision: Number(document.revision ?? 0), expectedOrgId: orgId,
    }];
    if (!ownerLink) {
      upserts.push({
        collection: 'documentLinks',
        doc: documentLinkDraft({
          orgId, documentId: document.id, documentPatientId: document.patientId,
          resourceType: document.ownerType, resourceId: document.ownerId, relationship: 'owner',
          actor, createdAt: String(document.createdAt ?? nowIso()),
        }),
        expectedRevision: null, expectedOrgId: orgId,
      });
    }
    try {
      commitBatch({ upserts });
      created += ownerLink ? 0 : 1;
    } catch (error) {
      if (!(error instanceof CommitConflictError)) throw error;
    }
  }
  return { documents: documentsFor(orgId, { includeArchived: true }).length, created, existing };
}

export async function runLegacyDocumentMigrationJob(job: DomainJobDoc) {
  migrateLegacyFileMetadata(job.orgId, 'domain-job');
  backfillDocumentLinks(job.orgId, 'domain-job');
}

export function documentExportManifest(orgId: string, options: { patientId?: string; documentIds?: readonly string[] } = {}) {
  const allowedIds = options.documentIds ? new Set(options.documentIds) : undefined;
  const documents = documentsFor(orgId, { patientId: options.patientId, includeArchived: true })
    .filter((document) => !allowedIds || allowedIds.has(document.id));
  return {
    generatedAt: nowIso(),
    orgId,
    patientId: options.patientId,
    documents: documents.map((document) => ({
      id: document.id, ownerType: document.ownerType, ownerId: document.ownerId, patientId: document.patientId,
      title: document.title, category: document.category, status: document.status, versionCount: document.versionCount,
      currentVersionId: document.currentVersionId, currentScanStatus: document.currentScanStatus,
      legacySource: document.legacySource,
      links: documentLinksFor(orgId, document.id).map((link) => ({
        id: link.id, resourceType: link.resourceType, resourceId: link.resourceId,
        relationship: link.relationship, visibleInPortal: link.visibleInPortal, createdAt: link.createdAt,
      })),
      versions: documentVersionsFor(orgId, document.id).map((version) => ({
        id: version.id, version: version.version, originalName: version.originalName, mimeType: version.mimeType,
        bytes: version.plaintextBytes, sha256: version.plaintextSha256, createdAt: version.createdAt,
        scan: latestScanEvent(orgId, version.id),
      })),
    })),
    note: 'Object keys, wrapped encryption keys and ciphertext metadata are intentionally excluded.',
  };
}
