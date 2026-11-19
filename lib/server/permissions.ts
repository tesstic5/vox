/** Granular workspace permissions with record/caseload scope and legacy shadowing. */

import crypto from 'node:crypto';
import { commitBatch, find, list, newId, nowIso, type Doc } from './db';
import type { UserDoc } from './auth';
import { outboxDraft } from './domain-outbox';

export const PERMISSIONS = [
  'workspace.read',
  'workspace.write',
  'workspace.configure',
  'workspace.owner',
  'team.read',
  'team.manage',
  'roles.read',
  'roles.manage',
  'clients.read',
  'clients.write',
  'clients.export',
  'clients.merge',
  'cases.read',
  'cases.write',
  'coverage.sensitive.read',
  'coverage.sensitive.write',
  'funding.override',
  'schedule.read',
  'schedule.write',
  'schedule.configure',
  'communications.read',
  'communications.write',
  'clinical.read',
  'clinical.write',
  'clinical.export',
  'clinical.finalize',
  'clinical.alerts.read',
  'clinical.alerts.write',
  'clinical.documents.read',
  'clinical.documents.write',
  'clinical.documents.download',
  'clinical.documents.export',
  'forms.read',
  'forms.manage',
  'forms.assign',
  'forms.review',
  'referrals.read',
  'referrals.write',
  'referrals.triage',
  'letters.read',
  'letters.write',
  'letters.approve',
  'letters.send',
  'tasks.read',
  'tasks.write',
  'automations.read',
  'automations.manage',
  'privacy.read',
  'privacy.manage',
  'privacy.holds.manage',
  'clinical.live.activate',
  'money.read',
  'money.write',
  'money.take',
  'reports.read',
  'audit.read',
  'audit.export',
  'field.read',
  'field.write',
  'field.coordinate',
  'developer.read',
  'developer.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type LegacyRole = UserDoc['role'];
export type RecordScope = 'all' | 'caseload' | 'explicit' | 'none';
export type ScopeArea = 'clients' | 'cases' | 'clinical' | 'documents' | 'schedule';

export type RoleDoc = Doc & {
  orgId: string;
  key: string;
  name: string;
  description?: string;
  permissions: Permission[];
  scopes: Partial<Record<ScopeArea, RecordScope>>;
  system: boolean;
  legacyBaseRole: LegacyRole;
  archivedAt?: string;
  revision: number;
};

export type CaseloadAssignmentDoc = Doc & {
  orgId: string;
  patientId: string;
  userId?: string;
  providerId?: string;
  caseId?: string;
  kind: 'primary' | 'secondary' | 'administrative';
  startsAt?: string;
  endsAt?: string;
  createdBy?: string;
  endedBy?: string;
  revision: number;
};

export type ExplicitRecordGrantDoc = Doc & {
  orgId: string;
  patientId: string;
  userId: string;
  area: ScopeArea;
  reason?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdBy?: string;
  revision: number;
};

export type AccessGrantDoc = Doc & {
  orgId: string;
  userId: string;
  resourceType: 'patient';
  resourceId: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  approvedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
  notifiedRecipients: string[];
  revision: number;
};

const ALL = [...PERMISSIONS];
const CONFIG: Permission[] = [
  'workspace.read', 'workspace.write', 'workspace.configure', 'team.read', 'team.manage', 'roles.read', 'roles.manage',
  'clients.read', 'clients.write', 'clients.export', 'clients.merge', 'cases.read', 'cases.write',
  'coverage.sensitive.read', 'coverage.sensitive.write', 'funding.override', 'schedule.read', 'schedule.write', 'schedule.configure',
  'communications.read', 'communications.write', 'clinical.read', 'clinical.write', 'clinical.export', 'clinical.finalize',
  'clinical.alerts.read', 'clinical.alerts.write', 'clinical.documents.read', 'clinical.documents.write',
  'clinical.documents.download', 'clinical.documents.export', 'forms.read', 'forms.manage', 'forms.assign', 'forms.review',
  'referrals.read', 'referrals.write', 'referrals.triage', 'letters.read', 'letters.write', 'letters.approve', 'letters.send',
  'tasks.read', 'tasks.write', 'automations.read', 'automations.manage', 'privacy.read', 'privacy.manage', 'privacy.holds.manage',
  'money.read', 'money.write', 'money.take', 'reports.read', 'audit.read', 'audit.export', 'field.read', 'field.write',
  'field.coordinate', 'developer.read', 'developer.manage',
];

export const LEGACY_ROLE_PERMISSIONS: Record<LegacyRole, readonly Permission[]> = {
  owner: ALL,
  admin: CONFIG,
  developer: CONFIG,
  receptionist: [
    'workspace.read', 'workspace.write', 'team.read', 'clients.read', 'clients.write', 'clients.export',
    'cases.read', 'cases.write', 'schedule.read', 'schedule.write', 'communications.read', 'communications.write',
    'forms.read', 'forms.assign', 'referrals.read', 'referrals.write', 'letters.read', 'letters.write', 'letters.send',
    'tasks.read', 'tasks.write', 'money.read', 'money.take', 'reports.read', 'field.read', 'field.write', 'field.coordinate',
  ],
  practitioner: [
    'workspace.read', 'workspace.write', 'team.read', 'clients.read', 'cases.read', 'cases.write',
    'coverage.sensitive.read', 'coverage.sensitive.write', 'schedule.read', 'schedule.write',
    'communications.read', 'clinical.read', 'clinical.write', 'clinical.finalize', 'clinical.alerts.read',
    'clinical.alerts.write', 'clinical.documents.read', 'clinical.documents.write', 'clinical.documents.download',
    'forms.read', 'forms.manage', 'forms.assign', 'forms.review', 'referrals.read', 'referrals.write', 'referrals.triage',
    'letters.read', 'letters.write', 'letters.approve', 'letters.send', 'tasks.read', 'tasks.write', 'money.read', 'reports.read', 'field.read', 'field.write',
  ],
  viewer: ['workspace.read', 'team.read', 'clients.read', 'cases.read', 'schedule.read', 'communications.read', 'tasks.read', 'money.read', 'reports.read', 'field.read'],
};

const ROLE_LABELS: Record<LegacyRole, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  developer: 'Developer',
  receptionist: 'Reception',
  practitioner: 'Practitioner',
  viewer: 'Read-only viewer',
};

export function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(String(value));
}

export function systemRoleId(orgId: string, role: LegacyRole) {
  return `role_${crypto.createHash('sha256').update(`${orgId}:${role}`).digest('hex').slice(0, 32)}`;
}

export function systemRoleTemplate(orgId: string, role: LegacyRole): RoleDoc {
  return {
    id: systemRoleId(orgId, role),
    orgId,
    key: `system:${role}`,
    name: ROLE_LABELS[role],
    description: `Compatibility template for the existing ${role} role.`,
    permissions: [...LEGACY_ROLE_PERMISSIONS[role]],
    scopes: { clients: 'all', cases: 'all', clinical: 'all', documents: 'all', schedule: 'all' },
    system: true,
    legacyBaseRole: role,
    revision: 0,
    createdAt: nowIso(),
  };
}

/** Idempotent migration; system roles are inserted but never overwrite controller edits. */
export function ensureSystemRoles(orgId: string): RoleDoc[] {
  const existing = list<RoleDoc>('roles', (role) => role.orgId === orgId && role.system && !role.archivedAt);
  const byKey = new Map(existing.map((role) => [role.key, role]));
  const result: RoleDoc[] = [];
  for (const legacy of Object.keys(LEGACY_ROLE_PERMISSIONS) as LegacyRole[]) {
    const template = systemRoleTemplate(orgId, legacy);
    const found = byKey.get(template.key);
    if (found) {
      result.push(found);
      continue;
    }
    try {
      result.push(commitBatch({ upserts: [{ collection: 'roles', doc: template, expectedRevision: null, expectedOrgId: orgId }] }).upserts[0] as RoleDoc);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
      const raced = find<RoleDoc>('roles', (role) => role.id === template.id && role.orgId === orgId);
      if (raced) result.push(raced);
    }
  }
  return result;
}

/**
 * Migration-only reconciliation when the central permission catalogue expands.
 * System templates are controller-read-only, so updating them to the code-owned
 * compatibility mapping cannot overwrite a customer-authored role.
 */
export function reconcileSystemRoleTemplates(orgId: string) {
  ensureSystemRoles(orgId);
  let updated = 0;
  const roles: RoleDoc[] = [];
  for (const legacy of Object.keys(LEGACY_ROLE_PERMISSIONS) as LegacyRole[]) {
    const template = systemRoleTemplate(orgId, legacy);
    const existing = find<RoleDoc>('roles', (role) => role.id === template.id && role.orgId === orgId && role.system);
    if (!existing) continue;
    const currentShape = JSON.stringify({
      key: existing.key, name: existing.name, description: existing.description,
      permissions: existing.permissions, scopes: existing.scopes, legacyBaseRole: existing.legacyBaseRole,
    });
    const desiredShape = JSON.stringify({
      key: template.key, name: template.name, description: template.description,
      permissions: template.permissions, scopes: template.scopes, legacyBaseRole: template.legacyBaseRole,
    });
    if (currentShape === desiredShape) {
      roles.push(existing);
      continue;
    }
    const saved = commitBatch({ upserts: [{
      collection: 'roles',
      doc: { ...existing, ...template, id: existing.id, orgId, createdAt: existing.createdAt },
      expectedRevision: Number(existing.revision ?? 0),
      expectedOrgId: orgId,
    }] }).upserts[0] as RoleDoc;
    roles.push(saved);
    updated += 1;
  }
  return { roles: roles.length, updated };
}

export function rolesFor(orgId: string, options: { includeSystem?: boolean; includeArchived?: boolean } = {}): RoleDoc[] {
  if (options.includeSystem !== false) ensureSystemRoles(orgId);
  return list<RoleDoc>(
    'roles',
    (role) => role.orgId === orgId && (options.includeSystem !== false || !role.system) && (options.includeArchived || !role.archivedAt),
  ).sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name));
}

export type PermissionResource = {
  area?: ScopeArea;
  patientId?: string;
  providerId?: string;
  assignedUserIds?: string[];
};

export type PermissionDecision = {
  allowed: boolean;
  permission: Permission;
  source: 'legacy' | 'role' | 'missing-role' | 'scope' | 'break-glass';
  roleId?: string;
  scope?: RecordScope;
  reason?: string;
};

function roleForUser(user: UserDoc): RoleDoc | undefined {
  const roleId = String(user.roleId ?? '');
  if (!roleId) return undefined;
  return find<RoleDoc>('roles', (role) => role.id === roleId && role.orgId === user.orgId && !role.archivedAt);
}

export function recordScopeFor(user: UserDoc, area: ScopeArea): RecordScope {
  if (!user.roleId) return 'all';
  return roleForUser(user)?.scopes[area] ?? 'none';
}

function areaForPermission(permission: Permission): ScopeArea | undefined {
  if (permission.startsWith('clients.')) return 'clients';
  if (permission.startsWith('cases.') || permission.startsWith('coverage.') || permission.startsWith('funding.')) return 'cases';
  if (permission.startsWith('clinical.documents.')) return 'documents';
  if (permission.startsWith('clinical.')) return 'clinical';
  if (permission.startsWith('schedule.')) return 'schedule';
  return undefined;
}

export function activeAccessGrantFor(orgId: string, userId: string, patientId: string, at = Date.now()): AccessGrantDoc | undefined {
  return list<AccessGrantDoc>(
    'accessGrants',
    (grant) => grant.orgId === orgId && grant.userId === userId && grant.resourceType === 'patient' && grant.resourceId === patientId &&
      !grant.revokedAt && Date.parse(grant.startsAt) <= at && Date.parse(grant.expiresAt) > at,
  ).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
}

function scopeAllows(user: UserDoc, area: ScopeArea, scope: RecordScope, resource?: PermissionResource): boolean {
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  const patientId = resource?.patientId;
  if (!patientId) return false;
  if (scope === 'explicit') {
    return list<ExplicitRecordGrantDoc>(
      'recordGrants',
      (grant) =>
        grant.orgId === user.orgId && grant.userId === user.id && grant.patientId === patientId && grant.area === area && !grant.revokedAt &&
        (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()),
    ).length > 0;
  }
  if (resource?.assignedUserIds?.includes(user.id)) return true;
  return list<CaseloadAssignmentDoc>(
    'caseloadAssignments',
    (assignment) =>
      assignment.orgId === user.orgId && assignment.patientId === patientId && assignment.userId === user.id &&
      (!assignment.startsAt || Date.parse(assignment.startsAt) <= Date.now()) &&
      (!assignment.endsAt || Date.parse(assignment.endsAt) > Date.now()),
  ).length > 0;
}

export function permissionDecision(user: UserDoc, permission: Permission, resource?: PermissionResource): PermissionDecision {
  const customId = String(user.roleId ?? '');
  if (!customId) {
    const allowed = LEGACY_ROLE_PERMISSIONS[user.role].includes(permission);
    return { allowed, permission, source: 'legacy', reason: allowed ? undefined : `${user.role} does not include ${permission}` };
  }
  const role = roleForUser(user);
  if (!role) return { allowed: false, permission, source: 'missing-role', roleId: customId, reason: 'assigned role is missing or archived' };
  if (!role.permissions.includes(permission)) {
    return { allowed: false, permission, source: 'role', roleId: role.id, reason: `${role.name} does not include ${permission}` };
  }
  const area = resource?.area ?? areaForPermission(permission);
  if (!area || !resource?.patientId) return { allowed: true, permission, source: 'role', roleId: role.id };
  const scope = role.scopes[area] ?? 'none';
  const allowed = scopeAllows(user, area, scope, resource);
  if (!allowed && resource?.patientId && activeAccessGrantFor(user.orgId, user.id, resource.patientId)) {
    return { allowed: true, permission, source: 'break-glass', roleId: role.id, scope, reason: 'active, time-limited emergency access grant' };
  }
  return {
    allowed,
    permission,
    source: allowed ? 'role' : 'scope',
    roleId: role.id,
    scope,
    reason: allowed ? undefined : `${role.name} has ${scope} ${area} scope and this record is outside it`,
  };
}

export type PermissionShadowEventDoc = Doc & {
  orgId: string;
  userId: string;
  legacyRole: LegacyRole;
  roleId?: string;
  roleRevision?: number;
  permission: Permission;
  patientId?: string;
  legacyAllowed: boolean;
  granularAllowed: boolean;
  decisionSource: PermissionDecision['source'];
  at: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  revision: number;
};

/** Persist one disagreement per role revision/decision shape, rather than one event per request or patient. */
export function shadowPermissionDecision(user: UserDoc, permission: Permission, resource?: PermissionResource): PermissionDecision {
  const effective = permissionDecision(user, permission, resource);
  const legacy = LEGACY_ROLE_PERMISSIONS[user.role].includes(permission);
  if (legacy !== effective.allowed) {
    const assignedRole = roleForUser(user);
    const roleRevision = Number(assignedRole?.revision ?? 0);
    const shape = `${effective.source}:${effective.scope ?? '*'}:${legacy ? 1 : 0}:${effective.allowed ? 1 : 0}`;
    const id = `rbs_${crypto.createHash('sha256').update(`${user.orgId}:${user.id}:${effective.roleId ?? user.role}:${roleRevision}:${permission}:${shape}`).digest('hex').slice(0, 36)}`;
    try {
      commitBatch({
        upserts: [
          {
            collection: 'permissionShadowEvents',
            doc: {
              id,
              orgId: user.orgId,
              userId: user.id,
              legacyRole: user.role,
              roleId: user.roleId,
              roleRevision,
              permission,
              patientId: resource?.patientId,
              legacyAllowed: legacy,
              granularAllowed: effective.allowed,
              decisionSource: effective.source,
              at: nowIso(),
            } as Doc,
            expectedRevision: null,
            expectedOrgId: user.orgId,
          },
        ],
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CommitConflictError') throw error;
    }
  }
  return effective;
}

export function permissionShadowEvents(orgId: string, options: { unresolvedOnly?: boolean } = {}) {
  return list<PermissionShadowEventDoc>(
    'permissionShadowEvents',
    (event) => event.orgId === orgId && (!options.unresolvedOnly || !event.resolvedAt),
  ).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function resolvePermissionShadowEvent(input: { orgId: string; eventId: string; actorId: string; resolution: string }) {
  const event = find<PermissionShadowEventDoc>('permissionShadowEvents', (row) => row.id === input.eventId && row.orgId === input.orgId);
  if (!event) throw new Error('permission shadow event not found');
  const resolution = input.resolution.trim();
  if (resolution.length < 4 || resolution.length > 500) throw new Error('resolution must contain 4 to 500 characters');
  return commitBatch({
    upserts: [{
      collection: 'permissionShadowEvents',
      doc: { ...event, resolvedAt: nowIso(), resolvedBy: input.actorId, resolution },
      expectedRevision: Number(event.revision ?? 0), expectedOrgId: input.orgId,
    }],
  }).upserts[0] as PermissionShadowEventDoc;
}

function cleanScopes(input: Partial<Record<ScopeArea, RecordScope>> | undefined): RoleDoc['scopes'] {
  const allowed = new Set<RecordScope>(['all', 'caseload', 'explicit', 'none']);
  const result: RoleDoc['scopes'] = {};
  for (const area of ['clients', 'cases', 'clinical', 'documents', 'schedule'] as ScopeArea[]) {
    const value = input?.[area];
    if (value && allowed.has(value)) result[area] = value;
  }
  return result;
}

export function createCustomRole(input: {
  orgId: string;
  name: string;
  description?: string;
  permissions: Permission[];
  scopes?: Partial<Record<ScopeArea, RecordScope>>;
  legacyBaseRole: Exclude<LegacyRole, 'owner'>;
  actor: UserDoc;
}): RoleDoc {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new Error('role name must contain 2 to 80 characters');
  const grants = [...new Set(input.permissions.filter(isPermission))];
  const actorGrants = new Set(permissionDecision(input.actor, 'roles.manage').allowed ? effectivePermissions(input.actor) : []);
  const excess = grants.filter((permission) => !actorGrants.has(permission));
  if (excess.length) throw new Error(`cannot grant permissions the actor does not hold: ${excess.join(', ')}`);
  const at = nowIso();
  const role = {
    id: `role_${crypto.randomBytes(16).toString('hex')}`,
    orgId: input.orgId,
    key: `custom:${crypto.randomBytes(12).toString('hex')}`,
    name,
    description: input.description?.trim().slice(0, 500) || undefined,
    permissions: grants,
    scopes: cleanScopes(input.scopes),
    system: false,
    legacyBaseRole: input.legacyBaseRole,
    createdAt: at,
  } as RoleDoc;
  return commitBatch({ upserts: [{ collection: 'roles', doc: role, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as RoleDoc;
}

export function updateCustomRole(input: {
  role: RoleDoc;
  name?: string;
  description?: string;
  permissions?: Permission[];
  scopes?: Partial<Record<ScopeArea, RecordScope>>;
  actor: UserDoc;
}): RoleDoc {
  if (input.role.system) throw new Error('system role templates cannot be edited');
  const actorGrants = new Set(effectivePermissions(input.actor));
  const grants = input.permissions ? [...new Set(input.permissions.filter(isPermission))] : input.role.permissions;
  const excess = grants.filter((permission) => !actorGrants.has(permission));
  if (excess.length) throw new Error(`cannot grant permissions the actor does not hold: ${excess.join(', ')}`);
  const name = input.name === undefined ? input.role.name : input.name.trim();
  if (name.length < 2 || name.length > 80) throw new Error('role name must contain 2 to 80 characters');
  return commitBatch({
    upserts: [
      {
        collection: 'roles',
        doc: {
          ...input.role,
          name,
          description: input.description === undefined ? input.role.description : input.description.trim().slice(0, 500) || undefined,
          permissions: grants,
          scopes: input.scopes ? cleanScopes(input.scopes) : input.role.scopes,
        },
        expectedRevision: Number(input.role.revision ?? 0),
        expectedOrgId: input.role.orgId,
      },
    ],
  }).upserts[0] as RoleDoc;
}

export function effectivePermissions(user: UserDoc): Permission[] {
  const role = roleForUser(user);
  return role ? [...role.permissions] : [...LEGACY_ROLE_PERMISSIONS[user.role]];
}

export function assignCustomRole(input: { orgId: string; user: UserDoc; role: RoleDoc | null; actor: UserDoc }): UserDoc {
  if (input.user.orgId !== input.orgId || input.actor.orgId !== input.orgId) throw new Error('cross-workspace role assignment refused');
  if (!permissionDecision(input.actor, 'roles.manage').allowed) throw new Error('actor cannot manage roles');
  if (input.user.role === 'owner') throw new Error('owner access uses the protected owner system role and cannot be replaced by a custom role');
  if (input.role && (input.role.orgId !== input.orgId || input.role.system || input.role.archivedAt)) throw new Error('select an active custom role in this workspace');
  const next = {
    ...input.user,
    roleId: input.role?.id,
    role: input.role?.legacyBaseRole ?? input.user.role,
    permissionVersion: Number(input.user.permissionVersion ?? 0) + 1,
  } as UserDoc;
  return commitBatch({
    upserts: [{ collection: 'users', doc: next, expectedRevision: Number(input.user.revision ?? 0), expectedOrgId: input.orgId }],
  }).upserts[0] as UserDoc;
}

export function assignmentsForPatient(orgId: string, patientId: string, options: { includeEnded?: boolean } = {}) {
  return list<CaseloadAssignmentDoc>(
    'caseloadAssignments',
    (row) => row.orgId === orgId && row.patientId === patientId && (options.includeEnded || !row.endsAt || Date.parse(row.endsAt) > Date.now()),
  ).sort((a, b) => String(b.startsAt ?? b.createdAt).localeCompare(String(a.startsAt ?? a.createdAt)));
}

export function createCaseloadAssignment(input: {
  orgId: string;
  patientId: string;
  userId?: string;
  providerId?: string;
  caseId?: string;
  kind: CaseloadAssignmentDoc['kind'];
  actorId: string;
  startsAt?: string;
  endsAt?: string;
}) {
  if (!find<Doc & { orgId?: string }>('clients', (row) => row.id === input.patientId && row.orgId === input.orgId)) throw new Error('patient not found in this workspace');
  if (!input.userId && !input.providerId) throw new Error('userId or providerId is required');
  if (input.userId && !find<UserDoc>('users', (row) => row.id === input.userId && row.orgId === input.orgId)) throw new Error('user not found in this workspace');
  if (input.providerId && !find<Doc & { orgId?: string }>('providers', (row) => row.id === input.providerId && row.orgId === input.orgId)) throw new Error('provider not found in this workspace');
  if (!['primary', 'secondary', 'administrative'].includes(input.kind)) throw new Error('assignment kind is invalid');
  const startsAt = input.startsAt || nowIso();
  if (!Number.isFinite(Date.parse(startsAt)) || (input.endsAt && (!Number.isFinite(Date.parse(input.endsAt)) || Date.parse(input.endsAt) <= Date.parse(startsAt)))) {
    throw new Error('assignment dates are invalid');
  }
  const duplicate = list<CaseloadAssignmentDoc>('caseloadAssignments', (row) =>
    row.orgId === input.orgId && row.patientId === input.patientId && row.userId === input.userId && row.providerId === input.providerId &&
    row.kind === input.kind && (!row.endsAt || Date.parse(row.endsAt) > Date.now()),
  )[0];
  if (duplicate) return duplicate;
  const row = {
    id: newId('assign_'), orgId: input.orgId, patientId: input.patientId, userId: input.userId,
    providerId: input.providerId, caseId: input.caseId, kind: input.kind, startsAt, endsAt: input.endsAt,
    createdBy: input.actorId, createdAt: nowIso(),
  } as CaseloadAssignmentDoc;
  return commitBatch({ upserts: [{ collection: 'caseloadAssignments', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as CaseloadAssignmentDoc;
}

export function endCaseloadAssignment(input: { orgId: string; patientId: string; assignmentId: string; actorId: string; expectedRevision: number }) {
  const row = find<CaseloadAssignmentDoc>('caseloadAssignments', (item) => item.id === input.assignmentId && item.orgId === input.orgId && item.patientId === input.patientId);
  if (!row) throw new Error('assignment not found');
  if (Number(row.revision ?? 0) !== input.expectedRevision) throw new Error('assignment changed after it was loaded');
  if (row.endsAt && Date.parse(row.endsAt) <= Date.now()) return row;
  return commitBatch({ upserts: [{
    collection: 'caseloadAssignments', doc: { ...row, endsAt: nowIso(), endedBy: input.actorId },
    expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
  }] }).upserts[0] as CaseloadAssignmentDoc;
}

export function explicitRecordGrantsFor(orgId: string, patientId: string, options: { includeRevoked?: boolean } = {}) {
  return list<ExplicitRecordGrantDoc>('recordGrants', (row) => row.orgId === orgId && row.patientId === patientId && (options.includeRevoked || !row.revokedAt));
}

export function createExplicitRecordGrant(input: {
  orgId: string; patientId: string; userId: string; area: ScopeArea; reason: string; expiresAt?: string; actorId: string;
}) {
  if (!find<Doc & { orgId?: string }>('clients', (row) => row.id === input.patientId && row.orgId === input.orgId)) throw new Error('patient not found in this workspace');
  if (!find<UserDoc>('users', (row) => row.id === input.userId && row.orgId === input.orgId)) throw new Error('user not found in this workspace');
  if (!['clients', 'cases', 'clinical', 'documents', 'schedule'].includes(input.area)) throw new Error('record grant area is invalid');
  if (input.reason.trim().length < 5) throw new Error('a meaningful grant reason is required');
  if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) throw new Error('grant expiry must be in the future');
  const row = {
    id: newId('record_grant_'), orgId: input.orgId, patientId: input.patientId, userId: input.userId, area: input.area,
    reason: input.reason.trim().slice(0, 1_000), expiresAt: input.expiresAt, createdBy: input.actorId, createdAt: nowIso(),
  } as ExplicitRecordGrantDoc;
  return commitBatch({ upserts: [{ collection: 'recordGrants', doc: row, expectedRevision: null, expectedOrgId: input.orgId }] }).upserts[0] as ExplicitRecordGrantDoc;
}

export function revokeExplicitRecordGrant(input: { orgId: string; patientId: string; grantId: string; actorId: string; reason: string; expectedRevision: number }) {
  const row = find<ExplicitRecordGrantDoc>('recordGrants', (item) => item.id === input.grantId && item.orgId === input.orgId && item.patientId === input.patientId);
  if (!row) throw new Error('record grant not found');
  if (Number(row.revision ?? 0) !== input.expectedRevision) throw new Error('record grant changed after it was loaded');
  if (input.reason.trim().length < 5) throw new Error('a revocation reason is required');
  if (row.revokedAt) return row;
  return commitBatch({ upserts: [{
    collection: 'recordGrants', doc: { ...row, revokedAt: nowIso(), revokedBy: input.actorId, revokeReason: input.reason.trim().slice(0, 1_000) },
    expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
  }] }).upserts[0] as ExplicitRecordGrantDoc;
}

export function accessGrantsFor(orgId: string, options: { userId?: string; patientId?: string; activeOnly?: boolean } = {}) {
  const now = Date.now();
  return list<AccessGrantDoc>('accessGrants', (row) => row.orgId === orgId && (!options.userId || row.userId === options.userId) &&
    (!options.patientId || row.resourceId === options.patientId) &&
    (!options.activeOnly || (!row.revokedAt && Date.parse(row.startsAt) <= now && Date.parse(row.expiresAt) > now)))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

export function createAccessGrant(input: {
  orgId: string; userId: string; patientId: string; reason: string; minutes: number; maxMinutes: number;
  actorId: string; approvedBy?: string; notifiedRecipients?: string[];
}) {
  if (!find<Doc & { orgId?: string }>('clients', (row) => row.id === input.patientId && row.orgId === input.orgId)) throw new Error('patient not found in this workspace');
  if (!find<UserDoc>('users', (row) => row.id === input.userId && row.orgId === input.orgId)) throw new Error('user not found in this workspace');
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1_000) throw new Error('emergency access reason must contain 10 to 1,000 characters');
  const max = Math.max(5, Math.min(240, Math.floor(input.maxMinutes)));
  const minutes = Math.floor(input.minutes);
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > max) throw new Error(`emergency access duration must be from 5 to ${max} minutes`);
  const startsAt = nowIso();
  const recipients = [...new Set(input.notifiedRecipients ?? [])].slice(0, 20);
  const row = {
    id: newId('access_grant_'), orgId: input.orgId, userId: input.userId, resourceType: 'patient', resourceId: input.patientId,
    reason, startsAt, expiresAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    approvedBy: input.approvedBy, notifiedRecipients: recipients, createdAt: startsAt,
  } as AccessGrantDoc;
  const notification = outboxDraft({
    orgId: input.orgId,
    topic: 'security.break_glass.created',
    aggregateType: 'access_grant',
    aggregateId: row.id,
    payload: { grantId: row.id, userId: input.userId, patientId: input.patientId, startsAt, expiresAt: row.expiresAt, recipients },
  });
  const committed = commitBatch({ upserts: [
    { collection: 'accessGrants', doc: row, expectedRevision: null, expectedOrgId: input.orgId },
    { collection: 'domainOutbox', doc: notification, expectedRevision: null, expectedOrgId: input.orgId },
  ] });
  return committed.upserts.find((item) => item.id === row.id) as AccessGrantDoc;
}

export function revokeAccessGrant(input: { orgId: string; id: string; actorId: string; reason: string; expectedRevision: number }) {
  const row = find<AccessGrantDoc>('accessGrants', (item) => item.id === input.id && item.orgId === input.orgId);
  if (!row) throw new Error('access grant not found');
  if (Number(row.revision ?? 0) !== input.expectedRevision) throw new Error('access grant changed after it was loaded');
  if (input.reason.trim().length < 5) throw new Error('a revocation reason is required');
  if (row.revokedAt) return row;
  return commitBatch({ upserts: [{
    collection: 'accessGrants', doc: { ...row, revokedAt: nowIso(), revokedBy: input.actorId, revokeReason: input.reason.trim().slice(0, 1_000) },
    expectedRevision: input.expectedRevision, expectedOrgId: input.orgId,
  }] }).upserts[0] as AccessGrantDoc;
}

/** Coarse route policy used as a backstop for custom roles on legacy endpoints. */
export function permissionForHttpRequest(pathname: string, method: string): Permission {
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const path = pathname.replace(/\/+$/, '');
  if (/\/api\/v1\/roles(?:\/|$)/.test(path)) return read ? 'roles.read' : 'roles.manage';
  if (/\/api\/v1\/team(?:\/|$)/.test(path)) return read ? 'team.read' : 'team.manage';
  if (/\/api\/v1\/privacy(?:\/|$)/.test(path)) return read ? 'privacy.read' : 'privacy.manage';
  if (/\/api\/v1\/(?:documents|clinical-documents)(?:\/|$)/.test(path)) return read ? 'clinical.documents.read' : 'clinical.documents.write';
  if (/\/api\/v1\/(?:notes|note-templates|body-chart-templates|patient-alerts|care-plans|encounters|clinical)(?:\/|$)/.test(path)) return read ? 'clinical.read' : 'clinical.write';
  if (/\/api\/v1\/clients\/[^/]+\/coverages(?:\/|$)/.test(path)) return read ? 'cases.read' : 'cases.write';
  if (/\/api\/v1\/(?:cases|payers|authorisations)(?:\/|$)/.test(path)) return read ? 'cases.read' : 'cases.write';
  if (/\/api\/v1\/clients(?:\/|$)/.test(path)) return read ? 'clients.read' : 'clients.write';
  if (/\/api\/v1\/(?:bookings|classes|day|wait-list|series|availability|rota|rooms|locations|services|providers)(?:\/|$)/.test(path)) {
    return read ? 'schedule.read' : path.includes('/rota') || path.includes('/rooms') || path.includes('/locations') || path.includes('/services') || path.includes('/providers')
      ? 'schedule.configure'
      : 'schedule.write';
  }
  if (/\/api\/v1\/(?:invoices|payments|money|packs|client-packs|expenses)(?:\/|$)/.test(path)) return read ? 'money.read' : 'money.write';
  if (/\/api\/v1\/(?:messages|outreach|recalls|calls|numbers|carriers)(?:\/|$)/.test(path)) return read ? 'communications.read' : 'communications.write';
  if (/\/api\/v1\/(?:enquiries|estimates|jobs|visits|dispatch)(?:\/|$)/.test(path)) return read ? 'field.read' : 'field.write';
  if (/\/api\/v1\/(?:audit)(?:\/|$)/.test(path)) return 'audit.read';
  if (/\/api\/v1\/(?:reports)(?:\/|$)/.test(path)) return 'reports.read';
  if (/\/api\/v1\/(?:keys|webhooks|tools|ai|assistants|files)(?:\/|$)/.test(path)) return read ? 'developer.read' : 'developer.manage';
  return read ? 'workspace.read' : 'workspace.write';
}
