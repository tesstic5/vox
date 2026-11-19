/**
 * Sales leads.
 *
 * The marketing site's "Contact sales" form used to be a dead end: it
 * showed a thank-you message and stored nothing, so every enquiry was
 * silently lost. Leads are now a real collection with a small pipeline —
 * the point is not a CRM, it is that an enquiry becomes a row somebody
 * can work: contact it, book the demo, win or lose it, and write down
 * what happened.
 *
 * Leads belong to the platform, not to a workspace (the form sells
 * Voxera itself), so they carry no `orgId`. Access is gated in the API
 * route by the explicit operator allowlist, like the cross-workspace console.
 * Workspace owner/admin roles are not platform roles, even when the operator
 * list has not been configured.
 */

import { get, insert, list, newId, nowIso, update, type Doc } from './db';
import { isPlatformOperator } from './operator';

export const LEAD_STATUSES = ['new', 'contacted', 'demo', 'won', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadDoc = Doc & {
  name: string;
  email: string;
  company: string;
  role?: string;
  goal?: string;
  volume?: string;
  requirements?: string[];
  timeline?: string;
  phone?: string;
  notes?: string;
  status: LeadStatus;
  /** Free-text log lines added from the inbox, newest last. */
  log?: { at: string; by: string; text: string }[];
  assignee?: string;
  source: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type LeadInput = {
  name: string;
  email: string;
  company: string;
  role?: string;
  goal?: string;
  volume?: string;
  requirements?: string[];
  timeline?: string;
  phone?: string;
  notes?: string;
};

export function validateLead(input: Record<string, unknown>): { ok: true; value: LeadInput } | { ok: false; error: string; param: string } {
  const name = String(input.name ?? '').trim();
  if (name.length < 2) return { ok: false, error: 'A name is required.', param: 'name' };
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'A valid work email is required.', param: 'email' };
  const company = String(input.company ?? '').trim();
  if (company.length < 2) return { ok: false, error: 'A company is required.', param: 'company' };
  const clean = (v: unknown, max: number) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : undefined;
  };
  return {
    ok: true,
    value: {
      name: name.slice(0, 120),
      email,
      company: company.slice(0, 160),
      role: clean(input.role, 80),
      goal: clean(input.goal, 80),
      volume: clean(input.volume, 80),
      requirements: Array.isArray(input.requirements) ? input.requirements.map((r) => String(r).slice(0, 60)).slice(0, 12) : undefined,
      timeline: clean(input.timeline, 80),
      phone: clean(input.phone, 40),
      notes: clean(input.notes, 2000),
    } as LeadInput,
  };
}

export function createLead(value: LeadInput, source = 'sales-form'): LeadDoc {
  const doc: LeadDoc = { ...value, id: newId('lead_'), status: 'new', source, log: [], createdAt: nowIso() };
  return insert<LeadDoc>('salesLeads', doc);
}

export function listLeads(status?: string): LeadDoc[] {
  const rows = list<LeadDoc>('salesLeads');
  return status && (LEAD_STATUSES as readonly string[]).includes(status) ? rows.filter((l) => l.status === status) : rows;
}

export function leadStats(): Record<LeadStatus, number> & { total: number } {
  const rows = list<LeadDoc>('salesLeads');
  const out = { new: 0, contacted: 0, demo: 0, won: 0, lost: 0, total: rows.length } as Record<LeadStatus, number> & { total: number };
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

export function updateLead(id: string, patch: { status?: string; assignee?: string; note?: string }, by: string): LeadDoc | undefined {
  const lead = get<LeadDoc>('salesLeads', id);
  if (!lead) return undefined;
  const next: Partial<LeadDoc> = {};
  if (patch.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(patch.status)) return undefined;
    next.status = patch.status as LeadStatus;
  }
  if (patch.assignee !== undefined) next.assignee = String(patch.assignee).slice(0, 120);
  if (patch.note !== undefined && String(patch.note).trim()) {
    next.log = [...(lead.log ?? []), { at: nowIso(), by, text: String(patch.note).trim().slice(0, 1000) }];
  }
  if (next.status && next.status !== lead.status) {
    next.log = [...(next.log ?? lead.log ?? []), { at: nowIso(), by, text: `status: ${lead.status} → ${next.status}` }];
  }
  return update<LeadDoc>('salesLeads', id, next);
}

/** Who may work the pipeline. See the module comment for the reasoning. */
export function canWorkLeads(user: { email?: string; role?: string } | undefined): boolean {
  return isPlatformOperator(user);
}
