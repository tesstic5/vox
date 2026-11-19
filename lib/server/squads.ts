/**
 * Squads: an ordered group of assistants that can hand a call between them.
 *
 * The docs promise two things about squads, and this module is where both are
 * true rather than aspirational:
 *
 *   1. a squad is a first-class resource with CRUD, and
 *   2. when a call's assistant decides to transfer, the call moves to the next
 *      member, and the handoff is written into the transcript as a `system` event
 *      carrying the brief.
 *
 * The handoff is deliberately one-way and ordered: members are tried in the order
 * they are listed, which is what makes "escalate to a specialist, then to a
 * human" predictable. The last member falls through to the number's own forward
 * target (the existing telephony behaviour) instead of handing off again.
 */

import { get, insert, list, newId, nowIso, update, remove, type Doc } from './db';
import { audit } from './audit';

/**
 * A member, in the shape the dashboard already stores and edits: which assistant,
 * what it is for, and the condition that routes to it. The API and the dashboard
 * write the same documents, so the shapes have to be one shape.
 */
export type SquadMember = {
  assistantId: string;
  role?: string;
  condition?: string;
};

export type SquadDoc = Doc & {
  orgId: string;
  name: string;
  /** Members in the order a call should be handed between them. */
  members: SquadMember[];
  /** Passed to the receiving assistant as the system transcript event. */
  brief?: string;
  createdAt: string;
};

/** Accepts a bare id or the full member object, so both clients are valid. */
export function normalizeMembers(input: unknown): SquadMember[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => {
      if (typeof entry === 'string') return { assistantId: entry };
      const record = entry as Record<string, unknown>;
      const assistantId = String(record?.assistantId ?? record?.id ?? '').trim();
      if (!assistantId) return undefined;
      return {
        assistantId,
        ...(record.role ? { role: String(record.role) } : {}),
        ...(record.condition ? { condition: String(record.condition) } : {}),
      };
    })
    .filter(Boolean) as SquadMember[];
}

export type Handoff = {
  fromId: string;
  toId: string;
  toName: string;
  brief: string;
};

export function squadsFor(orgId: string) {
  return list<SquadDoc>('squads', (s) => s.orgId === orgId);
}

export function squadById(orgId: string, id: string) {
  const squad = get<SquadDoc>('squads', id);
  return squad && squad.orgId === orgId ? squad : undefined;
}

export function createSquad(orgId: string, input: { name: string; members?: SquadMember[]; brief?: string }) {
  const squad = insert<SquadDoc>('squads', {
    id: newId('squad_'),
    orgId,
    name: input.name,
    members: input.members ?? [],
    brief: input.brief,
    createdAt: nowIso(),
  } as SquadDoc);
  audit({ orgId, actor: 'dashboard', action: 'squad.created', target: squad.id, detail: squad.name });
  return squad;
}

export function updateSquad(orgId: string, id: string, patch: Partial<SquadDoc>) {
  const squad = squadById(orgId, id);
  if (!squad) return undefined;
  audit({ orgId, actor: 'dashboard', action: 'squad.updated', target: id, detail: Object.keys(patch).join(', ') });
  return update<SquadDoc>('squads', id, patch);
}

export function removeSquad(orgId: string, id: string) {
  const squad = squadById(orgId, id);
  if (!squad) return false;
  remove('squads', id);
  audit({ orgId, actor: 'dashboard', action: 'squad.deleted', target: id, detail: squad.name });
  return true;
}

/** The squad a member belongs to, if any. */
export function squadForAssistant(orgId: string, assistantId: string) {
  return squadsFor(orgId).find((s) => s.members.some((m) => m.assistantId === assistantId));
}

/**
 * Where a transfer should go, or `undefined` when the current assistant is the
 * last member — in which case the carrier-level forward stays in charge.
 */
export function handoffFor(orgId: string, assistantId: string): Handoff | undefined {
  const squad = squadForAssistant(orgId, assistantId);
  if (!squad) return undefined;
  const index = squad.members.findIndex((m) => m.assistantId === assistantId);
  const nextId = squad.members[index + 1]?.assistantId;
  if (!nextId) return undefined;
  const next = get<Doc & { name?: string }>('assistants', nextId);
  if (!next || next.orgId !== orgId) return undefined;
  return {
    fromId: assistantId,
    toId: nextId,
    toName: String(next.name ?? 'the next assistant'),
    brief: squad.brief ?? `Transfer from ${squad.name}`,
  };
}

/** Records the handoff on the call and repoints it at the receiving assistant. */
export function applyHandoff(input: { orgId: string; callId: string; handoff: Handoff; atSeconds: number }) {
  const call = get<Doc & { transcript?: unknown[] }>('calls', input.callId);
  if (!call) return undefined;
  const transcript = [
    ...(call.transcript ?? []),
    {
      role: 'system' as const,
      text: `Handoff to ${input.handoff.toName} — ${input.handoff.brief}`,
      at: input.atSeconds,
      seconds: input.atSeconds,
      engine: 'handoff',
    },
  ];
  const updated = update<Doc>('calls', input.callId, { assistantId: input.handoff.toId, transcript });
  audit({
    orgId: input.orgId,
    actor: 'telephony',
    action: 'call.handed_off',
    target: input.callId,
    detail: `${input.handoff.fromId} → ${input.handoff.toId} (${input.handoff.brief})`,
  });
  return updated;
}
