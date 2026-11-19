import { audit } from './audit';
import { caseById } from './cases';
import { clientById } from './clients';
import { CommitConflictError, commitBatch, get, list, newId, type Doc } from './db';

export type CarePlanDoc = Doc & {
  orgId: string;
  patientId: string;
  caseId?: string;
  title: string;
  status: 'draft' | 'active' | 'on_hold' | 'completed' | 'closed';
  reviewOn?: string;
  authoredBy: string;
  authoredByName?: string;
  updatedBy: string;
  provenance: 'clinician_authored';
  revision: number;
};

export type CarePlanGoalDoc = Doc & {
  orgId: string;
  carePlanId: string;
  patientId: string;
  caseId?: string;
  goal: string;
  actions: string[];
  status: 'planned' | 'active' | 'achieved' | 'stopped';
  reviewOn?: string;
  authoredBy: string;
  authoredByName?: string;
  updatedBy: string;
  provenance: 'clinician_authored';
  revision: number;
};

export type CarePlanWrite<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT'; error: string };

const plainText = (value: unknown, max: number) => {
  const text = String(value ?? '').trim();
  return text && text.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? text : undefined;
};
const isoDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : undefined;
};

function validateOwner(orgId: string, patientId: string, caseId?: string) {
  const patient = clientById(orgId, patientId);
  if (!patient || patient.archivedAt) return 'The care-plan patient does not exist or is archived.';
  if (caseId) {
    const caseRow = caseById(orgId, caseId);
    if (!caseRow || caseRow.patientId !== patientId) return 'The selected case does not belong to this care-plan patient.';
  }
  return undefined;
}

export function carePlanById(orgId: string, id: string) {
  const row = get<CarePlanDoc>('carePlans', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function carePlansForPatient(orgId: string, patientId: string, includeClosed = true) {
  return list<CarePlanDoc>('carePlans', (row) => row.orgId === orgId && row.patientId === patientId && (includeClosed || row.status !== 'closed'))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
}

export function goalsForCarePlan(orgId: string, carePlanId: string) {
  return list<CarePlanGoalDoc>('carePlanGoals', (row) => row.orgId === orgId && row.carePlanId === carePlanId)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
}

export function createCarePlan(input: {
  orgId: string; patientId: string; caseId?: string; title: string; status?: CarePlanDoc['status']; reviewOn?: string;
  actorId: string; actorName?: string;
}): CarePlanWrite<CarePlanDoc> {
  const ownerError = validateOwner(input.orgId, input.patientId, input.caseId);
  if (ownerError) return { ok: false, code: 'VALIDATION_ERROR', error: ownerError };
  const title = plainText(input.title, 240);
  const reviewOn = input.reviewOn ? isoDate(input.reviewOn) : undefined;
  const status = input.status ?? 'draft';
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', error: 'A care plan needs clinician-authored text of at most 240 characters.' };
  if (input.reviewOn && !reviewOn) return { ok: false, code: 'VALIDATION_ERROR', error: 'The review date must be a real ISO date.' };
  if (!['draft', 'active', 'on_hold', 'completed', 'closed'].includes(status)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Care-plan status is invalid.' };
  const draft: CarePlanDoc = {
    id: newId('cpl_'), orgId: input.orgId, patientId: input.patientId, caseId: input.caseId || undefined,
    title, status, reviewOn, authoredBy: input.actorId, authoredByName: input.actorName,
    updatedBy: input.actorId, provenance: 'clinician_authored', revision: 0,
  };
  const saved = commitBatch({ upserts: [{ collection: 'carePlans', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CarePlanDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'care_plan.created', target: saved.id, detail: `${saved.patientId}; ${saved.status}` });
  return { ok: true, value: saved };
}

export function updateCarePlan(input: {
  orgId: string; id: string; expectedRevision: number;
  patch: Partial<Pick<CarePlanDoc, 'caseId' | 'title' | 'status' | 'reviewOn'>>;
  actorId: string;
}): CarePlanWrite<CarePlanDoc> {
  const existing = carePlanById(input.orgId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'That care plan does not exist.' };
  if (existing.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed care plan is read-only. Create a new plan rather than rewriting its history.' };
  const merged = { ...existing, ...input.patch };
  const ownerError = validateOwner(input.orgId, existing.patientId, merged.caseId);
  if (ownerError) return { ok: false, code: 'VALIDATION_ERROR', error: ownerError };
  const title = plainText(merged.title, 240);
  const reviewOn = merged.reviewOn ? isoDate(merged.reviewOn) : undefined;
  if (!title) return { ok: false, code: 'VALIDATION_ERROR', error: 'A care plan needs clinician-authored text of at most 240 characters.' };
  if (merged.reviewOn && !reviewOn) return { ok: false, code: 'VALIDATION_ERROR', error: 'The review date must be a real ISO date.' };
  if (!['draft', 'active', 'on_hold', 'completed', 'closed'].includes(merged.status)) return { ok: false, code: 'VALIDATION_ERROR', error: 'Care-plan status is invalid.' };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'carePlans', doc: { ...existing, caseId: merged.caseId || undefined, title, status: merged.status, reviewOn, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as CarePlanDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'care_plan.updated', target: saved.id, detail: `${existing.status} → ${saved.status}; revision ${saved.revision}` });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That care plan changed. Keep your text, reload the other version and reconcile explicitly.' };
    throw error;
  }
}

function goalShape(input: { goal: unknown; actions: unknown; status?: unknown; reviewOn?: unknown }) {
  const goal = plainText(input.goal, 4_000);
  const actionsInput = Array.isArray(input.actions) ? input.actions : [];
  if (!goal) return { error: 'A goal needs clinician-authored text of at most 4,000 characters.' } as const;
  if (actionsInput.length > 50) return { error: 'A goal is limited to 50 clinician-authored actions.' } as const;
  const actions: string[] = [];
  for (const value of actionsInput) {
    const action = plainText(value, 2_000);
    if (!action) return { error: 'Each care-plan action must be text of at most 2,000 characters.' } as const;
    actions.push(action);
  }
  const status = String(input.status ?? 'planned') as CarePlanGoalDoc['status'];
  const reviewOn = input.reviewOn ? isoDate(input.reviewOn) : undefined;
  if (!['planned', 'active', 'achieved', 'stopped'].includes(status)) return { error: 'Goal status is invalid.' } as const;
  if (input.reviewOn && !reviewOn) return { error: 'The goal review date must be a real ISO date.' } as const;
  return { value: { goal, actions, status, reviewOn } } as const;
}

export function createCarePlanGoal(input: {
  orgId: string; carePlanId: string; goal: string; actions: string[]; status?: CarePlanGoalDoc['status']; reviewOn?: string;
  actorId: string; actorName?: string;
}): CarePlanWrite<CarePlanGoalDoc> {
  const plan = carePlanById(input.orgId, input.carePlanId);
  if (!plan) return { ok: false, code: 'NOT_FOUND', error: 'That care plan does not exist.' };
  if (plan.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'A closed care plan cannot receive new goals.' };
  const shape = goalShape(input);
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  const draft: CarePlanGoalDoc = {
    id: newId('cpg_'), orgId: input.orgId, carePlanId: plan.id, patientId: plan.patientId, caseId: plan.caseId,
    ...shape.value, authoredBy: input.actorId, authoredByName: input.actorName,
    updatedBy: input.actorId, provenance: 'clinician_authored', revision: 0,
  };
  const saved = commitBatch({ upserts: [{ collection: 'carePlanGoals', doc: draft, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CarePlanGoalDoc;
  audit({ orgId: input.orgId, actor: input.actorId, action: 'care_plan.goal_created', target: saved.id, detail: plan.id });
  return { ok: true, value: saved };
}

export function updateCarePlanGoal(input: {
  orgId: string; id: string; expectedRevision: number;
  patch: Partial<Pick<CarePlanGoalDoc, 'goal' | 'actions' | 'status' | 'reviewOn'>>;
  actorId: string;
}): CarePlanWrite<CarePlanGoalDoc> {
  const existing = get<CarePlanGoalDoc>('carePlanGoals', input.id);
  if (!existing || existing.orgId !== input.orgId) return { ok: false, code: 'NOT_FOUND', error: 'That care-plan goal does not exist.' };
  const plan = carePlanById(input.orgId, existing.carePlanId);
  if (!plan) return { ok: false, code: 'NOT_FOUND', error: 'The parent care plan does not exist.' };
  if (plan.status === 'closed') return { ok: false, code: 'CONFLICT', error: 'Goals on a closed care plan are read-only.' };
  const shape = goalShape({ ...existing, ...input.patch });
  if (!shape.value) return { ok: false, code: 'VALIDATION_ERROR', error: shape.error };
  try {
    const saved = commitBatch({ upserts: [{ collection: 'carePlanGoals', doc: { ...existing, ...shape.value, updatedBy: input.actorId }, expectedRevision: input.expectedRevision, expectedOrgId: input.orgId }] }).upserts[0] as CarePlanGoalDoc;
    audit({ orgId: input.orgId, actor: input.actorId, action: 'care_plan.goal_updated', target: saved.id, detail: `${existing.status} → ${saved.status}; revision ${saved.revision}` });
    return { ok: true, value: saved };
  } catch (error) {
    if (error instanceof CommitConflictError) return { ok: false, code: 'CONFLICT', error: 'That goal changed. Keep your text, reload the other version and reconcile explicitly.' };
    throw error;
  }
}
