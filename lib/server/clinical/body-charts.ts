import crypto from 'node:crypto';
import {
  CommitConflictError,
  commitBatch,
  get,
  list,
  newId,
  nowIso,
  withEntityLock,
  type BatchUpsert,
  type Doc,
} from '../db';
import { audit } from '../audit';

export type NormalisedPoint = { x: number; y: number };
export type BodyChartMark =
  | { id: string; type: 'point'; x: number; y: number; color: string; size: number }
  | { id: string; type: 'stroke'; points: NormalisedPoint[]; color: string; width: number }
  | { id: string; type: 'label'; x: number; y: number; text: string; color: string };

export type BodyChartTemplateDoc = Doc & {
  orgId: string;
  title: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  sourceMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  coordinateSystem: 'normalised_0_1';
  state: 'draft' | 'published' | 'retired';
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  revision: number;
};

export type BodyChartAnnotationDoc = Doc & {
  orgId: string;
  noteId: string;
  clientId: string;
  sectionId?: string;
  templateId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  coordinateSystem: 'normalised_0_1';
  marks: BodyChartMark[];
  status: 'draft' | 'final';
  noteVersion: number;
  authorId: string;
  authorName?: string;
  lastEditedBy: string;
  lastEditedByName?: string;
  finalisedAt?: string;
  finalisedBy?: string;
  lastSnapshotHash?: string;
  createdAt: string;
  revision: number;
};

export type BodyChartAnnotationVersionDoc = Doc & {
  orgId: string;
  annotationId: string;
  noteId: string;
  clientId: string;
  noteVersion: number;
  sectionId?: string;
  templateId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  coordinateSystem: 'normalised_0_1';
  marks: BodyChartMark[];
  authorId: string;
  authorName?: string;
  signedBy: string;
  signedByName?: string;
  signedAt: string;
  previousHash?: string;
  contentHash: string;
  revision: number;
};

export type BodyChartAnnotationConflictDoc = Doc & {
  orgId: string;
  annotationId: string;
  noteId: string;
  clientId: string;
  expectedRevision: number;
  marks: BodyChartMark[];
  actorId: string;
  actorName?: string;
  occurredAt: string;
  revision: number;
};

export type BodyChartEvidence = {
  annotationId: string;
  templateId: string;
  versionId: string;
  contentHash: string;
};

export type BodyChartWrite<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'FINALISED'; error: string; conflictId?: string };

type ClinicalDocument = Doc & {
  orgId: string;
  ownerType?: string;
  patientId?: string;
  currentVersionId?: string;
  currentScanStatus?: string;
  status?: string;
};
type ClinicalDocumentVersion = Doc & {
  orgId: string;
  documentId: string;
  patientId?: string;
  mimeType?: string;
};
type NoteShape = Doc & {
  orgId: string;
  clientId: string;
  status: string;
  version?: number;
  sections?: Array<{ id?: string; kind?: string }>;
  updatedAt?: string;
};

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const safeId = (value: unknown) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(String(value ?? ''));
const safeText = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text && text.length <= max && !/[<>\u0000-\u001f]/.test(text) ? text : undefined;
};
const safeColor = (value: unknown) => /^#[0-9a-fA-F]{6}$/.test(String(value ?? '')) ? String(value).toLowerCase() : '#dc2626';

function coordinate(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

export function normaliseBodyChartMarks(value: unknown): { marks?: BodyChartMark[]; error?: string } {
  if (!Array.isArray(value)) return { error: 'Body-chart marks must be an array.' };
  if (value.length > 500) return { error: 'A body chart is limited to 500 marks.' };
  const marks: BodyChartMark[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const mark = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const id = String(mark.id ?? '').trim();
    if (!safeId(id) || ids.has(id)) return { error: 'Every body-chart mark needs a unique stable id.' };
    ids.add(id);
    const type = String(mark.type ?? '');
    if (type === 'point') {
      const x = coordinate(mark.x);
      const y = coordinate(mark.y);
      const size = Number(mark.size ?? 8);
      if (x === undefined || y === undefined || !Number.isFinite(size) || size < 1 || size > 40) return { error: `Point ${id} has invalid normalised coordinates or size.` };
      marks.push({ id, type, x, y, color: safeColor(mark.color), size });
      continue;
    }
    if (type === 'stroke') {
      if (!Array.isArray(mark.points) || mark.points.length < 2 || mark.points.length > 2_000) return { error: `Stroke ${id} needs 2–2,000 normalised points.` };
      const points: NormalisedPoint[] = [];
      for (const rawPoint of mark.points) {
        const point = rawPoint && typeof rawPoint === 'object' ? rawPoint as Record<string, unknown> : {};
        const x = coordinate(point.x);
        const y = coordinate(point.y);
        if (x === undefined || y === undefined) return { error: `Stroke ${id} has a point outside the normalised coordinate system.` };
        points.push({ x, y });
      }
      const width = Number(mark.width ?? 3);
      if (!Number.isFinite(width) || width < 0.5 || width > 20) return { error: `Stroke ${id} has an invalid width.` };
      marks.push({ id, type, points, color: safeColor(mark.color), width });
      continue;
    }
    if (type === 'label') {
      const x = coordinate(mark.x);
      const y = coordinate(mark.y);
      const text = safeText(mark.text, 160);
      if (x === undefined || y === undefined || !text) return { error: `Label ${id} has invalid coordinates or unsafe text.` };
      marks.push({ id, type, x, y, text, color: safeColor(mark.color) });
      continue;
    }
    return { error: `Body-chart mark ${id || '(missing id)'} has an unsupported type.` };
  }
  return { marks };
}

function sourceImage(orgId: string, documentId: string, versionId: string): { mimeType?: BodyChartTemplateDoc['sourceMimeType']; error?: string } {
  const document = get<ClinicalDocument>('clinicalDocuments', documentId);
  const version = get<ClinicalDocumentVersion>('clinicalDocumentVersions', versionId);
  if (!document || document.orgId !== orgId || !version || version.orgId !== orgId || version.documentId !== documentId) {
    return { error: 'The source image document/version does not exist in this workspace.' };
  }
  if (document.ownerType !== 'workspace' || document.patientId || version.patientId) {
    return { error: 'Body-chart template images must be workspace-owned and must not be taken from a patient record.' };
  }
  if (document.status === 'archived' || document.currentVersionId !== versionId) return { error: 'Use the active current version of the source image document.' };
  if (document.currentScanStatus !== 'clean') return { error: 'The source image must pass malware scanning before it can become a body-chart template.' };
  if (!IMAGE_MIME_TYPES.has(String(version.mimeType ?? ''))) return { error: 'Body-chart source images must be PNG, JPEG or WebP. SVG/HTML and executable content are refused.' };
  return { mimeType: version.mimeType as BodyChartTemplateDoc['sourceMimeType'] };
}

export function bodyChartTemplates(orgId: string, includeRetired = false) {
  return list<BodyChartTemplateDoc>('bodyChartTemplates', (row) => row.orgId === orgId && (includeRetired || row.state !== 'retired'))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function bodyChartTemplateById(orgId: string, id: string) {
  const row = get<BodyChartTemplateDoc>('bodyChartTemplates', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function createBodyChartTemplate(input: {
  orgId: string;
  title: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  state?: BodyChartTemplateDoc['state'];
  actorId: string;
  actorName?: string;
}): BodyChartWrite<BodyChartTemplateDoc> {
  const title = safeText(input.title, 160);
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', error: 'A body-chart template needs a plain-text title of at most 160 characters.' };
  const source = sourceImage(input.orgId, input.sourceDocumentId, input.sourceDocumentVersionId);
  if (!source.mimeType) return { ok: false, code: 'VALIDATION_ERROR', error: source.error ?? 'The source image is not usable.' };
  const at = nowIso();
  const draft = {
    id: newId('bct_'),
    orgId: input.orgId,
    title,
    sourceDocumentId: input.sourceDocumentId,
    sourceDocumentVersionId: input.sourceDocumentVersionId,
    sourceMimeType: source.mimeType,
    coordinateSystem: 'normalised_0_1' as const,
    state: input.state === 'draft' ? 'draft' as const : 'published' as const,
    createdBy: input.actorId,
    createdByName: input.actorName,
    createdAt: at,
  } as BodyChartTemplateDoc;
  const saved = commitBatch({ upserts: [{ collection: 'bodyChartTemplates', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as BodyChartTemplateDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart_template.created', target: saved.id, detail: `${title}; ${saved.sourceDocumentVersionId}` });
  return { ok: true, value: saved };
}

export function setBodyChartTemplateState(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  state: BodyChartTemplateDoc['state'];
  actorId: string;
}): BodyChartWrite<BodyChartTemplateDoc> {
  const template = bodyChartTemplateById(input.orgId, input.id);
  if (!template) return { ok: false, code: 'NOT_FOUND', error: 'That body-chart template does not exist.' };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'Changing template state requires the exact revision reviewed.' };
  if (!['draft', 'published', 'retired'].includes(input.state)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Template state must be draft, published or retired.' };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'bodyChartTemplates', doc: { ...template, state: input.state }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as BodyChartTemplateDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart_template.state_changed', target: saved.id, detail: input.state });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That body-chart template changed. Reload before changing its state.' };
    throw error;
  }
}

export function bodyChartAnnotations(orgId: string, noteId: string) {
  return list<BodyChartAnnotationDoc>('bodyChartAnnotations', (row) => row.orgId === orgId && row.noteId === noteId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export function bodyChartAnnotationsForClient(orgId: string, clientId: string) {
  return list<BodyChartAnnotationDoc>('bodyChartAnnotations', (row) => row.orgId === orgId && row.clientId === clientId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

export function bodyChartAnnotationVersions(orgId: string, noteId: string) {
  return list<BodyChartAnnotationVersionDoc>('bodyChartAnnotationVersions', (row) => row.orgId === orgId && row.noteId === noteId)
    .sort((a, b) => b.noteVersion - a.noteVersion || b.signedAt.localeCompare(a.signedAt));
}

export function bodyChartAnnotationConflicts(orgId: string, noteId: string) {
  return list<BodyChartAnnotationConflictDoc>('bodyChartAnnotationConflicts', (row) => row.orgId === orgId && row.noteId === noteId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function validExpectedRevision(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function touchNoteWrite(note: NoteShape, expectedRevision: number): BatchUpsert {
  return {
    collection: 'notes',
    doc: { ...note, updatedAt: nowIso() },
    expectedRevision,
    expectedOrgId: note.orgId,
  };
}

function preserveBodyChartConflict(input: {
  orgId: string;
  annotation: BodyChartAnnotationDoc;
  expectedRevision: number;
  marks: BodyChartMark[];
  actorId: string;
  actorName?: string;
}): BodyChartAnnotationConflictDoc {
  const occurredAt = nowIso();
  const draft = {
    id: newId('bcconf_'),
    orgId: input.orgId,
    annotationId: input.annotation.id,
    noteId: input.annotation.noteId,
    clientId: input.annotation.clientId,
    expectedRevision: input.expectedRevision,
    marks: input.marks,
    actorId: input.actorId,
    actorName: input.actorName,
    occurredAt,
    createdAt: occurredAt,
  } as BodyChartAnnotationConflictDoc;
  return commitBatch({ upserts: [{ collection: 'bodyChartAnnotationConflicts', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as BodyChartAnnotationConflictDoc;
}

export function createBodyChartAnnotation(input: {
  orgId: string;
  noteId: string;
  templateId: string;
  sectionId?: string;
  expectedNoteRevision: number;
  marks?: unknown;
  actorId: string;
  actorName?: string;
}): BodyChartWrite<BodyChartAnnotationDoc> {
  if (!validExpectedRevision(input.expectedNoteRevision)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Creating a body chart requires the exact clinical-note revision reviewed by the clinician.' };
  return withEntityLock('clinical-note', `${input.orgId}:${input.noteId}`, () => {
    const note = get<NoteShape>('notes', input.noteId);
    if (!note || note.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That clinical note does not exist.' };
    if (note.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'A finalised note cannot receive a new body chart. Amend the note first.' };
    if (Number(note.revision ?? 0) !== input.expectedNoteRevision) return { ok: false, code: 'CONFLICT', error: 'The clinical note changed after this body-chart slot was opened. Reload it before adding a chart.' };
    if (input.sectionId) {
      const section = (note.sections ?? []).find((row) => row.id === input.sectionId);
      if (!section || section.kind !== 'body_chart') return { ok: false, code: 'VALIDATION_ERROR', error: 'The selected section is not a body-chart slot in this note’s frozen schema.' };
    }
    const template = bodyChartTemplateById(input.orgId, input.templateId);
    if (!template || template.state !== 'published') return { ok: false, code: 'VALIDATION_ERROR', error: 'Choose a published body-chart template from this workspace.' };
    const normalised = normaliseBodyChartMarks(input.marks ?? []);
    if (!normalised.marks) return { ok: false, code: 'VALIDATION_ERROR', error: normalised.error ?? 'Invalid body-chart marks.' };
    const at = nowIso();
    const draft = {
      id: newId('bca_'), orgId: input.orgId, noteId: note.id, clientId: String(note.clientId), sectionId: input.sectionId,
      templateId: template.id, sourceDocumentId: template.sourceDocumentId, sourceDocumentVersionId: template.sourceDocumentVersionId,
      coordinateSystem: 'normalised_0_1' as const, marks: normalised.marks, status: 'draft' as const,
      noteVersion: Math.max(1, Number(note.version ?? 1)), authorId: input.actorId, authorName: input.actorName,
      lastEditedBy: input.actorId, lastEditedByName: input.actorName, createdAt: at,
    } as BodyChartAnnotationDoc;
    try {
      const result = commitBatch({ upserts: [
        touchNoteWrite(note, input.expectedNoteRevision),
        { collection: 'bodyChartAnnotations', doc: draft, expectedRevision: null, expectedOrgId: input.orgId },
      ] });
      const saved = result.upserts.find((row) => row.id === draft.id) as BodyChartAnnotationDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart.created', target: saved.id, detail: `note ${note.id}; template ${template.id}` });
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'The clinical note changed before the body chart was added. Reload the note and try again.' };
      throw error;
    }
  });
}

export function updateBodyChartAnnotation(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  expectedNoteRevision: number;
  marks: unknown;
  actorId: string;
  actorName?: string;
}): BodyChartWrite<BodyChartAnnotationDoc> {
  if (!validExpectedRevision(input.expectedRevision) || !validExpectedRevision(input.expectedNoteRevision)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Saving a body chart requires the exact chart and clinical-note revisions reviewed by the clinician.' };
  const initial = get<BodyChartAnnotationDoc>('bodyChartAnnotations', input.id);
  if (!initial || initial.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That body-chart annotation does not exist.' };
  return withEntityLock('clinical-note', `${input.orgId}:${initial.noteId}`, () => {
    const annotation = get<BodyChartAnnotationDoc>('bodyChartAnnotations', input.id);
    if (!annotation || annotation.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That body-chart annotation does not exist.' };
    if (annotation.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'This body chart is part of signed evidence. Amend the clinical note before changing it.' };
    const note = get<NoteShape>('notes', annotation.noteId);
    if (!note || note.orgId !== input.orgId || note.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'The linked clinical note is not an editable draft.' };
    if (annotation.noteVersion !== Math.max(1, Number(note.version ?? 1))) return { ok: false, code: 'CONFLICT', error: 'This body chart belongs to a different clinical-note version. Reload the record before editing.' };
    const normalised = normaliseBodyChartMarks(input.marks);
    if (!normalised.marks) return { ok: false, code: 'VALIDATION_ERROR', error: normalised.error ?? 'Invalid body-chart marks.' };
    try {
      const result = commitBatch({ upserts: [
        touchNoteWrite(note, input.expectedNoteRevision),
        { collection: 'bodyChartAnnotations', doc: { ...annotation, marks: normalised.marks, lastEditedBy: input.actorId, lastEditedByName: input.actorName }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      ] });
      const saved = result.upserts.find((row) => row.id === annotation.id) as BodyChartAnnotationDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart.updated', target: saved.id, detail: `${saved.marks.length} mark(s); revision ${saved.revision}` });
      return { ok: true, value: saved };
    } catch (error) {
      if (!(error instanceof CommitConflictError)) throw error;
      const conflict = preserveBodyChartConflict({ orgId: input.orgId, annotation, expectedRevision: input.expectedRevision, marks: normalised.marks, actorId: input.actorId, actorName: input.actorName });
      audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart.conflict_preserved', target: annotation.id, detail: `${conflict.id}; expected chart revision ${input.expectedRevision}; expected note revision ${input.expectedNoteRevision}` });
      return { ok: false, code: 'CONFLICT', conflictId: conflict.id, error: 'This body chart or its clinical note changed while you were editing it. Both annotation sets were kept for explicit reconciliation.' };
    }
  });
}

export function resolveBodyChartAnnotationConflict(input: {
  orgId: string;
  annotationId: string;
  conflictId: string;
  expectedRevision: number;
  expectedNoteRevision: number;
  resolution: 'keep_current' | 'use_conflict';
  actorId: string;
  actorName?: string;
}): BodyChartWrite<BodyChartAnnotationDoc> {
  if (!validExpectedRevision(input.expectedRevision) || !validExpectedRevision(input.expectedNoteRevision)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Reconciliation requires the exact chart and clinical-note revisions reviewed by the clinician.' };
  if (input.resolution !== 'keep_current' && input.resolution !== 'use_conflict') return { ok: false, code: 'VALIDATION_ERROR', error: 'Choose either the current annotations or the preserved concurrent set.' };
  const initial = get<BodyChartAnnotationDoc>('bodyChartAnnotations', input.annotationId);
  if (!initial || initial.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That body-chart annotation does not exist.' };
  return withEntityLock('clinical-note', `${input.orgId}:${initial.noteId}`, () => {
    const annotation = get<BodyChartAnnotationDoc>('bodyChartAnnotations', input.annotationId);
    const conflict = get<BodyChartAnnotationConflictDoc>('bodyChartAnnotationConflicts', input.conflictId);
    if (!annotation || annotation.orgId !== input.orgId || !conflict || conflict.orgId !== input.orgId || conflict.annotationId !== annotation.id) return { ok: false, code: 'NOT_FOUND', error: 'That body-chart conflict does not exist.' };
    if (annotation.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'Signed body-chart evidence cannot be reconciled without amending the note.' };
    const note = get<NoteShape>('notes', annotation.noteId);
    if (!note || note.orgId !== input.orgId || note.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'The linked clinical note is not an editable draft.' };
    const selected = input.resolution === 'use_conflict' ? conflict.marks : annotation.marks;
    try {
      const result = commitBatch({
        upserts: [
          touchNoteWrite(note, input.expectedNoteRevision),
          { collection: 'bodyChartAnnotations', doc: { ...annotation, marks: selected, lastEditedBy: input.actorId, lastEditedByName: input.actorName }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
        ],
        deletes: [{ collection: 'bodyChartAnnotationConflicts', id: conflict.id, expectedRevision: conflict.revision, expectedOrgId: input.orgId }],
      });
      const saved = result.upserts.find((row) => row.id === annotation.id) as BodyChartAnnotationDoc;
      audit({ orgId: input.orgId, actor: input.actorId, action: 'body_chart.conflict_resolved', target: saved.id, detail: input.resolution });
      return { ok: true, value: saved };
    } catch (error) {
      if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'The body chart or note changed again. Reload both annotation sets before choosing.' };
      throw error;
    }
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function bodyChartVersionEvidence(row: Omit<BodyChartAnnotationVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'> | BodyChartAnnotationVersionDoc) {
  return {
    id: row.id, orgId: row.orgId, annotationId: row.annotationId, noteId: row.noteId, clientId: row.clientId,
    noteVersion: row.noteVersion, sectionId: row.sectionId, templateId: row.templateId,
    sourceDocumentId: row.sourceDocumentId, sourceDocumentVersionId: row.sourceDocumentVersionId,
    coordinateSystem: row.coordinateSystem, marks: row.marks, authorId: row.authorId, authorName: row.authorName,
    signedBy: row.signedBy, signedByName: row.signedByName, signedAt: row.signedAt, previousHash: row.previousHash,
  };
}

function bodyChartHash(row: Omit<BodyChartAnnotationVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'> | BodyChartAnnotationVersionDoc) {
  return crypto.createHash('sha256').update(canonical(bodyChartVersionEvidence(row))).digest('hex');
}

export function verifyBodyChartAnnotationVersion(row: BodyChartAnnotationVersionDoc) {
  return /^[a-f0-9]{64}$/.test(row.contentHash) && bodyChartHash(row) === row.contentHash;
}

export function prepareBodyChartsForFinalisation(input: {
  orgId: string;
  noteId: string;
  noteVersion: number;
  signedAt: string;
  signerId: string;
  signerName?: string;
}): { writes: BatchUpsert[]; evidence: BodyChartEvidence[] } {
  const annotations = bodyChartAnnotations(input.orgId, input.noteId);
  const writes: BatchUpsert[] = [];
  const evidence: BodyChartEvidence[] = [];
  const conflicts = bodyChartAnnotationConflicts(input.orgId, input.noteId);
  const stale = annotations.find((annotation) => annotation.status !== 'draft' || annotation.noteVersion !== input.noteVersion);
  if (stale) throw new Error('A body chart is not aligned with the current clinical-note version. Reload and reconcile the record before signing.');
  for (const annotation of annotations) {
    if (conflicts.some((row) => row.annotationId === annotation.id)) throw new Error('A body chart has preserved concurrent annotations. Reconcile them explicitly before signing.');
    const previous = bodyChartAnnotationVersions(input.orgId, input.noteId).find((row) => row.annotationId === annotation.id);
    if (previous && !verifyBodyChartAnnotationVersion(previous)) throw new Error('Existing signed body-chart evidence failed SHA-256 verification. Do not extend the chain until it is investigated.');
    const versionId = `${annotation.id}_note_v${input.noteVersion}`;
    const unsigned = {
      id: versionId, orgId: input.orgId, annotationId: annotation.id, noteId: input.noteId, clientId: annotation.clientId,
      noteVersion: input.noteVersion, sectionId: annotation.sectionId, templateId: annotation.templateId,
      sourceDocumentId: annotation.sourceDocumentId, sourceDocumentVersionId: annotation.sourceDocumentVersionId,
      coordinateSystem: 'normalised_0_1' as const, marks: annotation.marks, authorId: annotation.authorId,
      authorName: annotation.authorName, signedBy: input.signerId, signedByName: input.signerName,
      signedAt: input.signedAt, previousHash: previous?.contentHash,
    };
    const contentHash = bodyChartHash(unsigned as Omit<BodyChartAnnotationVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'>);
    const snapshot = { ...unsigned, contentHash, createdAt: input.signedAt } as BodyChartAnnotationVersionDoc;
    writes.push(
      { collection: 'bodyChartAnnotations', doc: { ...annotation, status: 'final', finalisedAt: input.signedAt, finalisedBy: input.signerId, lastSnapshotHash: contentHash }, expectedRevision: annotation.revision, expectedOrgId: input.orgId },
      { collection: 'bodyChartAnnotationVersions', doc: snapshot, expectedRevision: null, expectedOrgId: input.orgId },
    );
    evidence.push({ annotationId: annotation.id, templateId: annotation.templateId, versionId, contentHash });
  }
  evidence.sort((a, b) => a.annotationId.localeCompare(b.annotationId));
  return { writes, evidence };
}

export function prepareBodyChartsForAmendment(input: { orgId: string; noteId: string; nextNoteVersion: number }): BatchUpsert[] {
  return bodyChartAnnotations(input.orgId, input.noteId)
    .filter((annotation) => annotation.status === 'final')
    .map((annotation) => ({
      collection: 'bodyChartAnnotations',
      doc: { ...annotation, status: 'draft', noteVersion: input.nextNoteVersion } as BodyChartAnnotationDoc,
      expectedRevision: annotation.revision,
      expectedOrgId: input.orgId,
    }));
}

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Safe, image-free overlay export in a fixed 1,000×1,000 normalised viewBox. */
export function bodyChartOverlaySvg(annotation: BodyChartAnnotationDoc | BodyChartAnnotationVersionDoc): string {
  const shapes = annotation.marks.map((mark) => {
    if (mark.type === 'point') return `<circle cx="${mark.x * 1000}" cy="${mark.y * 1000}" r="${mark.size}" fill="${mark.color}"/>`;
    if (mark.type === 'stroke') return `<polyline points="${mark.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')}" fill="none" stroke="${mark.color}" stroke-width="${mark.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    return `<text x="${mark.x * 1000}" y="${mark.y * 1000}" fill="${mark.color}" font-family="sans-serif" font-size="24">${xml(mark.text)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="Clinician-authored body chart annotations">${shapes}</svg>`;
}

export function bodyChartExport(annotation: BodyChartAnnotationDoc | BodyChartAnnotationVersionDoc) {
  const immutable = typeof (annotation as BodyChartAnnotationVersionDoc).contentHash === 'string';
  const version = annotation as BodyChartAnnotationVersionDoc;
  const current = annotation as BodyChartAnnotationDoc;
  return {
    schema: 'voxera.body-chart.normalised.v1',
    id: annotation.id,
    annotationId: immutable ? version.annotationId : current.id,
    noteId: annotation.noteId,
    clientId: annotation.clientId,
    sectionId: annotation.sectionId,
    templateId: annotation.templateId,
    sourceDocumentId: annotation.sourceDocumentId,
    sourceDocumentVersionId: annotation.sourceDocumentVersionId,
    coordinateSystem: annotation.coordinateSystem,
    marks: annotation.marks,
    status: immutable ? 'final' as const : current.status,
    noteVersion: annotation.noteVersion,
    authorId: annotation.authorId,
    authorName: annotation.authorName,
    ...(immutable ? {
      signedBy: version.signedBy, signedByName: version.signedByName, signedAt: version.signedAt,
      previousHash: version.previousHash, contentHash: version.contentHash,
      integrity: verifyBodyChartAnnotationVersion(version) ? 'verified' as const : 'failed' as const,
    } : {}),
    revision: annotation.revision,
  };
}

export function bodyChartClientExportManifest(orgId: string, clientId: string) {
  const annotations = bodyChartAnnotationsForClient(orgId, clientId);
  const annotationIds = new Set(annotations.map((row) => row.id));
  const versions = list<BodyChartAnnotationVersionDoc>('bodyChartAnnotationVersions', (row) => row.orgId === orgId && row.clientId === clientId && annotationIds.has(row.annotationId))
    .sort((a, b) => a.noteVersion - b.noteVersion || a.signedAt.localeCompare(b.signedAt));
  const conflicts = list<BodyChartAnnotationConflictDoc>('bodyChartAnnotationConflicts', (row) => row.orgId === orgId && row.clientId === clientId && annotationIds.has(row.annotationId))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const templateIds = new Set(annotations.map((row) => row.templateId));
  const templates = bodyChartTemplates(orgId, true).filter((row) => templateIds.has(row.id)).map((row) => ({
    id: row.id, title: row.title, sourceDocumentId: row.sourceDocumentId, sourceDocumentVersionId: row.sourceDocumentVersionId,
    sourceMimeType: row.sourceMimeType, coordinateSystem: row.coordinateSystem, state: row.state,
  }));
  return {
    schema: 'voxera.body-chart.client-manifest.v1', generatedAt: nowIso(), orgId, clientId, templates,
    annotations: annotations.map(bodyChartExport), versions: versions.map(bodyChartExport), unresolvedConflicts: conflicts,
    sourceDocumentIds: [...new Set(templates.map((row) => row.sourceDocumentId))].sort(),
    note: 'Coordinates are normalised from 0 to 1. Template source bytes are controlled documents and are exported or downloaded separately.',
  };
}
