import { audit } from '../audit';
import {
  CommitConflictError,
  commitBatch,
  get,
  list,
  newId,
  nowIso,
  type Doc,
} from '../db';

export type ClinicalTemplateSection = {
  id: string;
  label: string;
  prompt?: string;
  required?: boolean;
  kind?: 'short_text' | 'long_text' | 'number' | 'choice' | 'body_chart';
  options?: string[];
};

export type VersionedNoteTemplateDoc = Doc & {
  orgId: string;
  name: string;
  serviceId?: string;
  sections: ClinicalTemplateSection[];
  active: boolean;
  state: 'draft' | 'published' | 'retired';
  currentVersion: number;
  currentVersionId: string;
  revision: number;
  createdAt: string;
  updatedAt?: string;
};

export type NoteTemplateVersionDoc = Doc & {
  orgId: string;
  templateId: string;
  version: number;
  name: string;
  serviceId?: string;
  sections: ClinicalTemplateSection[];
  state: VersionedNoteTemplateDoc['state'];
  changeReason: string;
  provenance: 'seed' | 'legacy_migration' | 'staff';
  authoredBy?: string;
  authoredByName?: string;
  createdAt: string;
  revision: number;
};

export type TemplateWrite =
  | { ok: true; template: VersionedNoteTemplateDoc; version: NoteTemplateVersionDoc }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string };

function cleanSections(value: unknown): ClinicalTemplateSection[] {
  if (!Array.isArray(value)) return [];
  const rows = value.map((raw) => {
    const section = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const kind = String(section.kind ?? 'long_text');
    return {
      id: String(section.id ?? '').trim(),
      label: String(section.label ?? '').trim(),
      ...(String(section.prompt ?? '').trim() ? { prompt: String(section.prompt).trim() } : {}),
      ...(section.required === true ? { required: true } : section.required === false ? { required: false } : {}),
      ...(kind === 'short_text' || kind === 'number' || kind === 'choice' || kind === 'body_chart' ? { kind } : { kind: 'long_text' as const }),
      ...(Array.isArray(section.options) ? { options: section.options.map(String).map((item) => item.trim()).filter(Boolean) } : {}),
    } satisfies ClinicalTemplateSection;
  });
  return rows;
}

function validate(name: string, sections: ClinicalTemplateSection[]): string | undefined {
  if (!name.trim()) return 'A clinical note template needs a name.';
  if (name.trim().length > 160) return 'A clinical note template name is limited to 160 characters.';
  if (!sections.length) return 'A clinical note template needs at least one section.';
  if (sections.length > 80) return 'A clinical note template is limited to 80 sections.';
  const ids = new Set<string>();
  for (const section of sections) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(section.id)) return 'Every section needs a stable id using lowercase letters, numbers and underscores.';
    if (ids.has(section.id)) return `Section id ${section.id} is repeated. Stable ids must be unique.`;
    ids.add(section.id);
    if (!section.label || section.label.length > 160) return `Section ${section.id} needs a heading of at most 160 characters.`;
    if ((section.prompt?.length ?? 0) > 600) return `The prompt for ${section.label} is limited to 600 characters.`;
    if (section.kind === 'choice' && !(section.options?.length)) return `Choice section ${section.label} needs at least one option.`;
    if (section.kind === 'body_chart' && section.options?.length) return `Body-chart section ${section.label} cannot carry text-choice options.`;
  }
  return undefined;
}

function envelope(row: Doc): VersionedNoteTemplateDoc {
  const state = row.state === 'draft' || row.state === 'retired' ? row.state : 'published';
  const currentVersion = Math.max(1, Number(row.currentVersion ?? 1) || 1);
  return {
    ...row,
    orgId: String(row.orgId ?? ''),
    name: String(row.name ?? 'Clinical note template'),
    serviceId: row.serviceId ? String(row.serviceId) : undefined,
    sections: cleanSections(row.sections),
    active: row.active !== false && state !== 'retired',
    state,
    currentVersion,
    currentVersionId: String(row.currentVersionId ?? `${row.id}_v${currentVersion}`),
    revision: Math.max(1, Number(row.revision ?? 1) || 1),
    createdAt: String(row.createdAt ?? nowIso()),
  } as VersionedNoteTemplateDoc;
}

/**
 * JSON-store compatibility and defence in depth for a pre-012 database.
 * SQL stores are upgraded by migration 012 before this module is called. This
 * path gives the recovery-only JSON engine the same immutable version model.
 */
function ensureVersioned(row: Doc): VersionedNoteTemplateDoc {
  const normal = envelope(row);
  const existing = get<NoteTemplateVersionDoc>('noteTemplateVersions', normal.currentVersionId);
  if (row.currentVersion && row.currentVersionId && existing) return normal;

  const versionId = `${row.id}_v1`;
  const createdAt = String(row.createdAt ?? nowIso());
  const version = {
    id: versionId,
    orgId: normal.orgId,
    templateId: row.id,
    version: 1,
    name: normal.name,
    serviceId: normal.serviceId,
    sections: normal.sections,
    state: normal.active ? 'published' as const : 'retired' as const,
    changeReason: 'Imported from the legacy clinical template record',
    provenance: 'legacy_migration' as const,
    createdAt,
  } as NoteTemplateVersionDoc;
  const next = {
    ...row,
    name: normal.name,
    sections: normal.sections,
    state: version.state,
    active: normal.active,
    currentVersion: 1,
    currentVersionId: versionId,
  } as VersionedNoteTemplateDoc;
  try {
    const writes = [] as Array<{ collection: string; doc: Doc; expectedRevision: number | null; expectedOrgId: string }>;
    if (!existing) writes.push({ collection: 'noteTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: normal.orgId });
    writes.push({ collection: 'noteTemplates', doc: next, expectedRevision: Number(row.revision ?? 0), expectedOrgId: normal.orgId });
    const result = commitBatch({ upserts: writes });
    return envelope(result.upserts.at(-1) ?? next);
  } catch (error) {
    if (!(error instanceof CommitConflictError)) throw error;
    const raced = get<Doc>('noteTemplates', row.id);
    return envelope(raced ?? row);
  }
}

export function noteTemplatesV2(orgId: string, options?: { includeRetired?: boolean }): VersionedNoteTemplateDoc[] {
  return list<Doc>('noteTemplates', (row) => row.orgId === orgId && (options?.includeRetired || row.active !== false))
    .map(ensureVersioned)
    .filter((row) => options?.includeRetired || row.state !== 'retired');
}

export function noteTemplateByIdV2(orgId: string, id: string): VersionedNoteTemplateDoc | undefined {
  const row = get<Doc>('noteTemplates', id);
  return row && row.orgId === orgId ? ensureVersioned(row) : undefined;
}

export function noteTemplateVersions(orgId: string, templateId: string): NoteTemplateVersionDoc[] {
  return list<NoteTemplateVersionDoc>('noteTemplateVersions', (row) => row.orgId === orgId && row.templateId === templateId)
    .sort((a, b) => b.version - a.version);
}

export function noteTemplateVersionById(orgId: string, id: string): NoteTemplateVersionDoc | undefined {
  const row = get<NoteTemplateVersionDoc>('noteTemplateVersions', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function currentNoteTemplateVersion(orgId: string, templateId: string): NoteTemplateVersionDoc | undefined {
  const template = noteTemplateByIdV2(orgId, templateId);
  return template ? noteTemplateVersionById(orgId, template.currentVersionId) : undefined;
}

export function createNoteTemplate(input: {
  orgId: string;
  name: string;
  serviceId?: string;
  sections: unknown;
  state?: VersionedNoteTemplateDoc['state'];
  changeReason?: string;
  actorId?: string;
  actorName?: string;
  provenance?: NoteTemplateVersionDoc['provenance'];
}): TemplateWrite {
  const name = String(input.name ?? '').trim();
  const sections = cleanSections(input.sections);
  const problem = validate(name, sections);
  if (problem) return { ok: false, code: 'VALIDATION_ERROR', error: problem };
  const state = input.state === 'draft' || input.state === 'retired' ? input.state : 'published';
  const templateId = newId('ntpl_');
  const versionId = `${templateId}_v1`;
  const at = nowIso();
  const template = {
    id: templateId,
    orgId: input.orgId,
    name,
    serviceId: input.serviceId,
    sections,
    state,
    active: state !== 'retired',
    currentVersion: 1,
    currentVersionId: versionId,
    createdAt: at,
  } as VersionedNoteTemplateDoc;
  const version = {
    id: versionId,
    orgId: input.orgId,
    templateId,
    version: 1,
    name,
    serviceId: input.serviceId,
    sections,
    state,
    changeReason: String(input.changeReason ?? 'Initial template').trim() || 'Initial template',
    provenance: input.provenance ?? 'staff',
    authoredBy: input.actorId,
    authoredByName: input.actorName,
    createdAt: at,
  } as NoteTemplateVersionDoc;
  try {
    const result = commitBatch({ upserts: [
      { collection: 'noteTemplates', doc: template, expectedRevision: null, expectedOrgId: input.orgId },
      { collection: 'noteTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    ] });
    const savedTemplate = result.upserts.find((row) => row.id === templateId) as VersionedNoteTemplateDoc;
    const savedVersion = result.upserts.find((row) => row.id === versionId) as NoteTemplateVersionDoc;
    audit({ orgId: input.orgId, actor: input.actorId ?? 'system', action: 'note_template.created', target: templateId, detail: `${name} v1` });
    return { ok: true, template: savedTemplate, version: savedVersion };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That template was created concurrently. Reload and try again.' };
    throw error;
  }
}

export function reviseNoteTemplate(input: {
  orgId: string;
  templateId: string;
  expectedRevision: number;
  name?: string;
  serviceId?: string;
  sections: unknown;
  state?: VersionedNoteTemplateDoc['state'];
  changeReason: string;
  actorId: string;
  actorName?: string;
}): TemplateWrite {
  const current = noteTemplateByIdV2(input.orgId, input.templateId);
  if (!current) return { ok: false, code: 'NOT_FOUND', error: `No clinical note template with id ${input.templateId}.` };
  const name = String(input.name ?? current.name).trim();
  const sections = cleanSections(input.sections);
  const problem = validate(name, sections);
  if (problem) return { ok: false, code: 'VALIDATION_ERROR', error: problem };
  const reason = String(input.changeReason ?? '').trim();
  if (!reason) return { ok: false, code: 'VALIDATION_ERROR', error: 'Describe why this immutable template version is changing.' };
  const state = input.state === 'draft' || input.state === 'retired' || input.state === 'published' ? input.state : current.state;
  const number = current.currentVersion + 1;
  const versionId = `${current.id}_v${number}`;
  const at = nowIso();
  const next = {
    ...current,
    name,
    serviceId: input.serviceId ?? current.serviceId,
    sections,
    state,
    active: state !== 'retired',
    currentVersion: number,
    currentVersionId: versionId,
  } as VersionedNoteTemplateDoc;
  const version = {
    id: versionId,
    orgId: input.orgId,
    templateId: current.id,
    version: number,
    name,
    serviceId: next.serviceId,
    sections,
    state,
    changeReason: reason,
    provenance: 'staff' as const,
    authoredBy: input.actorId,
    authoredByName: input.actorName,
    createdAt: at,
  } as NoteTemplateVersionDoc;
  try {
    const result = commitBatch({ upserts: [
      { collection: 'noteTemplates', doc: next, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId },
      { collection: 'noteTemplateVersions', doc: version, expectedRevision: null, expectedOrgId: input.orgId },
    ] });
    const savedTemplate = result.upserts.find((row) => row.id === current.id) as VersionedNoteTemplateDoc;
    const savedVersion = result.upserts.find((row) => row.id === versionId) as NoteTemplateVersionDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'note_template.revised', target: current.id, detail: `v${number}: ${reason}` });
    return { ok: true, template: savedTemplate, version: savedVersion };
  } catch (error) {
    if (error instanceof CommitConflictError) {
      return { ok: false, code: 'CONFLICT', error: 'This template changed while you were editing it. No version was overwritten; reload and create a new revision.' };
    }
    throw error;
  }
}
