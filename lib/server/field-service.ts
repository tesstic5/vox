/**
 * Contractor field service: enquiry → estimate → job → visit → invoice.
 *
 * These are real, separate workspace records. A visit also owns one diary
 * booking when scheduled so the existing availability engine protects provider
 * hours, breaks and collisions. The job remains separate because one job can
 * need several visits and has a lifecycle beyond any one calendar block.
 */

import crypto from 'node:crypto';
import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { clientById, ensureClientForBooking, type ClientDoc } from './clients';
import { isFree } from './availability';
import { bookingById, upsertBooking } from './bookings';
import { moveAppointment, setAppointmentStatus } from './diary';
import { locationById, providerById, serviceById, type ServiceDoc } from './practice';
import { createInvoice, moneySettingsFor, type InvoiceDoc, type LineInput } from './money';
import { businessProfileFor } from './business-profile';

export type SiteAddress = {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

export type FieldHistory = { at: string; event: string; actor: string; detail?: string };

export type EnquiryStatus = 'new' | 'qualified' | 'quoted' | 'won' | 'lost' | 'closed';
export type EnquiryUrgency = 'routine' | 'soon' | 'urgent' | 'emergency';

export type EnquiryDoc = Doc & {
  orgId: string;
  reference: string;
  clientId: string;
  customer: { name: string; number: string; email?: string };
  description: string;
  urgency: EnquiryUrgency;
  siteAddress: SiteAddress;
  status: EnquiryStatus;
  source: 'manual' | 'assistant' | 'public' | 'import';
  callId?: string;
  estimateIds: string[];
  jobId?: string;
  assignedTo?: string;
  history: FieldHistory[];
  createdAt: string;
  updatedAt: string;
};

export type EstimateStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'superseded';

export type EstimateLine = {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxRatePct: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  code?: string;
};

export type EstimateRevision = {
  version: number;
  at: string;
  actor: string;
  lines: EstimateLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  validUntil: string;
  notes?: string;
};

export type EstimateDoc = Doc & {
  orgId: string;
  reference: string;
  enquiryId?: string;
  clientId: string;
  customer: { name: string; number: string; email?: string };
  siteAddress: SiteAddress;
  description?: string;
  status: EstimateStatus;
  currency: string;
  version: number;
  revisionOf?: string;
  lines: EstimateLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  validUntil: string;
  notes?: string;
  revisions: EstimateRevision[];
  sentAt?: string;
  acceptedAt?: string;
  declinedAt?: string;
  expiredAt?: string;
  supersededAt?: string;
  acceptance?: {
    decision: 'accepted' | 'declined';
    name: string;
    email?: string;
    at: string;
    ipHash?: string;
    userAgent?: string;
  };
  jobId?: string;
  history: FieldHistory[];
  createdAt: string;
  updatedAt: string;
};

export type JobStatus = 'unscheduled' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

export type JobDoc = Doc & {
  orgId: string;
  reference: string;
  enquiryId?: string;
  estimateId?: string;
  clientId: string;
  customer: { name: string; number: string; email?: string };
  siteAddress: SiteAddress;
  description: string;
  status: JobStatus;
  currency: string;
  lines: EstimateLine[];
  visitIds: string[];
  invoiceId?: string;
  completedAt?: string;
  cancelledAt?: string;
  workSummary?: string;
  history: FieldHistory[];
  createdAt: string;
  updatedAt: string;
};

export type VisitStatus = 'unassigned' | 'scheduled' | 'en_route' | 'on_site' | 'completed' | 'cancelled';

export type VisitDoc = Doc & {
  orgId: string;
  jobId: string;
  reference: string;
  bookingId?: string;
  startsAt?: string;
  durationMinutes: number;
  providerId?: string;
  locationId?: string;
  serviceId?: string;
  status: VisitStatus;
  travelBufferMinutes: number;
  instructions?: string;
  workPerformed?: string;
  completionNote?: string;
  completedAt?: string;
  cancelledAt?: string;
  history: FieldHistory[];
  createdAt: string;
  updatedAt: string;
};

type EstimateTokenDoc = Doc & {
  orgId: string;
  estimateId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  decision?: 'accepted' | 'declined';
  createdAt: string;
};

type Actor = { id: string; label: string };

export type FieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'FORBIDDEN'; error: string; detail?: string };

type Result<T> = FieldResult<T>;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(code: Exclude<Result<T>, { ok: true }>['code'], error: string, detail?: string): Result<T> => ({ ok: false, code, error, detail });

const ENQUIRY_TRANSITIONS: Record<EnquiryStatus, EnquiryStatus[]> = {
  new: ['qualified', 'quoted', 'lost', 'closed'],
  qualified: ['quoted', 'won', 'lost', 'closed'],
  quoted: ['won', 'lost', 'closed', 'qualified'],
  won: ['closed'],
  lost: ['qualified', 'closed'],
  closed: ['qualified'],
};

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  unscheduled: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['unscheduled', 'in_progress', 'completed', 'cancelled'],
  in_progress: ['scheduled', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function actorHistory(event: string, actor: Actor, detail?: string): FieldHistory {
  return { at: nowIso(), event, actor: actor.label, detail };
}

function appendHistory(rows: FieldHistory[], event: string, actor: Actor, detail?: string) {
  return [...(rows ?? []), actorHistory(event, actor, detail)].slice(-100);
}

function nextReference(orgId: string, kind: 'enquiry' | 'estimate' | 'job'): string {
  const id = `field_counter_${kind}_${orgId}`;
  const row = get<Doc & { value?: number }>('counters', id);
  const value = Number(row?.value ?? 0) + 1;
  if (row) update('counters', id, { value });
  else insert('counters', { id, orgId, kind, value, createdAt: nowIso() });
  const prefix = kind === 'enquiry' ? 'ENQ' : kind === 'estimate' ? 'EST' : 'JOB';
  return `${prefix}-${String(value).padStart(5, '0')}`;
}

function cleanSite(value: SiteAddress): SiteAddress {
  return {
    line1: String(value?.line1 ?? '').trim(),
    line2: String(value?.line2 ?? '').trim() || undefined,
    city: String(value?.city ?? '').trim(),
    region: String(value?.region ?? '').trim() || undefined,
    postalCode: String(value?.postalCode ?? '').trim() || undefined,
    country: String(value?.country ?? '').trim().toUpperCase() || undefined,
  };
}

function validateSite(value: SiteAddress): string | undefined {
  const site = cleanSite(value);
  if (!site.line1) return 'A service address needs the first address line.';
  if (!site.city) return 'A service address needs a city or locality.';
  if (site.country && !/^[A-Z]{2}$/.test(site.country)) return 'Use a two-letter country code on the service address.';
  return undefined;
}

function customerFor(orgId: string, input: { clientId?: string; customer?: { name?: string; number?: string; email?: string } }, actor: Actor, source: string): Result<ClientDoc> {
  if (input.clientId) {
    const client = clientById(orgId, input.clientId);
    return client ? ok(client) : err('NOT_FOUND', 'That customer is not in this workspace.');
  }
  const name = String(input.customer?.name ?? '').trim();
  const number = String(input.customer?.number ?? '').trim();
  if (!name) return err('VALIDATION_ERROR', 'A customer name is required.');
  if (!number) return err('VALIDATION_ERROR', 'A customer phone number is required so the enquiry can be followed up.');
  return ok(
    ensureClientForBooking(
      orgId,
      { name, number, email: String(input.customer?.email ?? '').trim() || undefined },
      actor.id,
      { actorName: actor.label, source }
    )
  );
}

function customerSnapshot(client: ClientDoc) {
  return { name: client.name, number: client.number, email: client.email };
}

/* --------------------------------------------------------------- enquiries */

export function enquiryById(orgId: string, id: string): EnquiryDoc | undefined {
  const row = get<EnquiryDoc>('fieldEnquiries', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function enquiriesFor(orgId: string, options: { status?: string; clientId?: string; query?: string } = {}): EnquiryDoc[] {
  const query = String(options.query ?? '').trim().toLowerCase();
  return list<EnquiryDoc>('fieldEnquiries', (row) => {
    if (row.orgId !== orgId) return false;
    if (options.status && row.status !== options.status) return false;
    if (options.clientId && row.clientId !== options.clientId) return false;
    if (query && !`${row.reference} ${row.customer.name} ${row.description} ${row.siteAddress.line1} ${row.siteAddress.city}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createEnquiry(input: {
  orgId: string;
  clientId?: string;
  customer?: { name?: string; number?: string; email?: string };
  description: string;
  urgency?: EnquiryUrgency;
  siteAddress: SiteAddress;
  source?: EnquiryDoc['source'];
  callId?: string;
  assignedTo?: string;
  actor: Actor;
}): Result<EnquiryDoc> {
  const description = String(input.description ?? '').trim();
  if (!description) return err('VALIDATION_ERROR', 'Describe what the customer needs.');
  if (description.length > 5000) return err('VALIDATION_ERROR', 'The enquiry description must be 5,000 characters or fewer.');
  const siteError = validateSite(input.siteAddress);
  if (siteError) return err('VALIDATION_ERROR', siteError);
  const urgency = input.urgency ?? 'routine';
  if (!['routine', 'soon', 'urgent', 'emergency'].includes(urgency)) return err('VALIDATION_ERROR', 'Urgency must be routine, soon, urgent or emergency.');
  const customer = customerFor(input.orgId, input, input.actor, input.source === 'assistant' ? 'call' : 'enquiry');
  if (!customer.ok) return customer;
  const now = nowIso();
  const enquiry = insert<EnquiryDoc>('fieldEnquiries', {
    id: newId('enq_'),
    orgId: input.orgId,
    reference: nextReference(input.orgId, 'enquiry'),
    clientId: customer.value.id,
    customer: customerSnapshot(customer.value),
    description,
    urgency,
    siteAddress: cleanSite(input.siteAddress),
    status: 'new',
    source: input.source ?? 'manual',
    callId: input.callId,
    assignedTo: input.assignedTo,
    estimateIds: [],
    history: [actorHistory('created', input.actor, input.source ?? 'manual')],
    createdAt: now,
    updatedAt: now,
  } as EnquiryDoc);
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.enquiry_created', target: enquiry.id, detail: `${enquiry.reference} · ${enquiry.customer.name}` });
  return ok(enquiry);
}

export function updateEnquiry(input: {
  orgId: string;
  id: string;
  patch: Partial<Pick<EnquiryDoc, 'description' | 'urgency' | 'siteAddress' | 'assignedTo'>>;
  actor: Actor;
}): Result<EnquiryDoc> {
  const enquiry = enquiryById(input.orgId, input.id);
  if (!enquiry) return err('NOT_FOUND', 'No such enquiry in this workspace.');
  const patch: Partial<EnquiryDoc> = {};
  if (input.patch.description !== undefined) {
    const description = String(input.patch.description).trim();
    if (!description) return err('VALIDATION_ERROR', 'The enquiry description cannot be empty.');
    patch.description = description;
  }
  if (input.patch.urgency !== undefined) {
    if (!['routine', 'soon', 'urgent', 'emergency'].includes(input.patch.urgency)) return err('VALIDATION_ERROR', 'Unknown urgency.');
    patch.urgency = input.patch.urgency;
  }
  if (input.patch.siteAddress !== undefined) {
    const siteError = validateSite(input.patch.siteAddress);
    if (siteError) return err('VALIDATION_ERROR', siteError);
    patch.siteAddress = cleanSite(input.patch.siteAddress);
  }
  if (input.patch.assignedTo !== undefined) patch.assignedTo = String(input.patch.assignedTo).trim() || undefined;
  const changed = Object.keys(patch);
  const value = update<EnquiryDoc>('fieldEnquiries', enquiry.id, {
    ...patch,
    updatedAt: nowIso(),
    history: appendHistory(enquiry.history, 'updated', input.actor, changed.join(', ')),
  });
  if (!value) return err('NOT_FOUND', 'The enquiry disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.enquiry_updated', target: enquiry.id, detail: changed.join(', ') });
  return ok(value);
}

export function setEnquiryStatus(input: { orgId: string; id: string; status: EnquiryStatus; note?: string; actor: Actor }): Result<EnquiryDoc> {
  const enquiry = enquiryById(input.orgId, input.id);
  if (!enquiry) return err('NOT_FOUND', 'No such enquiry in this workspace.');
  if (enquiry.status === input.status) return ok(enquiry);
  if (!ENQUIRY_TRANSITIONS[enquiry.status]?.includes(input.status)) {
    return err('CONFLICT', `${enquiry.reference} cannot move from ${enquiry.status} to ${input.status}.`, `Allowed: ${ENQUIRY_TRANSITIONS[enquiry.status].join(', ') || 'none'}`);
  }
  const value = update<EnquiryDoc>('fieldEnquiries', enquiry.id, {
    status: input.status,
    updatedAt: nowIso(),
    history: appendHistory(enquiry.history, `status:${input.status}`, input.actor, input.note),
  });
  if (!value) return err('NOT_FOUND', 'The enquiry disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: `field.enquiry_${input.status}`, target: enquiry.id, detail: input.note });
  return ok(value);
}

/* --------------------------------------------------------------- estimates */

export type EstimateLineInput = {
  description?: string;
  quantity?: number;
  unitAmountMinor?: number;
  taxRatePct?: number;
  code?: string;
};

function buildEstimateLines(input: EstimateLineInput[]): Result<{
  lines: EstimateLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}> {
  if (!Array.isArray(input) || input.length === 0) return err('VALIDATION_ERROR', 'An estimate needs at least one line item.');
  if (input.length > 100) return err('VALIDATION_ERROR', 'An estimate can contain at most 100 line items.');
  const lines: EstimateLine[] = [];
  for (const raw of input) {
    const description = String(raw.description ?? '').trim();
    const quantity = Number(raw.quantity ?? 1);
    const unitAmountMinor = Number(raw.unitAmountMinor);
    const taxRatePct = Number(raw.taxRatePct ?? 0);
    if (!description) return err('VALIDATION_ERROR', 'Every estimate line needs a description.');
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) return err('VALIDATION_ERROR', `Quantity for “${description}” must be greater than zero.`);
    if (!Number.isInteger(unitAmountMinor) || unitAmountMinor < 0 || unitAmountMinor > 1_000_000_000) return err('VALIDATION_ERROR', `Unit price for “${description}” must be a non-negative integer in minor units.`);
    if (!Number.isFinite(taxRatePct) || taxRatePct < 0 || taxRatePct > 100) return err('VALIDATION_ERROR', `Tax for “${description}” must be between 0 and 100 percent.`);
    const netMinor = Math.round(quantity * unitAmountMinor);
    const taxMinor = Math.round((netMinor * taxRatePct) / 100);
    lines.push({
      id: newId('eline_'),
      description,
      quantity,
      unitAmountMinor,
      taxRatePct,
      netMinor,
      taxMinor,
      totalMinor: netMinor + taxMinor,
      code: String(raw.code ?? '').trim() || undefined,
    });
  }
  const subtotalMinor = lines.reduce((sum, line) => sum + line.netMinor, 0);
  const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, 0);
  return ok({ lines, subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor });
}

function revisionOf(estimate: Pick<EstimateDoc, 'version' | 'lines' | 'subtotalMinor' | 'taxMinor' | 'totalMinor' | 'validUntil' | 'notes'>, actor: Actor): EstimateRevision {
  return {
    version: estimate.version,
    at: nowIso(),
    actor: actor.label,
    lines: estimate.lines.map((line) => ({ ...line })),
    subtotalMinor: estimate.subtotalMinor,
    taxMinor: estimate.taxMinor,
    totalMinor: estimate.totalMinor,
    validUntil: estimate.validUntil,
    notes: estimate.notes,
  };
}

function validUntilOf(value?: string) {
  const raw = String(value ?? '').slice(0, 10);
  if (raw && !Number.isNaN(new Date(`${raw}T23:59:59.999Z`).getTime())) return raw;
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

export function estimateById(orgId: string, id: string): EstimateDoc | undefined {
  const row = get<EstimateDoc>('fieldEstimates', id);
  if (!row || row.orgId !== orgId) return undefined;
  return expireEstimate(row);
}

function expireEstimate(estimate: EstimateDoc): EstimateDoc {
  if (estimate.status !== 'sent') return estimate;
  const expires = new Date(`${estimate.validUntil}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(expires) || expires >= Date.now()) return estimate;
  const at = nowIso();
  const updated = update<EstimateDoc>('fieldEstimates', estimate.id, {
    status: 'expired',
    expiredAt: at,
    updatedAt: at,
    history: [...estimate.history, { at, event: 'status:expired', actor: 'system', detail: `valid until ${estimate.validUntil}` }].slice(-100),
  });
  if (updated) audit({ orgId: estimate.orgId, actor: 'system', action: 'field.estimate_expired', target: estimate.id, detail: estimate.reference });
  return updated ?? estimate;
}

export function estimatesFor(orgId: string, options: { status?: string; clientId?: string; enquiryId?: string; query?: string } = {}): EstimateDoc[] {
  const query = String(options.query ?? '').trim().toLowerCase();
  return list<EstimateDoc>('fieldEstimates', (row) => {
    if (row.orgId !== orgId) return false;
    if (options.clientId && row.clientId !== options.clientId) return false;
    if (options.enquiryId && row.enquiryId !== options.enquiryId) return false;
    if (query && !`${row.reference} ${row.customer.name} ${row.description ?? ''}`.toLowerCase().includes(query)) return false;
    return true;
  })
    .map(expireEstimate)
    .filter((row) => !options.status || row.status === options.status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createEstimate(input: {
  orgId: string;
  enquiryId?: string;
  clientId?: string;
  customer?: { name?: string; number?: string; email?: string };
  siteAddress?: SiteAddress;
  description?: string;
  lines: EstimateLineInput[];
  currency?: string;
  validUntil?: string;
  notes?: string;
  actor: Actor;
}): Result<EstimateDoc> {
  const enquiry = input.enquiryId ? enquiryById(input.orgId, input.enquiryId) : undefined;
  if (input.enquiryId && !enquiry) return err('NOT_FOUND', 'That enquiry is not in this workspace.');
  const customer = enquiry
    ? customerFor(input.orgId, { clientId: enquiry.clientId }, input.actor, 'estimate')
    : customerFor(input.orgId, input, input.actor, 'estimate');
  if (!customer.ok) return customer;
  const site = cleanSite(input.siteAddress ?? enquiry?.siteAddress ?? ({} as SiteAddress));
  const siteError = validateSite(site);
  if (siteError) return err('VALIDATION_ERROR', siteError);
  const totals = buildEstimateLines(input.lines);
  if (!totals.ok) return totals;
  const currency = String(input.currency ?? businessProfileFor(input.orgId).currency ?? moneySettingsFor(input.orgId).currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return err('VALIDATION_ERROR', 'Currency must be a three-letter ISO code.');
  const now = nowIso();
  const draftBase = {
    version: 1,
    lines: totals.value.lines,
    subtotalMinor: totals.value.subtotalMinor,
    taxMinor: totals.value.taxMinor,
    totalMinor: totals.value.totalMinor,
    validUntil: validUntilOf(input.validUntil),
    notes: String(input.notes ?? '').trim() || undefined,
  };
  const estimate = insert<EstimateDoc>('fieldEstimates', {
    id: newId('est_'),
    orgId: input.orgId,
    reference: nextReference(input.orgId, 'estimate'),
    enquiryId: enquiry?.id,
    clientId: customer.value.id,
    customer: customerSnapshot(customer.value),
    siteAddress: site,
    description: String(input.description ?? enquiry?.description ?? '').trim() || undefined,
    status: 'draft',
    currency,
    ...draftBase,
    revisions: [revisionOf(draftBase, input.actor)],
    history: [actorHistory('created', input.actor, enquiry ? `from ${enquiry.reference}` : 'direct')],
    createdAt: now,
    updatedAt: now,
  } as EstimateDoc);
  if (enquiry) {
    update<EnquiryDoc>('fieldEnquiries', enquiry.id, {
      estimateIds: [...new Set([...(enquiry.estimateIds ?? []), estimate.id])],
      status: 'quoted',
      updatedAt: now,
      history: appendHistory(enquiry.history, 'estimate_created', input.actor, estimate.reference),
    });
  }
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.estimate_created', target: estimate.id, detail: `${estimate.reference} · ${estimate.totalMinor} ${estimate.currency}` });
  return ok(estimate);
}

export function updateEstimate(input: {
  orgId: string;
  id: string;
  lines?: EstimateLineInput[];
  validUntil?: string;
  notes?: string;
  description?: string;
  siteAddress?: SiteAddress;
  actor: Actor;
}): Result<EstimateDoc> {
  const estimate = estimateById(input.orgId, input.id);
  if (!estimate) return err('NOT_FOUND', 'No such estimate in this workspace.');
  if (estimate.status !== 'draft') return err('CONFLICT', 'Only a draft estimate can be edited. Revise a sent or decided estimate instead.');
  const totals = input.lines ? buildEstimateLines(input.lines) : ok({
    lines: estimate.lines,
    subtotalMinor: estimate.subtotalMinor,
    taxMinor: estimate.taxMinor,
    totalMinor: estimate.totalMinor,
  });
  if (!totals.ok) return totals;
  const site = input.siteAddress ? cleanSite(input.siteAddress) : estimate.siteAddress;
  if (input.siteAddress) {
    const siteError = validateSite(input.siteAddress);
    if (siteError) return err('VALIDATION_ERROR', siteError);
  }
  const nextVersion = estimate.version + 1;
  const nextBase = {
    version: nextVersion,
    lines: totals.value.lines,
    subtotalMinor: totals.value.subtotalMinor,
    taxMinor: totals.value.taxMinor,
    totalMinor: totals.value.totalMinor,
    validUntil: input.validUntil !== undefined ? validUntilOf(input.validUntil) : estimate.validUntil,
    notes: input.notes !== undefined ? String(input.notes).trim() || undefined : estimate.notes,
  };
  const value = update<EstimateDoc>('fieldEstimates', estimate.id, {
    ...nextBase,
    description: input.description !== undefined ? String(input.description).trim() || undefined : estimate.description,
    siteAddress: site,
    revisions: [...estimate.revisions, revisionOf(nextBase, input.actor)].slice(-50),
    updatedAt: nowIso(),
    history: appendHistory(estimate.history, 'draft_revised', input.actor, `version ${nextVersion}`),
  });
  if (!value) return err('NOT_FOUND', 'The estimate disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.estimate_revised', target: estimate.id, detail: `${estimate.reference} v${nextVersion}` });
  return ok(value);
}

export function shareEstimate(input: { orgId: string; id: string; actor: Actor; ttlDays?: number }): Result<{ estimate: EstimateDoc; token: string; expiresAt: string }> {
  const estimate = estimateById(input.orgId, input.id);
  if (!estimate) return err('NOT_FOUND', 'No such estimate in this workspace.');
  if (estimate.status !== 'draft') return err('CONFLICT', `Only a draft can be shared. This estimate is ${estimate.status}.`);
  if (!estimate.lines.length || estimate.totalMinor < 0) return err('VALIDATION_ERROR', 'Review the line items before sharing this estimate.');
  const validUntil = new Date(`${estimate.validUntil}T23:59:59.999Z`).getTime();
  if (validUntil < Date.now()) return err('CONFLICT', 'This estimate is already past its validity date. Change the date before sharing it.');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(validUntil, Date.now() + Math.max(1, Math.min(input.ttlDays ?? 30, 90)) * 86_400_000)).toISOString();
  insert<EstimateTokenDoc>('estimateTokens', {
    id: newId('etok_'),
    orgId: input.orgId,
    estimateId: estimate.id,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt,
    createdAt: nowIso(),
  } as EstimateTokenDoc);
  const at = nowIso();
  const updated = update<EstimateDoc>('fieldEstimates', estimate.id, {
    status: 'sent',
    sentAt: at,
    updatedAt: at,
    history: appendHistory(estimate.history, 'shared_for_decision', input.actor, `link expires ${expiresAt}`),
  });
  if (!updated) return err('NOT_FOUND', 'The estimate disappeared while it was being shared.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.estimate_shared', target: estimate.id, detail: `${estimate.reference} · link expires ${expiresAt}` });
  return ok({ estimate: updated, token, expiresAt });
}

export function reviseSharedEstimate(input: { orgId: string; id: string; actor: Actor }): Result<EstimateDoc> {
  const old = estimateById(input.orgId, input.id);
  if (!old) return err('NOT_FOUND', 'No such estimate in this workspace.');
  if (!['sent', 'declined', 'expired'].includes(old.status)) return err('CONFLICT', `A ${old.status} estimate cannot be revised this way.`);
  const now = nowIso();
  const nextVersion = old.version + 1;
  const base = {
    version: nextVersion,
    lines: old.lines.map((line) => ({ ...line, id: newId('eline_') })),
    subtotalMinor: old.subtotalMinor,
    taxMinor: old.taxMinor,
    totalMinor: old.totalMinor,
    validUntil: validUntilOf(undefined),
    notes: old.notes,
  };
  const next = insert<EstimateDoc>('fieldEstimates', {
    ...old,
    id: newId('est_'),
    status: 'draft',
    revisionOf: old.id,
    ...base,
    revisions: [...old.revisions, revisionOf(base, input.actor)].slice(-50),
    sentAt: undefined,
    acceptedAt: undefined,
    declinedAt: undefined,
    expiredAt: undefined,
    supersededAt: undefined,
    acceptance: undefined,
    jobId: undefined,
    history: appendHistory(old.history, 'revision_created', input.actor, `from ${old.id}`),
    createdAt: now,
    updatedAt: now,
  } as EstimateDoc);
  update<EstimateDoc>('fieldEstimates', old.id, {
    status: 'superseded',
    supersededAt: now,
    updatedAt: now,
    history: appendHistory(old.history, 'superseded', input.actor, `by ${next.id}`),
  });
  for (const token of list<EstimateTokenDoc>('estimateTokens', (row) => row.orgId === input.orgId && row.estimateId === old.id && !row.usedAt)) {
    update<EstimateTokenDoc>('estimateTokens', token.id, { usedAt: now });
  }
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.estimate_revision_created', target: next.id, detail: `${old.reference} v${nextVersion}` });
  return ok(next);
}

function tokenRow(raw: string): EstimateTokenDoc | undefined {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return list<EstimateTokenDoc>('estimateTokens', (row) => row.tokenHash === hash)[0];
}

export function publicEstimate(rawToken: string): Result<{
  workspace: { name: string };
  estimate: Pick<EstimateDoc, 'reference' | 'description' | 'customer' | 'siteAddress' | 'currency' | 'lines' | 'subtotalMinor' | 'taxMinor' | 'totalMinor' | 'validUntil' | 'status' | 'version' | 'notes'>;
  expiresAt: string;
  decided: boolean;
}> {
  const token = tokenRow(rawToken);
  if (!token) return err('NOT_FOUND', 'That estimate link is not valid.');
  const estimate = estimateById(token.orgId, token.estimateId);
  if (!estimate) return err('NOT_FOUND', 'That estimate is no longer available.');
  const org = get<Doc & { name?: string }>('orgs', token.orgId);
  if (token.usedAt || token.decision) return err('CONFLICT', `This link has already been used${token.decision ? ` to ${token.decision === 'accepted' ? 'accept' : 'decline'} the estimate` : ''}.`);
  if (new Date(token.expiresAt).getTime() < Date.now() || estimate.status === 'expired') return err('CONFLICT', 'This estimate link has expired. Ask the business for a new one.');
  if (estimate.status !== 'sent') return err('CONFLICT', `This estimate is ${estimate.status} and cannot be decided with this link.`);
  return ok({
    workspace: { name: String(org?.name ?? 'The business') },
    estimate: {
      reference: estimate.reference,
      description: estimate.description,
      customer: estimate.customer,
      siteAddress: estimate.siteAddress,
      currency: estimate.currency,
      lines: estimate.lines,
      subtotalMinor: estimate.subtotalMinor,
      taxMinor: estimate.taxMinor,
      totalMinor: estimate.totalMinor,
      validUntil: estimate.validUntil,
      status: estimate.status,
      version: estimate.version,
      notes: estimate.notes,
    },
    expiresAt: token.expiresAt,
    decided: false,
  });
}

export function decideEstimate(input: {
  token: string;
  decision: 'accepted' | 'declined';
  name: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}): Result<{ reference: string; decision: 'accepted' | 'declined'; decidedAt: string }> {
  const token = tokenRow(input.token);
  if (!token) return err('NOT_FOUND', 'That estimate link is not valid.');
  if (token.usedAt || token.decision) return err('CONFLICT', 'This estimate link has already been used.');
  if (new Date(token.expiresAt).getTime() < Date.now()) return err('CONFLICT', 'This estimate link has expired.');
  const estimate = estimateById(token.orgId, token.estimateId);
  if (!estimate) return err('NOT_FOUND', 'That estimate is no longer available.');
  if (estimate.status !== 'sent') return err('CONFLICT', `This estimate is ${estimate.status} and cannot be decided.`);
  const name = String(input.name ?? '').trim();
  if (name.length < 2) return err('VALIDATION_ERROR', 'Enter the name of the person making this decision.');
  if (!['accepted', 'declined'].includes(input.decision)) return err('VALIDATION_ERROR', 'Decision must be accepted or declined.');
  const at = nowIso();
  const ipHash = input.ip ? crypto.createHash('sha256').update(input.ip).digest('hex') : undefined;
  const acceptance: EstimateDoc['acceptance'] = {
    decision: input.decision,
    name,
    email: String(input.email ?? '').trim() || undefined,
    at,
    ipHash,
    userAgent: String(input.userAgent ?? '').slice(0, 300) || undefined,
  };
  update<EstimateTokenDoc>('estimateTokens', token.id, { usedAt: at, decision: input.decision });
  update<EstimateDoc>('fieldEstimates', estimate.id, {
    status: input.decision,
    acceptedAt: input.decision === 'accepted' ? at : undefined,
    declinedAt: input.decision === 'declined' ? at : undefined,
    acceptance,
    updatedAt: at,
    history: [...estimate.history, { at, event: `customer:${input.decision}`, actor: name, detail: acceptance.email }].slice(-100),
  });
  if (estimate.enquiryId) {
    const enquiry = enquiryById(estimate.orgId, estimate.enquiryId);
    if (enquiry) {
      update<EnquiryDoc>('fieldEnquiries', enquiry.id, {
        status: input.decision === 'accepted' ? 'won' : 'lost',
        updatedAt: at,
        history: [...enquiry.history, { at, event: `estimate_${input.decision}`, actor: name, detail: estimate.reference }].slice(-100),
      });
    }
  }
  audit({ orgId: estimate.orgId, actor: `customer:${name}`, action: `field.estimate_${input.decision}`, target: estimate.id, detail: `${estimate.reference} · token ${token.id}` });
  return ok({ reference: estimate.reference, decision: input.decision, decidedAt: at });
}

/* -------------------------------------------------------------------- jobs */

export function jobById(orgId: string, id: string): JobDoc | undefined {
  const row = get<JobDoc>('fieldJobs', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function jobsFor(orgId: string, options: { status?: string; clientId?: string; query?: string } = {}): JobDoc[] {
  const query = String(options.query ?? '').trim().toLowerCase();
  return list<JobDoc>('fieldJobs', (row) => {
    if (row.orgId !== orgId) return false;
    if (options.status && row.status !== options.status) return false;
    if (options.clientId && row.clientId !== options.clientId) return false;
    if (query && !`${row.reference} ${row.customer.name} ${row.description} ${row.siteAddress.line1} ${row.siteAddress.city}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function createJob(input: {
  orgId: string;
  estimateId?: string;
  enquiryId?: string;
  clientId?: string;
  customer?: { name?: string; number?: string; email?: string };
  siteAddress?: SiteAddress;
  description?: string;
  lines?: EstimateLineInput[];
  actor: Actor;
}): Result<JobDoc> {
  const estimate = input.estimateId ? estimateById(input.orgId, input.estimateId) : undefined;
  if (input.estimateId && !estimate) return err('NOT_FOUND', 'That estimate is not in this workspace.');
  if (estimate && estimate.status !== 'accepted') return err('CONFLICT', `Only an accepted estimate can become a job. This one is ${estimate.status}.`);
  if (estimate?.jobId || (estimate && jobsFor(input.orgId).some((job) => job.estimateId === estimate.id))) {
    const existing = estimate.jobId ? jobById(input.orgId, estimate.jobId) : jobsFor(input.orgId).find((job) => job.estimateId === estimate.id);
    return err('CONFLICT', `${estimate.reference} already became ${existing?.reference ?? 'a job'}.`, existing?.id);
  }
  const enquiry = input.enquiryId ? enquiryById(input.orgId, input.enquiryId) : estimate?.enquiryId ? enquiryById(input.orgId, estimate.enquiryId) : undefined;
  const customer = estimate
    ? customerFor(input.orgId, { clientId: estimate.clientId }, input.actor, 'job')
    : enquiry
      ? customerFor(input.orgId, { clientId: enquiry.clientId }, input.actor, 'job')
      : customerFor(input.orgId, input, input.actor, 'job');
  if (!customer.ok) return customer;
  const site = cleanSite(input.siteAddress ?? estimate?.siteAddress ?? enquiry?.siteAddress ?? ({} as SiteAddress));
  const siteError = validateSite(site);
  if (siteError) return err('VALIDATION_ERROR', siteError);
  const description = String(input.description ?? estimate?.description ?? enquiry?.description ?? '').trim();
  if (!description) return err('VALIDATION_ERROR', 'Describe the work this job covers.');
  let lines: EstimateLine[] = estimate?.lines.map((line) => ({ ...line })) ?? [];
  if (!estimate && input.lines?.length) {
    const built = buildEstimateLines(input.lines);
    if (!built.ok) return built;
    lines = built.value.lines;
  }
  const now = nowIso();
  const job = insert<JobDoc>('fieldJobs', {
    id: newId('job_'),
    orgId: input.orgId,
    reference: nextReference(input.orgId, 'job'),
    enquiryId: enquiry?.id,
    estimateId: estimate?.id,
    clientId: customer.value.id,
    customer: customerSnapshot(customer.value),
    siteAddress: site,
    description,
    status: 'unscheduled',
    currency: estimate?.currency ?? businessProfileFor(input.orgId).currency ?? moneySettingsFor(input.orgId).currency,
    lines,
    visitIds: [],
    history: [actorHistory('created', input.actor, estimate ? `from ${estimate.reference}` : 'direct')],
    createdAt: now,
    updatedAt: now,
  } as JobDoc);
  if (estimate) {
    update<EstimateDoc>('fieldEstimates', estimate.id, {
      jobId: job.id,
      updatedAt: now,
      history: appendHistory(estimate.history, 'converted_to_job', input.actor, job.reference),
    });
  }
  if (enquiry) {
    update<EnquiryDoc>('fieldEnquiries', enquiry.id, {
      jobId: job.id,
      status: 'won',
      updatedAt: now,
      history: appendHistory(enquiry.history, 'converted_to_job', input.actor, job.reference),
    });
  }
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.job_created', target: job.id, detail: `${job.reference} · ${job.customer.name}` });
  return ok(job);
}

export function updateJob(input: {
  orgId: string;
  id: string;
  description?: string;
  siteAddress?: SiteAddress;
  workSummary?: string;
  lines?: EstimateLineInput[];
  actor: Actor;
}): Result<JobDoc> {
  const job = jobById(input.orgId, input.id);
  if (!job) return err('NOT_FOUND', 'No such job in this workspace.');
  if (job.status === 'completed' || job.status === 'cancelled') return err('CONFLICT', `Reopen this ${job.status} job before editing it.`);
  const patch: Partial<JobDoc> = {};
  if (input.description !== undefined) {
    const description = String(input.description).trim();
    if (!description) return err('VALIDATION_ERROR', 'The job description cannot be empty.');
    patch.description = description;
  }
  if (input.siteAddress !== undefined) {
    const siteError = validateSite(input.siteAddress);
    if (siteError) return err('VALIDATION_ERROR', siteError);
    patch.siteAddress = cleanSite(input.siteAddress);
  }
  if (input.workSummary !== undefined) patch.workSummary = String(input.workSummary).trim() || undefined;
  if (input.lines !== undefined) {
    if (job.invoiceId) return err('CONFLICT', 'This job already has an invoice. Its billed lines cannot be changed here.');
    const built = buildEstimateLines(input.lines);
    if (!built.ok) return built;
    patch.lines = built.value.lines;
  }
  const value = update<JobDoc>('fieldJobs', job.id, {
    ...patch,
    updatedAt: nowIso(),
    history: appendHistory(job.history, 'updated', input.actor, Object.keys(patch).join(', ')),
  });
  if (!value) return err('NOT_FOUND', 'The job disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.job_updated', target: job.id, detail: Object.keys(patch).join(', ') });
  return ok(value);
}

export function setJobStatus(input: { orgId: string; id: string; status: JobStatus; note?: string; actor: Actor; reopen?: boolean }): Result<JobDoc> {
  const job = jobById(input.orgId, input.id);
  if (!job) return err('NOT_FOUND', 'No such job in this workspace.');
  if (job.status === input.status) return ok(job);
  const terminal = job.status === 'completed' || job.status === 'cancelled';
  if (input.reopen) {
    if (!terminal) return err('CONFLICT', 'Only a completed or cancelled job can be reopened.');
    if (job.invoiceId) return err('CONFLICT', 'This job already has an invoice. Correct or credit the invoice before reopening the work.');
    const reopenTarget: JobStatus = job.status === 'completed' ? 'scheduled' : 'unscheduled';
    if (input.status !== reopenTarget) return err('CONFLICT', `${job.reference} can reopen only as ${reopenTarget}.`);
  } else if (terminal) {
    return err('CONFLICT', `This job is ${job.status}. Use the explicit reopen action before changing it.`);
  } else if (!JOB_TRANSITIONS[job.status]?.includes(input.status)) {
    return err('CONFLICT', `${job.reference} cannot move from ${job.status} to ${input.status}.`, `Allowed: ${JOB_TRANSITIONS[job.status].join(', ') || 'none'}`);
  }
  if (input.status === 'completed') {
    const active = visitsFor(input.orgId, { jobId: job.id }).filter((visit) => visit.status !== 'cancelled');
    if (active.length && active.some((visit) => visit.status !== 'completed')) {
      return err('CONFLICT', 'Complete or cancel every visit before completing the job.');
    }
  }
  const at = nowIso();
  const value = update<JobDoc>('fieldJobs', job.id, {
    status: input.status,
    completedAt: input.status === 'completed' ? at : input.reopen ? undefined : job.completedAt,
    cancelledAt: input.status === 'cancelled' ? at : input.reopen ? undefined : job.cancelledAt,
    updatedAt: at,
    history: appendHistory(job.history, input.reopen ? `reopened:${input.status}` : `status:${input.status}`, input.actor, input.note),
  });
  if (!value) return err('NOT_FOUND', 'The job disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: input.reopen ? 'field.job_reopened' : `field.job_${input.status}`, target: job.id, detail: input.note });
  return ok(value);
}

/* ------------------------------------------------------------------ visits */

export function visitById(orgId: string, id: string): VisitDoc | undefined {
  const row = get<VisitDoc>('fieldVisits', id);
  return row && row.orgId === orgId ? row : undefined;
}

export function visitsFor(orgId: string, options: { jobId?: string; status?: string; providerId?: string; from?: string; to?: string } = {}): VisitDoc[] {
  return list<VisitDoc>('fieldVisits', (row) => {
    if (row.orgId !== orgId) return false;
    if (options.jobId && row.jobId !== options.jobId) return false;
    if (options.status && row.status !== options.status) return false;
    if (options.providerId && row.providerId !== options.providerId) return false;
    if (options.from && (!row.startsAt || row.startsAt < options.from)) return false;
    if (options.to && (!row.startsAt || row.startsAt > options.to)) return false;
    return true;
  }).sort((a, b) => {
    if (!a.startsAt && b.startsAt) return -1;
    if (a.startsAt && !b.startsAt) return 1;
    return String(a.startsAt ?? a.createdAt).localeCompare(String(b.startsAt ?? b.createdAt));
  });
}

function visitService(orgId: string, serviceId: string | undefined, durationMinutes: number, travelBufferMinutes: number): ServiceDoc | undefined {
  const stored = serviceId ? serviceById(orgId, serviceId) : undefined;
  if (stored) return { ...stored, bufferAfterMinutes: Math.max(stored.bufferAfterMinutes ?? 0, travelBufferMinutes) };
  if (!travelBufferMinutes) return undefined;
  return {
    id: 'field-visit-buffer',
    orgId,
    name: 'Field visit',
    durationMinutes,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: travelBufferMinutes,
    price: 0,
    colour: 'brand',
    serviceIds: [],
    active: true,
  } as unknown as ServiceDoc;
}

export function createVisit(input: {
  orgId: string;
  jobId: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  instructions?: string;
  startsAt?: string;
  providerId?: string;
  locationId?: string;
  serviceId?: string;
  actor: Actor;
}): Result<VisitDoc> {
  const job = jobById(input.orgId, input.jobId);
  if (!job) return err('NOT_FOUND', 'That job is not in this workspace.');
  if (job.status === 'completed' || job.status === 'cancelled') return err('CONFLICT', `Reopen ${job.reference} before adding another visit.`);
  const durationMinutes = Math.round(Number(input.durationMinutes ?? 60));
  const travelBufferMinutes = Math.round(Number(input.travelBufferMinutes ?? 0));
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 24 * 60) return err('VALIDATION_ERROR', 'Visit duration must be between 5 and 1,440 minutes.');
  if (!Number.isFinite(travelBufferMinutes) || travelBufferMinutes < 0 || travelBufferMinutes > 8 * 60) return err('VALIDATION_ERROR', 'Travel buffer must be between 0 and 480 minutes.');
  const scheduling = Boolean(input.startsAt || input.providerId || input.locationId);
  if (scheduling && !(input.startsAt && input.providerId && input.locationId)) {
    return err('VALIDATION_ERROR', 'To schedule now, choose a start time, technician and dispatch location. Otherwise leave all three blank.');
  }
  const now = nowIso();
  const visit = insert<VisitDoc>('fieldVisits', {
    id: newId('vst_'),
    orgId: input.orgId,
    jobId: job.id,
    reference: `${job.reference}-V${String((job.visitIds?.length ?? 0) + 1).padStart(2, '0')}`,
    durationMinutes,
    travelBufferMinutes,
    instructions: String(input.instructions ?? '').trim() || undefined,
    serviceId: input.serviceId,
    status: 'unassigned',
    history: [actorHistory('created', input.actor)],
    createdAt: now,
    updatedAt: now,
  } as VisitDoc);
  update<JobDoc>('fieldJobs', job.id, {
    visitIds: [...new Set([...(job.visitIds ?? []), visit.id])],
    updatedAt: now,
    history: appendHistory(job.history, 'visit_created', input.actor, visit.reference),
  });
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.visit_created', target: visit.id, detail: `${visit.reference} · ${job.reference}` });
  if (scheduling) {
    const scheduled = scheduleVisit({
      orgId: input.orgId,
      id: visit.id,
      startsAt: input.startsAt!,
      providerId: input.providerId!,
      locationId: input.locationId!,
      serviceId: input.serviceId,
      durationMinutes,
      travelBufferMinutes,
      actor: input.actor,
    });
    return scheduled;
  }
  return ok(visit);
}

export function scheduleVisit(input: {
  orgId: string;
  id: string;
  startsAt: string;
  providerId: string;
  locationId: string;
  serviceId?: string;
  durationMinutes?: number;
  travelBufferMinutes?: number;
  actor: Actor;
}): Result<VisitDoc> {
  const visit = visitById(input.orgId, input.id);
  if (!visit) return err('NOT_FOUND', 'No such visit in this workspace.');
  if (visit.status === 'completed' || visit.status === 'cancelled') return err('CONFLICT', `Reopen this ${visit.status} visit before scheduling it.`);
  const job = jobById(input.orgId, visit.jobId);
  if (!job) return err('NOT_FOUND', 'The visit\'s job is no longer available.');
  const startsAtMs = new Date(input.startsAt).getTime();
  if (!Number.isFinite(startsAtMs)) return err('VALIDATION_ERROR', 'Visit start must be an ISO date and time.');
  const provider = providerById(input.orgId, input.providerId);
  if (!provider || provider.active === false) return err('NOT_FOUND', 'That technician is not active in this workspace.');
  const location = locationById(input.orgId, input.locationId);
  if (!location || location.active === false) return err('NOT_FOUND', 'That dispatch location is not active in this workspace.');
  const durationMinutes = Math.round(Number(input.durationMinutes ?? visit.durationMinutes));
  const travelBufferMinutes = Math.round(Number(input.travelBufferMinutes ?? visit.travelBufferMinutes));
  if (!Number.isFinite(durationMinutes) || durationMinutes < 5) return err('VALIDATION_ERROR', 'Visit duration must be at least five minutes.');
  if (!Number.isFinite(travelBufferMinutes) || travelBufferMinutes < 0) return err('VALIDATION_ERROR', 'Travel buffer cannot be negative.');
  const service = visitService(input.orgId, input.serviceId ?? visit.serviceId, durationMinutes, travelBufferMinutes);
  const startsAt = new Date(startsAtMs).toISOString();

  if (visit.bookingId) {
    const moved = moveAppointment({
      orgId: input.orgId,
      id: visit.bookingId,
      startsAt,
      durationMinutes,
      providerId: provider.id,
      locationId: location.id,
      actor: input.actor.id,
      actorName: input.actor.label,
    });
    if (!moved.ok) return err(moved.error === 'not_found' ? 'NOT_FOUND' : moved.error === 'invalid' ? 'VALIDATION_ERROR' : 'CONFLICT', moved.message);
  } else {
    const available = isFree({
      orgId: input.orgId,
      providerId: provider.id,
      locationId: location.id,
      startsAt,
      durationMinutes,
      service,
    });
    if (!available.free) return err('CONFLICT', available.reason ?? 'That technician is already committed at this time.', available.conflicts.map((row) => row.startsAt).join(', '));
    const booking = upsertBooking({
      orgId: input.orgId,
      externalId: `field:${visit.id}`,
      customer: job.customer,
      clientId: job.clientId,
      service: `Field visit — ${job.reference}`,
      startsAt,
      durationMinutes,
      timezone: location.timezone,
      status: 'confirmed',
      notes: `${job.description}\nService address: ${formatSite(job.siteAddress)}`,
      metadata: { fieldVisitId: visit.id, fieldJobId: job.id, siteAddress: formatSite(job.siteAddress) },
      providerId: provider.id,
      locationId: location.id,
      serviceId: input.serviceId ?? visit.serviceId,
      source: 'dashboard',
    }).booking;
    visit.bookingId = booking.id;
  }
  const at = nowIso();
  const value = update<VisitDoc>('fieldVisits', visit.id, {
    bookingId: visit.bookingId,
    startsAt,
    durationMinutes,
    travelBufferMinutes,
    providerId: provider.id,
    locationId: location.id,
    serviceId: input.serviceId ?? visit.serviceId,
    status: 'scheduled',
    updatedAt: at,
    history: appendHistory(visit.history, visit.startsAt ? 'rescheduled' : 'scheduled', input.actor, `${startsAt} · ${provider.name}`),
  });
  if (!value) return err('NOT_FOUND', 'The visit disappeared while it was being scheduled.');
  if (job.status === 'unscheduled') {
    update<JobDoc>('fieldJobs', job.id, {
      status: 'scheduled',
      updatedAt: at,
      history: appendHistory(job.history, 'visit_scheduled', input.actor, visit.reference),
    });
  }
  audit({ orgId: input.orgId, actor: input.actor.label, action: visit.startsAt ? 'field.visit_rescheduled' : 'field.visit_scheduled', target: visit.id, detail: `${startsAt} · ${provider.name}` });
  return ok(value);
}

export function updateVisit(input: {
  orgId: string;
  id: string;
  instructions?: string;
  workPerformed?: string;
  completionNote?: string;
  actor: Actor;
}): Result<VisitDoc> {
  const visit = visitById(input.orgId, input.id);
  if (!visit) return err('NOT_FOUND', 'No such visit in this workspace.');
  const patch: Partial<VisitDoc> = {};
  if (input.instructions !== undefined) patch.instructions = String(input.instructions).trim() || undefined;
  if (input.workPerformed !== undefined) patch.workPerformed = String(input.workPerformed).trim() || undefined;
  if (input.completionNote !== undefined) patch.completionNote = String(input.completionNote).trim() || undefined;
  const value = update<VisitDoc>('fieldVisits', visit.id, {
    ...patch,
    updatedAt: nowIso(),
    history: appendHistory(visit.history, 'work_updated', input.actor, Object.keys(patch).join(', ')),
  });
  if (!value) return err('NOT_FOUND', 'The visit disappeared while it was being updated.');
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.visit_updated', target: visit.id, detail: Object.keys(patch).join(', ') });
  return ok(value);
}

const VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  unassigned: ['scheduled', 'cancelled'],
  scheduled: ['en_route', 'on_site', 'completed', 'cancelled'],
  en_route: ['on_site', 'cancelled'],
  on_site: ['completed', 'cancelled'],
  completed: ['scheduled'],
  cancelled: ['scheduled', 'unassigned'],
};

export function setVisitStatus(input: { orgId: string; id: string; status: VisitStatus; note?: string; actor: Actor; reopen?: boolean }): Result<VisitDoc> {
  const visit = visitById(input.orgId, input.id);
  if (!visit) return err('NOT_FOUND', 'No such visit in this workspace.');
  const job = jobById(input.orgId, visit.jobId);
  if (!job) return err('NOT_FOUND', 'The visit\'s job is no longer available.');
  if (visit.status === input.status) return ok(visit);
  const terminal = visit.status === 'completed' || visit.status === 'cancelled';
  if (terminal && !input.reopen) {
    return err('CONFLICT', `This visit is ${visit.status}. Use the explicit reopen action first.`);
  }
  if (input.reopen && !terminal) return err('CONFLICT', 'Only a completed or cancelled visit can be reopened.');
  if (!VISIT_TRANSITIONS[visit.status].includes(input.status)) {
    return err('CONFLICT', `${visit.reference} cannot move from ${visit.status} to ${input.status}.`, `Allowed: ${VISIT_TRANSITIONS[visit.status].join(', ') || 'none'}`);
  }
  const needsSchedule = ['scheduled', 'en_route', 'on_site', 'completed'].includes(input.status);
  if (needsSchedule && (!visit.bookingId || !visit.startsAt || !visit.providerId)) return err('CONFLICT', 'Assign and schedule this visit before changing its field status.');
  const at = nowIso();
  if (visit.bookingId) {
    if (input.status === 'completed') {
      const booking = bookingById(input.orgId, visit.bookingId);
      if (booking && booking.status !== 'completed') {
        const changed = setAppointmentStatus({ orgId: input.orgId, id: booking.id, status: 'completed', note: input.note, actor: input.actor.id, actorName: input.actor.label });
        if (!changed.ok) return err('CONFLICT', changed.message);
      }
    } else if (input.status === 'cancelled') {
      const booking = bookingById(input.orgId, visit.bookingId);
      if (booking && booking.status !== 'cancelled') {
        const changed = setAppointmentStatus({ orgId: input.orgId, id: booking.id, status: 'cancelled', note: input.note, actor: input.actor.id, actorName: input.actor.label });
        if (!changed.ok) return err('CONFLICT', changed.message);
      }
    } else if (input.reopen && input.status === 'scheduled') {
      const booking = bookingById(input.orgId, visit.bookingId);
      if (booking && booking.status !== 'confirmed') {
        const changed = setAppointmentStatus({ orgId: input.orgId, id: booking.id, status: 'confirmed', note: input.note, actor: input.actor.id, actorName: input.actor.label });
        if (!changed.ok) return err('CONFLICT', changed.message);
      }
    }
  }
  const value = update<VisitDoc>('fieldVisits', visit.id, {
    status: input.status,
    completedAt: input.status === 'completed' ? at : input.reopen ? undefined : visit.completedAt,
    cancelledAt: input.status === 'cancelled' ? at : input.reopen ? undefined : visit.cancelledAt,
    completionNote: input.status === 'completed' && input.note ? input.note : visit.completionNote,
    updatedAt: at,
    history: appendHistory(visit.history, input.reopen ? `reopened:${input.status}` : `status:${input.status}`, input.actor, input.note),
  });
  if (!value) return err('NOT_FOUND', 'The visit disappeared while it was being updated.');
  if (['en_route', 'on_site'].includes(input.status) && job.status !== 'in_progress') {
    update<JobDoc>('fieldJobs', job.id, {
      status: 'in_progress',
      updatedAt: at,
      history: appendHistory(job.history, 'work_started', input.actor, visit.reference),
    });
  }
  audit({ orgId: input.orgId, actor: input.actor.label, action: input.reopen ? 'field.visit_reopened' : `field.visit_${input.status}`, target: visit.id, detail: input.note });
  return ok(value);
}

/* ----------------------------------------------------------------- invoice */

export function invoiceJob(input: { orgId: string; id: string; actor: Actor }): Result<{ job: JobDoc; invoice: InvoiceDoc }> {
  const job = jobById(input.orgId, input.id);
  if (!job) return err('NOT_FOUND', 'No such job in this workspace.');
  if (job.status !== 'completed') return err('CONFLICT', 'Complete the job before drafting its invoice.');
  if (job.invoiceId) return err('CONFLICT', `${job.reference} already has an invoice.`, job.invoiceId);
  if (!job.lines.length) return err('VALIDATION_ERROR', 'Add confirmed job or estimate lines before invoicing this job.');
  const bookingIds = visitsFor(input.orgId, { jobId: job.id }).map((visit) => visit.bookingId).filter(Boolean) as string[];
  const lines: LineInput[] = job.lines.map((line) => ({
    description: line.description,
    qty: line.quantity,
    unitAmountMinor: line.unitAmountMinor,
    taxRatePct: line.taxRatePct,
    code: line.code,
  }));
  const created = createInvoice({
    orgId: input.orgId,
    clientId: job.clientId,
    lines,
    bookingIds,
    notes: `Drafted from field job ${job.reference}. Service address: ${formatSite(job.siteAddress)}`,
    source: 'manual',
    actor: input.actor.id,
    actorName: input.actor.label,
    currency: job.currency,
  });
  if (!created.ok) return err(created.code === 'NOT_FOUND' ? 'NOT_FOUND' : created.code === 'VALIDATION_ERROR' ? 'VALIDATION_ERROR' : 'CONFLICT', created.error, created.detail);
  const updated = update<JobDoc>('fieldJobs', job.id, {
    invoiceId: created.value.id,
    updatedAt: nowIso(),
    history: appendHistory(job.history, 'invoice_drafted', input.actor, created.value.id),
  });
  if (!updated) return err('NOT_FOUND', 'The job disappeared after its invoice was created.', created.value.id);
  audit({ orgId: input.orgId, actor: input.actor.label, action: 'field.job_invoice_drafted', target: job.id, detail: created.value.id });
  return ok({ job: updated, invoice: created.value });
}

/* ------------------------------------------------------------------- views */

export function formatSite(site: SiteAddress): string {
  return [site.line1, site.line2, site.city, site.region, site.postalCode, site.country].filter(Boolean).join(', ');
}

export function fieldServiceSummary(orgId: string) {
  const enquiries = enquiriesFor(orgId);
  const estimates = estimatesFor(orgId);
  const jobs = jobsFor(orgId);
  const visits = visitsFor(orgId);
  const today = new Date().toISOString().slice(0, 10);
  return {
    enquiries: {
      open: enquiries.filter((row) => !['lost', 'closed', 'won'].includes(row.status)).length,
      urgent: enquiries.filter((row) => ['urgent', 'emergency'].includes(row.urgency) && !['lost', 'closed', 'won'].includes(row.status)).length,
    },
    estimates: {
      drafts: estimates.filter((row) => row.status === 'draft').length,
      awaitingDecision: estimates.filter((row) => row.status === 'sent').length,
      accepted: estimates.filter((row) => row.status === 'accepted').length,
    },
    jobs: {
      active: jobs.filter((row) => ['unscheduled', 'scheduled', 'in_progress'].includes(row.status)).length,
      unassigned: visits.filter((row) => row.status === 'unassigned').length,
      completedUninvoiced: jobs.filter((row) => row.status === 'completed' && !row.invoiceId).length,
    },
    visits: {
      today: visits.filter((row) => row.startsAt?.slice(0, 10) === today && !['cancelled', 'completed'].includes(row.status)).length,
      inProgress: visits.filter((row) => ['en_route', 'on_site'].includes(row.status)).length,
    },
  };
}
