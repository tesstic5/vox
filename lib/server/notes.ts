/**
 * Notes — what the practice writes down about an encounter.
 *
 * A note is the one record in this product that is *about a person's body* (or a
 * person's house, or their car), which makes it the one that needs the most
 * discipline. Four rules, enforced here rather than in the UI:
 *
 *   1. **Nothing is overwritten.** A draft can be edited freely. Once it is
 *      finalised it is frozen; changing it means *amending* it, which keeps the
 *      signed version in `versions` and starts a new one. Version 1 is never lost.
 *   2. **A note cannot be signed while it is half-written.** Finalising is
 *      refused with the list of blank required sections rather than a shrug.
 *   3. **Clinical content is not reception-desk content.** Reading a note body
 *      needs a role that treats people; the desk can see that a note exists and
 *      whether it is signed, which is what they actually need to chase.
 *   4. **Every read and write is logged against the note itself.** Same promise
 *      the client record makes (see `access-log.ts`); a records system without it
 *      is a document store with a nicer font.
 *
 * The agent may *draft* a note — it is the fastest thing in the world at writing
 * down what was said — but it can never finalise one, and `draftedBy: 'agent'`
 * is carried on the record so a person can see what still needs reading.
 */

import crypto from 'node:crypto';
import { CommitConflictError, commitBatch, get, insert, list, newId, nowIso, update, withEntityLock, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { appendClinicalAccessEvent } from './clinical-access';
import { clientById, DEFAULT_RETENTION_DAYS } from './clients';
import { serviceById, servicesFor, termsForOrg } from './practice';
import {
  createNoteTemplate,
  currentNoteTemplateVersion,
  noteTemplateByIdV2,
  noteTemplatesV2,
  type ClinicalTemplateSection,
} from './clinical/templates';
import {
  bodyChartAnnotations,
  prepareBodyChartsForAmendment,
  prepareBodyChartsForFinalisation,
  type BodyChartEvidence,
} from './clinical/body-charts';
import type { TermPackId } from '@/lib/terms';

export type NoteStatus = 'draft' | 'final' | 'archived';

export type NoteSection = {
  id: string;
  /** Shown as the section heading, in the practice's own vocabulary. */
  label: string;
  body: string;
  /** Frozen with the note so a body-chart slot never degrades into free text. */
  kind?: ClinicalTemplateSection['kind'];
  /** A blank required text section, or an empty body-chart slot, blocks signing. */
  required?: boolean;
  hint?: string;
};

export type NoteVersion = {
  version: number;
  sections: NoteSection[];
  body: string;
  at: string;
  by: string;
  byName?: string;
  /** `finalised` or `amended` — why this version exists. */
  reason: string;
  templateId?: string;
  templateVersionId?: string;
  templateVersion?: number;
  previousHash?: string;
  bodyCharts?: BodyChartEvidence[];
  contentHash?: string;
  integrity?: 'verified' | 'failed' | 'legacy_unhashed';
};

/** One append-only signed snapshot. It is never rewritten or deleted. */
export type ClinicalNoteVersionDoc = Doc & {
  orgId: string;
  noteId: string;
  clientId: string;
  version: number;
  title: string;
  sections: NoteSection[];
  body: string;
  templateId?: string;
  templateVersionId?: string;
  templateVersion?: number;
  signerId: string;
  signerName?: string;
  signedAt: string;
  reason: 'finalised' | 'amended';
  previousHash?: string;
  bodyCharts?: BodyChartEvidence[];
  contentHash: string;
  revision: number;
};

/** A stale clinical draft is retained separately until a clinician chooses. */
export type NoteDraftConflictDoc = Doc & {
  orgId: string;
  noteId: string;
  clientId: string;
  expectedRevision: number;
  title: string;
  sections: NoteSection[];
  body: string;
  actorId: string;
  actorName?: string;
  occurredAt: string;
  revision: number;
};

export type NoteAttachment = {
  id: string;
  name: string;
  bytes: number;
  contentType?: string;
  sha256?: string;
  /** Registration only, exactly like `/v1/files`: where the bytes live is the deployment's business. */
  at: string;
  by: string;
  byName?: string;
};

export type NoteTemplateDoc = Doc & {
  orgId: string;
  name: string;
  /** A template for one service, or the general one when absent. */
  serviceId?: string;
  sections: ClinicalTemplateSection[];
  active: boolean;
  state?: 'draft' | 'published' | 'retired';
  currentVersion?: number;
  currentVersionId?: string;
  revision?: number;
  createdAt: string;
};

export type NoteDoc = Doc & {
  orgId: string;
  clientId: string;
  /** The visit this note is about, when it is about one. */
  bookingId?: string;
  serviceId?: string;
  providerId?: string;
  templateId?: string;
  templateName?: string;
  /** Exact immutable schema used when this note was opened. */
  templateVersionId?: string;
  templateVersion?: number;
  title: string;
  status: NoteStatus;
  /** Composed from the sections — what a person actually reads. */
  body: string;
  sections: NoteSection[];
  version: number;
  /** Legacy embedded signed versions are read-only compatibility evidence. */
  versions: NoteVersion[];
  /** Optimistic record revision; every clinical-text transition increments it. */
  revision: number;
  signedHash?: string;
  lastFinalisedVersion?: number;
  draftedBy: 'agent' | 'staff' | 'seed';
  sourceCallId?: string;
  authorId?: string;
  authorName?: string;
  signerId?: string;
  signerName?: string;
  signedAt?: string;
  amendedAt?: string;
  amendedReason?: string;
  archivedAt?: string;
  archivedBy?: string;
  retentionUntil?: string;
  retentionPolicySource?: 'environment';
  createdAt: string;
  updatedAt: string;
};

/* ------------------------------------------------------------------ policy */

/**
 * Who may read clinical content.
 *
 * A practitioner, or somebody responsible for the practice (owner/admin). A
 * receptionist runs the diary; a viewer looks and does not touch; neither reads
 * what was written about somebody's treatment. This is a *default*, not a
 * setting — a practice that wants the desk to see notes is asking for a
 * different product, and pretending a checkbox makes that safe is how records
 * systems get people hurt.
 */
export const NOTE_READ_ROLES = ['owner', 'admin', 'developer', 'practitioner'] as const;

export function canReadNotes(role: string | undefined): boolean {
  return Boolean(role && (NOTE_READ_ROLES as readonly string[]).includes(role));
}

/** Writing follows reading: if you may not read it, you may not write it. */
export function canWriteNotes(role: string | undefined): boolean {
  return canReadNotes(role);
}

/** Notes are clinical content: the term pack says what a practice calls them. */
export function notesTerm(orgId: string) {
  return termsForOrg(orgId).note;
}

/**
 * Metadata without the content.
 *
 * The desk still needs to know a note exists — "Mrs Patel's note is not signed"
 * is a thing to chase — so a restricted read keeps the shape and drops the
 * substance. Nothing clinical survives: not the body, not the sections, not the
 * attachment names (a file called `wound-week-3.jpg` is clinical content too).
 */
export function redactNote(note: NoteDoc) {
  return {
    id: note.id,
    orgId: note.orgId,
    clientId: note.clientId,
    bookingId: note.bookingId,
    // A title or template name may itself disclose clinical content. Reception
    // gets a neutral administrative label and status only.
    title: 'Clinical note',
    status: note.status,
    version: note.version,
    draftedBy: note.draftedBy,
    authorName: note.authorName,
    signerName: note.signerName,
    signedAt: note.signedAt,
    amendedAt: note.amendedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    sectionCount: note.sections.length,
    attachmentCount: (note.attachments as NoteAttachment[] | undefined)?.length ?? 0,
    incomplete: incompleteSections(note),
    restricted: true as const,
    restrictedReason: 'This note is clinical content. Your role cannot open it — ask a practitioner or the practice owner.',
  };
}

/* --------------------------------------------------------------- templates */

/**
 * The sections a note is written in, per trade.
 *
 * Clinical asks "what did you find and what did you do"; a service business asks
 * "what was the job and what is left"; an office asks "what happened and what
 * next". Same record, three vocabularies — the term pack decides, so a physio
 * never reads "Parts used" and a plumber never reads "Assessment".
 */
export function templateSections(pack: TermPackId, serviceName?: string): ClinicalTemplateSection[] {
  if (pack === 'clinical') {
    return [
      { id: 'presentation', label: 'Presentation', prompt: `Why they came in${serviceName ? ` — ${serviceName}` : ''}`, required: true },
      { id: 'assessment', label: 'Assessment', prompt: 'What you found on examination', required: true },
      { id: 'treatment', label: 'Treatment', prompt: 'What was done this visit', required: true },
      { id: 'plan', label: 'Plan', prompt: 'What happens next, and when', required: false },
      { id: 'advice', label: 'Advice given', prompt: 'Anything they were told to do at home', required: false },
    ];
  }
  if (pack === 'service') {
    return [
      { id: 'attended', label: 'Attended', prompt: `What the visit was for${serviceName ? ` — ${serviceName}` : ''}`, required: true },
      { id: 'work', label: 'Work carried out', prompt: 'What was actually done on site', required: true },
      { id: 'parts', label: 'Parts and materials', prompt: 'Anything used, and whether it was charged for', required: false },
      { id: 'followup', label: 'Follow-up', prompt: 'Whether a return visit is needed, and when', required: false },
    ];
  }
  return [
    { id: 'summary', label: 'Summary', prompt: `What this contact was about${serviceName ? ` — ${serviceName}` : ''}`, required: true },
    { id: 'detail', label: 'Detail', prompt: 'What was discussed or agreed', required: true },
    { id: 'next', label: 'Next steps', prompt: 'Who does what, and by when', required: false },
  ];
}

/** Seeded per workspace, one immutable version per active service plus general. */
export function seedNoteTemplatesForOrg(orgId: string): { seeded: number; total: number } {
  const pack = termsForOrg(orgId).note.many === 'treatment notes' ? 'clinical' : termsForOrg(orgId).note.many === 'job notes' ? 'service' : 'generic';
  let existing = noteTemplatesV2(orgId, { includeRetired: true });
  let seeded = 0;

  const ensure = (name: string, serviceId: string | undefined, serviceName: string | undefined) => {
    if (existing.some((template) => (template.serviceId ?? undefined) === serviceId)) return;
    const made = createNoteTemplate({
      orgId,
      name,
      serviceId,
      sections: templateSections(pack as TermPackId, serviceName),
      state: 'published',
      changeReason: 'Initial template',
      actorId: 'system',
      actorName: 'Voxera',
      provenance: 'seed',
    });
    if (made.ok) {
      existing = [made.template, ...existing];
      seeded += 1;
    }
  };

  ensure(`${termsForOrg(orgId).client.One} ${termsForOrg(orgId).note.one}`, undefined, undefined);
  for (const service of servicesFor(orgId)) ensure(service.name, service.id, service.name);
  return { seeded, total: noteTemplatesV2(orgId, { includeRetired: true }).length };
}

export function noteTemplatesFor(orgId: string, opts?: { includeInactive?: boolean }) {
  return noteTemplatesV2(orgId, { includeRetired: opts?.includeInactive });
}

/** Service-specific beats general, and every result points at a frozen version. */
export function noteTemplateFor(orgId: string, opts?: { serviceId?: string; templateId?: string }) {
  if (opts?.templateId) return noteTemplateByIdV2(orgId, opts.templateId);
  const all = noteTemplatesV2(orgId);
  if (opts?.serviceId) {
    const exact = all.find((template) => template.serviceId === opts.serviceId);
    if (exact) return exact;
  }
  return all.find((template) => !template.serviceId) ?? all[0];
}

/* -------------------------------------------------------------------- reads */

function normaliseNote(note: NoteDoc): NoteDoc {
  return {
    ...note,
    sections: Array.isArray(note.sections) ? note.sections : [],
    versions: Array.isArray(note.versions) ? note.versions : [],
    version: Math.max(1, Number(note.version ?? 1) || 1),
    revision: Math.max(0, Number(note.revision ?? 0) || 0),
  };
}

export function notesFor(
  orgId: string,
  filter?: { clientId?: string; bookingId?: string; status?: NoteStatus; includeArchived?: boolean }
) {
  return list<NoteDoc>('notes', (n) => {
    if (n.orgId !== orgId) return false;
    if (filter?.clientId && n.clientId !== filter.clientId) return false;
    if (filter?.bookingId && n.bookingId !== filter.bookingId) return false;
    if (filter?.status && n.status !== filter.status) return false;
    if (!filter?.includeArchived && !filter?.status && n.status === 'archived') return false;
    return true;
  }).map(normaliseNote);
}

export function noteById(orgId: string, id: string) {
  const doc = get<NoteDoc>('notes', id);
  return doc && doc.orgId === orgId ? normaliseNote(doc) : undefined;
}

export function notesForBooking(orgId: string, bookingId: string) {
  return notesFor(orgId, { bookingId, includeArchived: true });
}

/** Required sections still blank. Body-chart slots are satisfied only by a linked chart for this note version. */
export function incompleteSections(note: NoteDoc): string[] {
  const requiresChart = (note.sections ?? []).some((section) => section.required && section.kind === 'body_chart');
  const chartSections = requiresChart
    ? new Set(
        bodyChartAnnotations(note.orgId, note.id)
          .filter((chart) => chart.noteVersion === note.version)
          .map((chart) => chart.sectionId)
          .filter((id): id is string => Boolean(id)),
      )
    : new Set<string>();
  const missing = (note.sections ?? [])
    .filter((section) => section.required && (section.kind === 'body_chart'
      ? !chartSections.has(section.id)
      : !String(section.body ?? '').trim()))
    .map((section) => section.label);
  if (!(note.sections ?? []).length && !String(note.body ?? '').trim()) missing.push('Nothing written');
  return missing;
}

export function composeBody(sections: NoteSection[]): string {
  return sections
    .map((section) => `${section.label}\n${section.kind === 'body_chart' ? 'See linked body-chart evidence.' : String(section.body ?? '').trim() || '—'}`)
    .join('\n\n')
    .trim();
}

export function noteSummary(note: NoteDoc, opts?: { includeBody?: boolean }) {
  const base = {
    id: note.id,
    clientId: note.clientId,
    bookingId: note.bookingId,
    title: note.title,
    status: note.status,
    version: note.version,
    revision: note.revision,
    templateId: note.templateId,
    templateName: note.templateName,
    templateVersionId: note.templateVersionId,
    templateVersion: note.templateVersion,
    signedHash: note.signedHash,
    lastFinalisedVersion: note.lastFinalisedVersion,
    draftedBy: note.draftedBy,
    authorName: note.authorName,
    signerName: note.signerName,
    signedAt: note.signedAt,
    amendedAt: note.amendedAt,
    archivedAt: note.archivedAt,
    /** The call this was written up from, when it came off one. */
    sourceCallId: note.sourceCallId,
    retentionUntil: note.retentionUntil,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    incomplete: incompleteSections(note),
    sectionLabels: (note.sections ?? []).map((s) => s.label),
    attachmentCount: (note.attachments as NoteAttachment[] | undefined)?.length ?? 0,
    versionCount: (note.versions ?? []).length,
  };
  if (!opts?.includeBody) return base;
  return { ...base, body: note.body, sections: note.sections, attachments: note.attachments ?? [], versions: note.versions ?? [] };
}

/* ------------------------------------------------------------------- writes */

export type NoteWrite =
  | { ok: true; note: NoteDoc }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'FINALISED' | 'INCOMPLETE' | 'VALIDATION_ERROR' | 'CONFLICT';
      error: string;
      missing?: string[];
      conflictId?: string;
    };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function snapshotEvidence(snapshot: Omit<ClinicalNoteVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'> | ClinicalNoteVersionDoc) {
  return {
    id: snapshot.id,
    orgId: snapshot.orgId,
    noteId: snapshot.noteId,
    clientId: snapshot.clientId,
    version: snapshot.version,
    title: snapshot.title,
    sections: snapshot.sections,
    body: snapshot.body,
    templateId: snapshot.templateId,
    templateVersionId: snapshot.templateVersionId,
    templateVersion: snapshot.templateVersion,
    signerId: snapshot.signerId,
    signerName: snapshot.signerName,
    signedAt: snapshot.signedAt,
    reason: snapshot.reason,
    previousHash: snapshot.previousHash,
    bodyCharts: snapshot.bodyCharts,
  };
}

function contentHash(snapshot: Omit<ClinicalNoteVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'> | ClinicalNoteVersionDoc) {
  return crypto.createHash('sha256').update(canonical(snapshotEvidence(snapshot))).digest('hex');
}

export function verifyClinicalNoteVersion(snapshot: ClinicalNoteVersionDoc): boolean {
  return /^[a-f0-9]{64}$/.test(String(snapshot.contentHash ?? '')) && contentHash(snapshot) === snapshot.contentHash;
}

export function noteDraftConflicts(orgId: string, noteId: string): NoteDraftConflictDoc[] {
  return list<NoteDraftConflictDoc>('clinicalNoteDraftConflicts', (row) => row.orgId === orgId && row.noteId === noteId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function preserveLosingDraft(input: {
  orgId: string;
  note: NoteDoc;
  expectedRevision: number;
  title: string;
  sections: NoteSection[];
  body: string;
  actor: string;
  actorName?: string;
}): NoteDraftConflictDoc {
  const occurredAt = nowIso();
  const draft = {
    id: newId('nconf_'),
    orgId: input.orgId,
    noteId: input.note.id,
    clientId: input.note.clientId,
    expectedRevision: input.expectedRevision,
    title: input.title,
    sections: input.sections,
    body: input.body,
    actorId: input.actor,
    actorName: input.actorName,
    occurredAt,
    createdAt: occurredAt,
  } as NoteDraftConflictDoc;
  return commitBatch({
    upserts: [{ collection: 'clinicalNoteDraftConflicts', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }],
  }).upserts[0] as NoteDraftConflictDoc;
}

export function createNote(input: {
  orgId: string;
  clientId: string;
  bookingId?: string;
  serviceId?: string;
  providerId?: string;
  templateId?: string;
  title?: string;
  sections?: NoteSection[];
  body?: string;
  draftedBy?: 'agent' | 'staff' | 'seed';
  sourceCallId?: string;
  actor: string;
  actorName?: string;
}): NoteWrite {
  const client = clientById(input.orgId, input.clientId);
  if (!client) return { ok: false, code: 'VALIDATION_ERROR', error: 'A note belongs to a client record. That client does not exist in this workspace.' };

  const template = noteTemplateFor(input.orgId, { serviceId: input.serviceId, templateId: input.templateId });
  if (input.templateId && !template) return { ok: false, code: 'VALIDATION_ERROR', error: 'That clinical note template does not exist in this workspace.' };
  const frozen = template ? currentNoteTemplateVersion(input.orgId, template.id) : undefined;
  if (template && !frozen) return { ok: false, code: 'VALIDATION_ERROR', error: 'That clinical note template has no immutable current version.' };
  const service = input.serviceId ? serviceById(input.orgId, input.serviceId) : undefined;
  const supplied = new Map((input.sections ?? []).map((section) => [section.id, section]));
  const schema = frozen?.sections ?? template?.sections ?? templateSections('generic', service?.name);
  const sections: NoteSection[] = input.sections && !template
    ? input.sections.map((section) => ({ ...section }))
    : schema.map((section) => ({
        id: section.id,
        label: section.label,
        body: section.kind === 'body_chart' ? '' : String(supplied.get(section.id)?.body ?? ''),
        kind: section.kind,
        required: section.required,
        hint: section.prompt,
      }));
  const at = nowIso();
  const draft = {
    id: newId('note_'),
    orgId: input.orgId,
    clientId: input.clientId,
    bookingId: input.bookingId,
    serviceId: input.serviceId ?? service?.id,
    providerId: input.providerId,
    templateId: template?.id,
    templateName: frozen?.name ?? template?.name,
    templateVersionId: frozen?.id,
    templateVersion: frozen?.version,
    title: input.title ?? `${client.name} — ${at.slice(0, 10)}`,
    status: 'draft' as const,
    body: input.body ?? composeBody(sections),
    sections,
    version: 1,
    versions: [],
    revision: 0,
    draftedBy: input.draftedBy ?? 'staff',
    sourceCallId: input.sourceCallId,
    authorId: input.actor,
    authorName: input.actorName,
    createdAt: at,
    updatedAt: at,
  } as NoteDoc;
  let note: NoteDoc;
  try {
    note = commitBatch({
      upserts: [{ collection: 'notes', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }],
    }).upserts[0] as NoteDoc;
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That note id was created concurrently. Try opening a new draft again.' };
    throw error;
  }

  audit({ orgId: input.orgId, actor: input.actor, action: 'note.created', target: note.id, detail: `${note.title} (${note.draftedBy}) · template ${note.templateVersionId ?? 'none'}` });
  recordAccess({
    orgId: input.orgId,
    resource: 'note',
    resourceId: note.id,
    action: 'create',
    actor: input.actor,
    actorName: input.actorName,
    detail: `draft from ${template?.name ?? 'no template'}${input.draftedBy === 'agent' ? ' — dictated by the agent, unsigned' : ''}`,
  });
  return { ok: true, note: normaliseNote(note) };
}

/** Draft text uses an explicit revision. A losing edit is retained, never merged. */
export function updateNote(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  patch: { title?: string; sections?: NoteSection[]; body?: string };
  actor: string;
  actorName?: string;
}): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { ok: false, code: 'VALIDATION_ERROR', error: 'Saving clinical text requires the revision you reviewed.' };
  }
  if (note.status === 'final') {
    return { ok: false, code: 'FINALISED', error: 'This note is finalised. A signed note is not edited — amend it, which keeps this version and starts the next.' };
  }
  if (note.status === 'archived') return { ok: false, code: 'VALIDATION_ERROR', error: 'This note is archived. Restore it before editing.' };

  let sections = note.sections;
  if (input.patch.sections) {
    const incoming = new Map(input.patch.sections.map((section) => [section.id, section]));
    const idsMatch = input.patch.sections.length === note.sections.length && note.sections.every((section) => incoming.has(section.id));
    if (!idsMatch) return { ok: false, code: 'VALIDATION_ERROR', error: 'A note keeps the section schema it opened with. Save text against those same stable section ids.' };
    sections = note.sections.map((section) => ({ ...section, body: section.kind === 'body_chart' ? '' : String(incoming.get(section.id)?.body ?? '') }));
  }
  const title = input.patch.title ?? note.title;
  const body = input.patch.body ?? composeBody(sections);
  try {
    const next = commitBatch({ upserts: [{
      collection: 'notes',
      doc: { ...note, title, sections, body } as NoteDoc,
      expectedRevision: input.expectedRevision,
      expectedOrgId: input.orgId,
    }] }).upserts[0] as NoteDoc;
    audit({ orgId: input.orgId, actor: input.actor, action: 'note.edited', target: note.id, detail: `${incompleteSections(next).length ? 'still incomplete' : 'complete'} · revision ${next.revision}` });
    recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `v${next.version} draft edited at revision ${next.revision}` });
    return { ok: true, note: normaliseNote(next) };
  } catch (error) {
    if (!(error instanceof CommitConflictError)) throw error;
    const conflict = preserveLosingDraft({ orgId: input.orgId, note, expectedRevision: input.expectedRevision, title, sections, body, actor: input.actor, actorName: input.actorName });
    audit({ orgId: input.orgId, actor: input.actor, action: 'note.conflict_preserved', target: note.id, detail: `${conflict.id}; expected revision ${input.expectedRevision}` });
    return { ok: false, code: 'CONFLICT', conflictId: conflict.id, error: 'This note changed while you were editing it. Both drafts were kept; a clinician must choose which text becomes the record.' };
  }
}

export function resolveNoteDraftConflict(input: {
  orgId: string;
  noteId: string;
  conflictId: string;
  resolution: 'keep_current' | 'use_conflict';
  expectedRevision: number;
  actor: string;
  actorName?: string;
}): NoteWrite {
  const note = noteById(input.orgId, input.noteId);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.noteId}.` };
  if (note.status !== 'draft') return { ok: false, code: 'FINALISED', error: 'Only a draft can reconcile concurrent clinical text.' };
  const conflict = get<NoteDraftConflictDoc>('clinicalNoteDraftConflicts', input.conflictId);
  if (!conflict || conflict.orgId !== input.orgId || conflict.noteId !== note.id) return { ok: false, code: 'NOT_FOUND', error: 'That preserved draft no longer exists.' };
  if (input.resolution !== 'keep_current' && input.resolution !== 'use_conflict') return { ok: false, code: 'VALIDATION_ERROR', error: 'Choose either the current draft or the preserved concurrent draft.' };
  const chosen = input.resolution === 'use_conflict'
    ? { ...note, title: conflict.title, sections: conflict.sections, body: conflict.body }
    : note;
  try {
    const result = commitBatch({
      upserts: [{ collection: 'notes', doc: chosen, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }],
      deletes: [{ collection: 'clinicalNoteDraftConflicts', id: conflict.id, expectedRevision: conflict.revision, expectedOrgId: input.orgId }],
    });
    const next = result.upserts[0] as NoteDoc;
    audit({ orgId: input.orgId, actor: input.actor, action: 'note.conflict_resolved', target: note.id, detail: `${input.resolution}; ${conflict.id}` });
    return { ok: true, note: normaliseNote(next) };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'The note changed again before reconciliation completed. Reload both drafts and choose explicitly.' };
    throw error;
  }
}

export function finaliseNote(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  signerId: string;
  signerName?: string;
  actor: string;
}): NoteWrite {
  return withEntityLock('clinical-note', `${input.orgId}:${input.id}`, () => finaliseNoteUnlocked(input));
}

function finaliseNoteUnlocked(input: {
  orgId: string;
  id: string;
  expectedRevision: number;
  signerId: string;
  signerName?: string;
  actor: string;
}): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'Signing requires the exact revision the clinician reviewed.' };
  if (note.status === 'final') return { ok: false, code: 'FINALISED', error: 'This note is already finalised.' };
  if (note.status === 'archived') return { ok: false, code: 'VALIDATION_ERROR', error: 'This note is archived.' };
  const conflicts = noteDraftConflicts(input.orgId, note.id);
  if (conflicts.length) return { ok: false, code: 'CONFLICT', error: 'This note has preserved concurrent text. Reconcile it explicitly before signing.' };
  const missing = incompleteSections(note);
  if (missing.length) return { ok: false, code: 'INCOMPLETE', error: `This note is not finished: ${missing.join(', ')}.`, missing };

  const previous = list<ClinicalNoteVersionDoc>('clinicalNoteVersions', (row) => row.orgId === input.orgId && row.noteId === note.id)
    .sort((a, b) => b.version - a.version)[0];
  if (previous && !verifyClinicalNoteVersion(previous)) return { ok: false, code: 'CONFLICT', error: 'Existing signed note evidence failed SHA-256 verification. Do not extend the chain until it is investigated.' };
  const signedAt = nowIso();
  let charts: ReturnType<typeof prepareBodyChartsForFinalisation>;
  try {
    charts = prepareBodyChartsForFinalisation({
      orgId: input.orgId,
      noteId: note.id,
      noteVersion: note.version,
      signedAt,
      signerId: input.signerId,
      signerName: input.signerName,
    });
  } catch (error) {
    return { ok: false, code: 'CONFLICT', error: error instanceof Error ? error.message : 'Body-chart annotations must be reconciled before signing.' };
  }
  const unsigned = {
    id: `${note.id}_signed_v${note.version}`,
    orgId: input.orgId,
    noteId: note.id,
    clientId: note.clientId,
    version: note.version,
    title: note.title,
    sections: note.sections,
    body: note.body,
    templateId: note.templateId,
    templateVersionId: note.templateVersionId,
    templateVersion: note.templateVersion,
    signerId: input.signerId,
    signerName: input.signerName,
    signedAt,
    reason: previous ? 'amended' as const : 'finalised' as const,
    previousHash: previous?.contentHash,
    bodyCharts: charts.evidence,
  };
  const hash = contentHash(unsigned as Omit<ClinicalNoteVersionDoc, 'contentHash' | 'revision' | 'createdAt' | 'updatedAt'>);
  const snapshot = { ...unsigned, contentHash: hash, createdAt: signedAt } as ClinicalNoteVersionDoc;
  const nextDraft = {
    ...note,
    status: 'final' as const,
    signerId: input.signerId,
    signerName: input.signerName,
    signedAt,
    signedHash: hash,
    lastFinalisedVersion: note.version,
  } as NoteDoc;
  try {
    const result = commitBatch({ upserts: [
      { collection: 'notes', doc: nextDraft, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      { collection: 'clinicalNoteVersions', doc: snapshot, expectedRevision: null, expectedOrgId: input.orgId },
      ...charts.writes,
    ] });
    const next = result.upserts.find((row) => row.id === note.id) as NoteDoc;
    audit({ orgId: input.orgId, actor: input.actor, action: 'note.finalised', target: note.id, detail: `v${next.version} signed by ${input.signerName ?? input.signerId}; SHA-256 ${hash}` });
    recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'update', actor: input.actor, actorName: input.signerName, detail: `v${next.version} finalised; ${hash}` });
    return { ok: true, note: normaliseNote(next) };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'This note or one of its body charts changed before the signature committed. Nothing was signed; reload and review the current revision.' };
    throw error;
  }
}

export function amendNote(input: { orgId: string; id: string; expectedRevision: number; reason: string; actor: string; actorName?: string }): NoteWrite {
  return withEntityLock('clinical-note', `${input.orgId}:${input.id}`, () => amendNoteUnlocked(input));
}

function amendNoteUnlocked(input: { orgId: string; id: string; expectedRevision: number; reason: string; actor: string; actorName?: string }): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  if (note.status !== 'final') return { ok: false, code: 'VALIDATION_ERROR', error: 'Only a finalised note is amended — a draft is simply edited.' };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'An amendment needs a reason. A note that changed without one is the thing records systems exist to prevent.' };
  const chartWrites = prepareBodyChartsForAmendment({ orgId: input.orgId, noteId: note.id, nextNoteVersion: note.version + 1 });
  try {
    const result = commitBatch({ upserts: [{
      collection: 'notes',
      doc: { ...note, status: 'draft', version: note.version + 1, amendedAt: nowIso(), amendedReason: reason } as NoteDoc,
      expectedRevision: input.expectedRevision,
      expectedOrgId: input.orgId,
    }, ...chartWrites] });
    const next = result.upserts.find((row) => row.id === note.id) as NoteDoc;
    audit({ orgId: input.orgId, actor: input.actor, action: 'note.amended', target: note.id, detail: `v${note.version} reopened as v${next.version}: ${reason}` });
    recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `v${note.version} signed snapshot kept; v${next.version} opened — ${reason}` });
    return { ok: true, note: normaliseNote(next) };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'This note changed before the amendment opened. Reload its signed evidence and try again.' };
    throw error;
  }
}

/** Every cryptographically signed snapshot, plus untouched legacy signed history. */
export function versionHistory(orgId: string, id: string): NoteVersion[] {
  const note = noteById(orgId, id);
  if (!note) return [];
  const signed = list<ClinicalNoteVersionDoc>('clinicalNoteVersions', (row) => row.orgId === orgId && row.noteId === id).map((row) => ({
    version: row.version,
    sections: row.sections,
    body: row.body,
    at: row.signedAt,
    by: row.signerId,
    byName: row.signerName,
    reason: row.reason,
    templateId: row.templateId,
    templateVersionId: row.templateVersionId,
    templateVersion: row.templateVersion,
    previousHash: row.previousHash,
    bodyCharts: row.bodyCharts,
    contentHash: row.contentHash,
    integrity: verifyClinicalNoteVersion(row) ? 'verified' as const : 'failed' as const,
  }));
  const signedNumbers = new Set(signed.map((row) => row.version));
  const legacy = (note.versions ?? []).filter((row) => !signedNumbers.has(row.version)).map((row) => ({ ...row, integrity: 'legacy_unhashed' as const }));
  return [...signed, ...legacy].sort((a, b) => b.version - a.version);
}

export function archiveNote(input: { orgId: string; id: string; reason?: string; actor: string; actorName?: string }): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  const retentionUntil = DEFAULT_RETENTION_DAYS === null
    ? undefined
    : new Date(Date.now() + DEFAULT_RETENTION_DAYS * 86_400_000).toISOString();
  const retentionPolicySource = retentionUntil ? 'environment' as const : undefined;
  const next = update<NoteDoc>('notes', note.id, {
    status: 'archived',
    archivedAt: nowIso(),
    archivedBy: input.actor,
    retentionUntil,
    retentionPolicySource,
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'note.archived', target: note.id, detail: input.reason ?? 'archived' });
  const retentionDetail = retentionUntil
    ? `kept until ${retentionUntil.slice(0, 10)}`
    : 'automatic purge disabled until an operator retention policy is configured';
  recordAccess({
    orgId: input.orgId,
    resource: 'note',
    resourceId: note.id,
    action: 'archive',
    actor: input.actor,
    actorName: input.actorName,
    detail: `${retentionDetail}${input.reason ? ` — ${input.reason}` : ''}`,
  });
  return { ok: true, note: next };
}

export function restoreNote(input: { orgId: string; id: string; actor: string; actorName?: string }): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  const next = update<NoteDoc>('notes', note.id, {
    status: note.signedAt ? 'final' : 'draft',
    archivedAt: undefined,
    archivedBy: undefined,
    retentionUntil: undefined,
    retentionPolicySource: undefined,
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'note.restored', target: note.id, detail: `back as ${next.status}` });
  recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'restore', actor: input.actor, actorName: input.actorName });
  return { ok: true, note: next };
}

export function attachToNote(input: {
  orgId: string;
  id: string;
  name: string;
  bytes: number;
  contentType?: string;
  sha256?: string;
  actor: string;
  actorName?: string;
}): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  if (note.status === 'archived') return { ok: false, code: 'VALIDATION_ERROR', error: 'This note is archived.' };
  const name = String(input.name ?? '').trim();
  const bytes = Number(input.bytes ?? 0);
  if (!name) return { ok: false, code: 'VALIDATION_ERROR', error: 'An attachment needs a name.' };
  if (!bytes || bytes <= 0) return { ok: false, code: 'VALIDATION_ERROR', error: 'An attachment needs a size in bytes.' };
  if (bytes > 100 * 1024 * 1024) return { ok: false, code: 'VALIDATION_ERROR', error: 'Attachments are capped at 100 MB.' };

  const existing = (note.attachments as NoteAttachment[] | undefined) ?? [];
  const attachment: NoteAttachment = {
    id: newId('att_'),
    name,
    bytes,
    contentType: input.contentType,
    sha256: input.sha256,
    at: nowIso(),
    by: input.actor,
    byName: input.actorName,
  };
  const next = update<NoteDoc>('notes', note.id, {
    attachments: [...existing, attachment],
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'note.attachment_added', target: note.id, detail: `${name} (${bytes} bytes)` });
  recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `attached ${name}` });
  return { ok: true, note: next };
}

export function detachFromNote(input: { orgId: string; id: string; attachmentId: string; actor: string; actorName?: string }): NoteWrite {
  const note = noteById(input.orgId, input.id);
  if (!note) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  const current = (note.attachments as NoteAttachment[] | undefined) ?? [];
  const gone = current.find((a) => a.id === input.attachmentId);
  if (!gone) return { ok: false, code: 'NOT_FOUND', error: `No attachment ${input.attachmentId} on this note.` };
  const next = update<NoteDoc>('notes', note.id, {
    attachments: current.filter((a) => a.id !== input.attachmentId),
    updatedAt: nowIso(),
  });
  if (!next) return { ok: false, code: 'NOT_FOUND', error: `No note with id ${input.id}.` };
  audit({ orgId: input.orgId, actor: input.actor, action: 'note.attachment_removed', target: note.id, detail: gone.name });
  recordAccess({ orgId: input.orgId, resource: 'note', resourceId: note.id, action: 'update', actor: input.actor, actorName: input.actorName, detail: `removed ${gone.name}` });
  return { ok: true, note: next };
}

/** Records that somebody opened it. The client route does this for client records. */
export function recordNoteRead(input: { orgId: string; note: NoteDoc; actor: string; actorName?: string }) {
  recordAccess({
    orgId: input.orgId,
    resource: 'note',
    resourceId: input.note.id,
    action: 'view',
    actor: input.actor,
    actorName: input.actorName,
    detail: `v${input.note.version} ${input.note.status}`,
  });
  appendClinicalAccessEvent({
    orgId: input.orgId,
    resourceType: 'clinical_note',
    resourceId: input.note.id,
    patientId: input.note.clientId,
    action: 'view',
    actorId: input.actor,
    actorLabel: input.actorName,
    purpose: 'direct_care',
  });
}

/* ------------------------------------------------------------- the agent's door */

/**
 * The write-up a booking call leaves behind.
 *
 * Called when a call that was about an appointment ends (see `calls.ts`): the
 * agent drafts what happened, tied to the appointment and the client, and leaves
 * it unsigned. Once per call — a second end (a retry, a backfill) must not file a
 * second note — and never for a call where nobody spoke, because "no answer" is
 * not an encounter.
 *
 * This is the *only* place the platform writes a note by itself, and it always
 * writes the same thing: a draft. When the agent already drafted mid-call — with
 * the call's summary not yet written — the summary is filled in here, on the
 * draft, and the note still goes nowhere near a signature.
 */
export function ensureDraftNoteForCall(input: {
  orgId: string;
  callId: string;
  bookingId?: string;
  clientId?: string;
  serviceId?: string;
  providerId?: string;
  summary?: string;
}): NoteDoc | undefined {
  const existing = list<NoteDoc>('notes', (n) => n.orgId === input.orgId && n.sourceCallId === input.callId)[0];
  if (existing) {
    // The agent often drafts *during* the call — before the call's own summary is
    // written — so that draft can be empty of detail. When the call ends, fill it
    // in. A signed note is never touched, and a draft a person has already
    // written in is left exactly as they left it.
    const text = String(existing.body ?? '').trim();
    const thin = !text || /^Summary\n(No details were captured on the call\.?)?$/.test(text);
    const summary = String(input.summary ?? '').trim();
    if (existing.status === 'draft' && thin && summary) {
      const next = update<NoteDoc>('notes', existing.id, {
        body: `Summary\n${summary}`,
        sections: (existing.sections ?? []).map((sec, i) => (i === 0 && !String(sec.body ?? '').trim() ? { ...sec, body: summary } : sec)),
        updatedAt: nowIso(),
      });
      if (next) {
        audit({ orgId: input.orgId, actor: 'agent', action: 'note.edited', target: existing.id, detail: 'call summary added when the call ended' });
        recordAccess({
          orgId: input.orgId,
          resource: 'note',
          resourceId: existing.id,
          action: 'update',
          actor: 'agent',
          actorName: 'AI receptionist',
          detail: 'the call ended — the summary was filled in, the note is still unsigned',
        });
      }
    }
    return undefined;
  }
  if (!input.clientId) return undefined;
  const drafted = draftNoteFromCall({
    orgId: input.orgId,
    clientId: input.clientId,
    bookingId: input.bookingId,
    serviceId: input.serviceId,
    providerId: input.providerId,
    callId: input.callId,
    summary: input.summary,
    actor: 'agent',
    actorName: 'AI receptionist',
  });
  return drafted.ok ? drafted.note : undefined;
}

/**
 * The agent's draft, from a call.
 *
 * Deliberately the *only* thing the agent can do with a note: write a draft that
 * says it was the agent's, with the call attached, and leave the signature to a
 * person. Everything a model is good at (writing down what was said, in order,
 * without getting bored) and nothing it must not do (deciding the record is
 * done).
 */
export function draftNoteFromCall(input: {
  orgId: string;
  clientId: string;
  bookingId?: string;
  serviceId?: string;
  providerId?: string;
  callId?: string;
  /** What the agent understood: section bodies keyed by section id, or a paragraph. */
  content?: Record<string, string>;
  summary?: string;
  actor?: string;
  actorName?: string;
}): NoteWrite {
  const template = noteTemplateFor(input.orgId, { serviceId: input.serviceId });
  const sections = (template?.sections ?? templateSections('generic')).map((s) => ({
    id: s.id,
    label: s.label,
    body: String(input.content?.[s.id] ?? '').trim(),
    required: s.required,
    hint: s.prompt,
  }));
  const filled = sections.some((s) => s.body);
  const body = filled
    ? composeBody(sections)
    : `Summary\n${String(input.summary ?? '').trim() || 'No details were captured on the call.'}`;

  return createNote({
    orgId: input.orgId,
    clientId: input.clientId,
    bookingId: input.bookingId,
    serviceId: input.serviceId,
    providerId: input.providerId,
    templateId: template?.id,
    sections: filled ? sections : sections.map((s) => ({ ...s, body: s.id === 'summary' ? String(input.summary ?? '').trim() : '' })),
    body,
    draftedBy: 'agent',
    sourceCallId: input.callId,
    actor: input.actor ?? 'agent',
    actorName: input.actorName ?? 'AI receptionist',
  });
}
