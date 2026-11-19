/**
 * Client records.
 *
 * The people your practice books. Deliberately the *same* record whether they
 * arrived through a phone call, an import, or a receptionist typing them in —
 * which is why the dedupe key is the phone number: the AI receptionist only
 * ever has a number to go on, and a second "Jane Smith" created by a booking
 * is how a practice ends up with two histories for one person.
 *
 * Two field groups are enforced rather than decorative (PRACTICE.md §5):
 *
 *   - **alerts** — medical flags ("anticoagulants", "severe nut allergy"). The
 *     diary and the agent surface them before treating the appointment as
 *     ordinary.
 *   - **consents** — sms, email, recording. Absence of a grant blocks the
 *     channel and says why, instead of silently not sending.
 *
 * Deletion is soft: records are archived, not immediately removed. A
 * `retentionUntil` exists only when an operator configured a retention policy;
 * otherwise the maintenance sweep preserves the archived record.
 */

import { commitBatch, list, update, type Doc } from './db';
import { audit } from './audit';
import { recordAccess } from './access-log';
import { legacyContactDrafts, resolveExactIdentity } from './patient-identity';
import {
  cleanLegacyAddress,
  formatStructuredAddress,
  reviewStructuredAddress,
  structuredAddressFromLegacy,
  type StructuredAddress,
  type StructuredAddressInput,
} from '../addresses';

export type ConsentChannel = 'sms' | 'email' | 'recording';

export type ConsentState = {
  granted: boolean;
  /** Where the answer came from: `booking`, `staff`, `caller`, `import`. */
  source?: string;
  at?: string;
  note?: string;
};

export type ClientAlert = {
  id: string;
  label: string;
  detail?: string;
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
};

export type ClientDoc = Doc & {
  orgId: string;
  /** Display name, as the practice says it out loud. */
  name: string;
  firstName?: string;
  lastName?: string;
  /** Normalised to `+` and digits — the dedupe key. */
  number: string;
  email?: string;
  dateOfBirth?: string;
  /** Compatibility display string retained for older API/export consumers. */
  address?: string;
  /** Explicitly reviewed components; legacy text is never parsed automatically. */
  structuredAddress?: StructuredAddress;
  tags: string[];
  alerts: ClientAlert[];
  /** `staff`, `call`, `import`, `public-booking`, `waitlist` — how they arrived. */
  source?: string;
  consents: Record<ConsentChannel, ConsentState>;
  /** Admin note about the client (not a clinical note — those are `notes`). */
  note?: string;
  /** Set when the record is archived. Archived records keep their history. */
  archivedAt?: string;
  archivedBy?: string;
  /** After this instant, an archived record may be purged. Absent means preserve. */
  retentionUntil?: string;
  /** Evidence that the purge date came from an operator policy. */
  retentionPolicySource?: 'environment' | 'explicit';
  /** Appointments ever booked, maintained on write (cheap, and makes the list useful). */
  appointmentCount?: number;
  lastAppointmentAt?: string;
  /** Last time they rang, were called, or booked — whichever is latest. */
  lastInteractionAt?: string;
  /** A neutral holding record used when an exact contact match is ambiguous. */
  identityReviewRequired?: boolean;
  identityConflictId?: string;
  identityClaimedNumber?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Retention is an operator/legal decision, not a product guess. With no explicit
 * environment value, archived records are preserved and no purge date is set.
 */
const configuredRetention = Number(process.env.VOXERA_RECORD_RETENTION_DAYS ?? '');
export const DEFAULT_RETENTION_DAYS: number | null =
  Number.isInteger(configuredRetention) && configuredRetention > 0 && configuredRetention <= 36_500
    ? configuredRetention
    : null;

export function normaliseNumber(raw: string): string {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits.replace(/\+/g, '');
}

export function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function emptyConsents(source: string, have: { sms: boolean; email: boolean }): Record<ConsentChannel, ConsentState> {
  const at = new Date().toISOString();
  return {
    // A confirmation about the appointment they just booked is transactional;
    // a number handed over to be booked is what makes it permissible. Anything
    // else (marketing, reminders beyond the booking) needs the box ticked.
    sms: { granted: have.sms, source, at },
    email: { granted: have.email, source, at },
    // Recording is never implied by handing over a phone number.
    recording: { granted: false, source: 'default', at },
  };
}

/* ------------------------------------------------------------------- reads */

export function clientsFor(
  orgId: string,
  opts?: { includeArchived?: boolean; query?: string; tag?: string; alertOnly?: boolean; limit?: number }
): ClientDoc[] {
  const needle = (opts?.query ?? '').trim().toLowerCase();
  const digits = needle.replace(/[^\d]/g, '');
  const rows = list<ClientDoc>('clients', (c) => {
    if (c.orgId !== orgId) return false;
    if (!opts?.includeArchived && c.archivedAt) return false;
    if (opts?.tag && !(c.tags ?? []).includes(opts.tag)) return false;
    if (opts?.alertOnly && !(c.alerts ?? []).length) return false;
    if (!needle) return true;
    return (
      c.name.toLowerCase().includes(needle) ||
      (c.email ?? '').toLowerCase().includes(needle) ||
      (digits.length >= 3 && c.number.replace(/[^\d]/g, '').includes(digits)) ||
      (c.tags ?? []).some((t) => t.toLowerCase().includes(needle))
    );
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return opts?.limit ? rows.slice(0, opts.limit) : rows;
}

export function clientById(orgId: string, id: string): ClientDoc | undefined {
  const doc = list<ClientDoc>('clients', (c) => c.id === id && c.orgId === orgId)[0];
  return doc;
}

export function findClientByNumber(orgId: string, number: string): ClientDoc | undefined {
  const wanted = normaliseNumber(number);
  if (!wanted) return undefined;
  const match = resolveExactIdentity(orgId, 'phone', wanted);
  // Exact values link automatically only when one patient owns the value. An
  // ambiguous household/shared number enters review and returns no patient — we
  // never pick the first row and attach somebody else's history.
  if (match.status !== 'unique') return undefined;
  return list<ClientDoc>('clients', (client) => client.orgId === orgId && client.id === match.patientId && !client.archivedAt)[0]
    ?? list<ClientDoc>('clients', (client) => client.orgId === orgId && client.id === match.patientId)[0];
}

export function clientStatsFor(all: ClientDoc[]) {
  const withAlerts = all.filter((c) => (c.alerts ?? []).length).length;
  const optedOut = all.filter((c) => c.consents?.sms && c.consents.sms.granted === false).length;
  const newThisMonth = all.filter((c) => new Date(c.createdAt).getTime() > Date.now() - 30 * 86_400_000).length;
  const regulars = all.filter((c) => (c.appointmentCount ?? 0) >= 2).length;
  const atRisk = all.filter((c) => c.lastInteractionAt && new Date(c.lastInteractionAt).getTime() < Date.now() - 180 * 86_400_000).length;
  return { total: all.length, withAlerts, optedOut, newThisMonth, regulars, atRisk };
}

export function clientStats(orgId: string) {
  return clientStatsFor(clientsFor(orgId));
}

/** How the list labels a client. Derived, never stored — one source of truth. */
export function clientStatus(client: ClientDoc): 'new' | 'regular' | 'at-risk' | 'lapsed' | 'active' {
  const now = Date.now();
  const days = (iso?: string) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY);
  if (days(client.createdAt) <= 30) return 'new';
  if ((client.appointmentCount ?? 0) >= 2) return days(client.lastInteractionAt ?? client.lastAppointmentAt) > 365 ? 'lapsed' : 'regular';
  if (days(client.lastInteractionAt) > 180) return 'at-risk';
  return 'active';
}

/**
 * Records that the practice heard from, or reached, this person.
 *
 * Called from the call path and the booking path rather than typed in by hand:
 * a client list whose "last contact" column depends on someone remembering is
 * a column nobody trusts.
 */
export function touchClientInteraction(orgId: string, number: string, at = new Date().toISOString()): ClientDoc | undefined {
  const client = findClientByNumber(orgId, number);
  if (!client) return undefined;
  if (client.lastInteractionAt && client.lastInteractionAt >= at) return client;
  return update<ClientDoc>('clients', client.id, { lastInteractionAt: at, updatedAt: new Date().toISOString() } as never);
}

/* ------------------------------------------------------------------ writes */

export function createClient(
  orgId: string,
  input: Partial<ClientDoc> & { name: string; number: string },
  actor: string,
  opts?: { source?: string; actorName?: string; id?: string }
): ClientDoc {
  const now = new Date().toISOString();
  const number = normaliseNumber(input.number);
  const { firstName, lastName } = input.firstName || input.lastName ? { firstName: input.firstName, lastName: input.lastName } : splitName(input.name);
  const id = opts?.id ?? `cli_${Math.random().toString(36).slice(2, 12)}`;
  if (!/^cli_[A-Za-z0-9_-]{4,80}$/.test(id)) throw new Error('client id is invalid');
  const address = cleanLegacyAddress(input.address);
  const draft = {
    id,
    orgId,
    name: input.name.trim(),
    firstName,
    lastName,
    number,
    email: input.email?.trim() || undefined,
    dateOfBirth: input.dateOfBirth,
    address: input.structuredAddress ? formatStructuredAddress(input.structuredAddress, address) : address,
    structuredAddress: input.structuredAddress ?? structuredAddressFromLegacy(address),
    tags: input.tags ?? [],
    alerts: input.alerts ?? [],
    source: input.source ?? opts?.source ?? 'staff',
    lastInteractionAt: now,
    consents: input.consents ?? emptyConsents(opts?.source ?? 'staff', { sms: Boolean(number), email: Boolean(input.email) }),
    note: input.note,
    appointmentCount: 0,
    createdAt: now,
    updatedAt: now,
  } as ClientDoc;
  const contactDrafts = legacyContactDrafts({ orgId, patientId: draft.id, number, email: draft.email, source: 'staff', at: now });
  const committed = commitBatch({
    upserts: [
      { collection: 'clients', doc: draft, expectedRevision: null, expectedOrgId: orgId },
      ...contactDrafts.map((contact) => ({ collection: 'patientContactPoints', doc: contact, expectedRevision: null as null, expectedOrgId: orgId })),
    ],
  });
  const client = committed.upserts.find((row) => row.id === draft.id) as ClientDoc;

  audit({ orgId, actor, action: 'client.created', target: client.id, detail: `${client.name} ${client.number}` });
  recordAccess({ orgId, resource: 'client', resourceId: client.id, action: 'create', actor, actorName: opts?.actorName, detail: client.name });
  return client;
}

export function updateClient(
  orgId: string,
  id: string,
  patch: Partial<ClientDoc>,
  actor: string,
  opts?: { actorName?: string }
): ClientDoc | undefined {
  const existing = clientById(orgId, id);
  if (!existing) return undefined;
  const clean: Partial<ClientDoc> = { ...patch };
  const hasLegacyAddressPatch = Object.prototype.hasOwnProperty.call(patch, 'address');
  delete clean.id;
  delete clean.orgId;
  delete clean.createdAt;
  // Structured review has its own revision-checked command. Generic updates
  // cannot forge review metadata.
  delete clean.structuredAddress;
  if (hasLegacyAddressPatch) {
    clean.address = cleanLegacyAddress(patch.address);
    clean.structuredAddress = structuredAddressFromLegacy(clean.address);
  }
  if (clean.number) clean.number = normaliseNumber(clean.number);
  if (clean.name && !patch.firstName && !patch.lastName) Object.assign(clean, splitName(clean.name));

  const changed = Object.keys(clean).filter((k) => JSON.stringify((existing as never)[k]) !== JSON.stringify((clean as never)[k]));
  const at = new Date().toISOString();
  const contactWrites: Array<{ collection: string; doc: Doc; expectedRevision?: number | null; expectedOrgId: string }> = [];
  for (const kind of ['phone', 'email'] as const) {
    const field = kind === 'phone' ? 'number' : 'email';
    if (!changed.includes(field)) continue;
    const drafts = legacyContactDrafts({
      orgId,
      patientId: id,
      number: kind === 'phone' ? String(clean.number ?? '') : undefined,
      email: kind === 'email' ? String(clean.email ?? '') : undefined,
      source: 'staff',
      at,
    });
    const draft = drafts[0];
    const currentPoints = list<Doc & { orgId?: string; patientId?: string; kind?: string; normalizedValue?: string; primary?: boolean; endedAt?: string; revision?: number }>(
      'patientContactPoints',
      (point) => point.orgId === orgId && point.patientId === id && point.kind === kind && !point.endedAt,
    );
    for (const point of currentPoints.filter((point) => point.primary && (!draft || point.id !== draft.id))) {
      contactWrites.push({ collection: 'patientContactPoints', doc: { ...point, primary: false }, expectedRevision: Number(point.revision ?? 0), expectedOrgId: orgId });
    }
    if (draft) {
      const known = currentPoints.find((point) => point.id === draft.id);
      contactWrites.push({
        collection: 'patientContactPoints',
        doc: known ? { ...known, value: draft.value, normalizedValue: draft.normalizedValue, primary: true } : draft,
        expectedRevision: known ? Number(known.revision ?? 0) : null,
        expectedOrgId: orgId,
      });
    }
  }
  const result = commitBatch({
    upserts: [
      ...contactWrites,
      {
        collection: 'clients',
        doc: { ...existing, ...clean, updatedAt: at },
        expectedRevision: Number(existing.revision ?? 0),
        expectedOrgId: orgId,
      },
    ],
  });
  const client = result.upserts.find((row) => row.id === id) as ClientDoc | undefined;
  if (!client) return undefined;
  audit({ orgId, actor, action: 'client.updated', target: id, detail: changed.join(', ') || 'no change' });
  if (changed.length) recordAccess({ orgId, resource: 'client', resourceId: id, action: 'update', actor, actorName: opts?.actorName, detail: changed.join(', ') });
  return client;
}

/** Explicit staff review of a legacy or newly entered postal address. */
export function updateClientStructuredAddress(input: {
  orgId: string;
  id: string;
  address: StructuredAddressInput;
  expectedRevision: number;
  actor: string;
  actorName?: string;
}): ClientDoc {
  const existing = clientById(input.orgId, input.id);
  if (!existing) throw new Error('patient not found');
  if (Number(existing.revision ?? 0) !== input.expectedRevision) throw new Error('patient changed after it was loaded');
  const structuredAddress = reviewStructuredAddress(input.address, {
    actor: input.actor,
    existing: existing.structuredAddress,
    legacyText: existing.address,
  });
  const address = formatStructuredAddress(structuredAddress);
  const committed = commitBatch({ upserts: [{
    collection: 'clients',
    doc: { ...existing, address, structuredAddress, updatedAt: new Date().toISOString() },
    expectedRevision: input.expectedRevision,
    expectedOrgId: input.orgId,
  }] }).upserts[0] as ClientDoc;
  audit({ orgId: input.orgId, actor: input.actor, action: 'client.address_reviewed', target: input.id, detail: 'structured postal address reviewed' });
  recordAccess({
    orgId: input.orgId,
    resource: 'client',
    resourceId: input.id,
    action: 'update',
    actor: input.actor,
    actorName: input.actorName,
    detail: 'structured postal address reviewed',
  });
  return committed;
}

export function archiveClient(
  orgId: string,
  id: string,
  actor: string,
  opts?: { reason?: string; actorName?: string; retentionDays?: number | null }
): ClientDoc | undefined {
  const existing = clientById(orgId, id);
  if (!existing) return undefined;
  const now = new Date();
  const days = opts?.retentionDays === undefined ? DEFAULT_RETENTION_DAYS : opts.retentionDays;
  const retentionUntil = days === null ? undefined : new Date(now.getTime() + days * 86_400_000).toISOString();
  const retentionPolicySource = days === null ? undefined : (opts?.retentionDays === undefined ? 'environment' : 'explicit');
  const client = update<ClientDoc>('clients', id, {
    archivedAt: now.toISOString(),
    archivedBy: actor,
    retentionUntil,
    retentionPolicySource,
    updatedAt: now.toISOString(),
  } as never);
  if (!client) return undefined;
  const retentionDetail = retentionUntil
    ? `kept until ${retentionUntil.slice(0, 10)}`
    : 'automatic purge disabled until an operator retention policy is configured';
  audit({ orgId, actor, action: 'client.archived', target: id, detail: `${retentionDetail}${opts?.reason ? ` — ${opts.reason}` : ''}` });
  recordAccess({
    orgId,
    resource: 'client',
    resourceId: id,
    action: 'archive',
    actor,
    actorName: opts?.actorName,
    detail: `${retentionDetail}${opts?.reason ? ` — ${opts.reason}` : ''}`,
  });
  return client;
}

export function restoreClient(orgId: string, id: string, actor: string, actorName?: string): ClientDoc | undefined {
  const existing = clientById(orgId, id);
  if (!existing) return undefined;
  const client = update<ClientDoc>('clients', id, {
    archivedAt: undefined,
    archivedBy: undefined,
    retentionUntil: undefined,
    retentionPolicySource: undefined,
    updatedAt: new Date().toISOString(),
  } as never);
  if (!client) return undefined;
  audit({ orgId, actor, action: 'client.restored', target: id, detail: client.name });
  recordAccess({ orgId, resource: 'client', resourceId: id, action: 'restore', actor, actorName });
  return client;
}

/* --------------------------------------------------------------- consents */

export function setConsent(
  orgId: string,
  id: string,
  channel: ConsentChannel,
  granted: boolean,
  meta: { source?: string; note?: string; actor: string; actorName?: string }
): ClientDoc | undefined {
  const existing = clientById(orgId, id);
  if (!existing) return undefined;
  const consents = {
    ...existing.consents,
    [channel]: { granted, source: meta.source ?? 'staff', at: new Date().toISOString(), note: meta.note },
  } as Record<ConsentChannel, ConsentState>;
  const client = update<ClientDoc>('clients', id, { consents, updatedAt: new Date().toISOString() } as never);
  if (!client) return undefined;
  audit({
    orgId,
    actor: meta.actor,
    action: 'client.consent',
    target: id,
    detail: `${channel} ${granted ? 'granted' : 'withdrawn'} (${meta.source ?? 'staff'})`,
  });
  recordAccess({
    orgId,
    resource: 'client',
    resourceId: id,
    action: 'consent',
    actor: meta.actor,
    actorName: meta.actorName,
    detail: `${channel} ${granted ? 'granted' : 'withdrawn'}`,
  });
  return client;
}

/**
 * May we use this channel for this client?
 *
 * An unknown client is allowed for transactional checks — the caller just
 * booked and there is nobody to ask — but a client who has explicitly said no
 * is a no, whatever the reason.
 */
export function consentFor(
  orgId: string,
  clientIdOrNumber: { id?: string; number?: string } | undefined,
  channel: ConsentChannel
): { granted: boolean; reason?: string; source?: string } {
  const client = clientIdOrNumber?.id
    ? clientById(orgId, clientIdOrNumber.id)
    : clientIdOrNumber?.number
      ? findClientByNumber(orgId, clientIdOrNumber.number)
      : undefined;
  if (!client) return { granted: true, reason: 'no client record — transactional' };
  const state = client.consents?.[channel];
  if (!state) return { granted: true, reason: 'nothing recorded' };
  return state.granted
    ? { granted: true, source: state.source }
    : { granted: false, reason: `${client.name} has opted out of ${channel}`, source: state.source };
}

/* ------------------------------------------------------- booking plumbing */

/**
 * The client a booking belongs to, created if this is their first contact.
 *
 * Called from the booking write path, so *every* route into the diary — phone
 * call, dashboard, public page, sync — ends up with one client record per
 * person rather than a pile of names on appointments.
 */
export function ensureClientForBooking(
  orgId: string,
  customer: { name: string; number: string; email?: string },
  actor: string,
  /** Where the record came from, so the list can tell a walk-in from a web booking. */
  opts?: { actorName?: string; source?: string }
): ClientDoc {
  const number = normaliseNumber(customer.number);
  const identity = number ? resolveExactIdentity(orgId, 'phone', number) : undefined;
  if (identity?.status === 'ambiguous') {
    // Keep the appointment path available without choosing somebody's medical
    // record. One neutral holding record is reused for this exact conflict until
    // staff review it; it carries no active contact point and cannot be found as
    // a unique patient by the phone assistant.
    const holding = list<ClientDoc>(
      'clients',
      (client) => client.orgId === orgId && client.identityConflictId === identity.conflict.id && !client.archivedAt,
    )[0];
    if (holding) return holding;
    const unresolved = createClient(
      orgId,
      {
        name: customer.name || 'Identity review required',
        number: '',
        email: undefined,
        tags: ['identity-review'],
        source: opts?.source ?? 'booking',
        consents: emptyConsents('identity-review', { sms: false, email: false }),
      },
      actor,
      { source: opts?.source ?? 'booking', actorName: opts?.actorName },
    );
    return updateClient(orgId, unresolved.id, {
      identityReviewRequired: true,
      identityConflictId: identity.conflict.id,
      identityClaimedNumber: number,
    }, actor, { actorName: opts?.actorName }) ?? unresolved;
  }
  const existing = identity?.status === 'unique' ? findClientByNumber(orgId, number) : undefined;
  if (existing) {
    const patch: Partial<ClientDoc> = {};
    // A caller who books under a fuller name, or gives an email they had not
    // given before, improves the record — we never overwrite with a worse one.
    if (customer.name && customer.name !== 'Caller' && customer.name.length > existing.name.length && !existing.name.includes(customer.name)) {
      patch.name = customer.name;
      Object.assign(patch, splitName(customer.name));
    }
    if (customer.email && !existing.email) patch.email = customer.email;
    if (existing.archivedAt) {
      patch.archivedAt = undefined;
      patch.archivedBy = undefined;
    }
    if (Object.keys(patch).length) return updateClient(orgId, existing.id, patch, actor) ?? existing;
    return existing;
  }
  return createClient(
    orgId,
    {
      name: customer.name || 'Caller',
      number: number || customer.number,
      email: customer.email,
      consents: emptyConsents('booking', { sms: Boolean(number), email: Boolean(customer.email) }),
    },
    actor,
    { source: opts?.source ?? 'booking', actorName: opts?.actorName }
  );
}

/** Keeps the counters the client list shows truthful, without a join per row. */
export function noteAppointmentForClient(orgId: string, clientId: string, startsAt: string) {
  const client = clientById(orgId, clientId);
  if (!client) return;
  const latest = !client.lastAppointmentAt || startsAt > client.lastAppointmentAt ? startsAt : client.lastAppointmentAt;
  update<ClientDoc>('clients', clientId, {
    appointmentCount: (client.appointmentCount ?? 0) + 1,
    lastAppointmentAt: latest,
    lastInteractionAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);
}

/** Archived records past their retention window — purged by the maintenance sweep. */
export function clientsPastRetention(now = Date.now()): ClientDoc[] {
  return list<ClientDoc>(
    'clients',
    (client) =>
      Boolean(client.archivedAt) &&
      Boolean(client.retentionUntil) &&
      Boolean(client.retentionPolicySource) &&
      new Date(client.retentionUntil as string).getTime() < now
  );
}
