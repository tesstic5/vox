/**
 * Platform operator console data — the view across every workspace.
 *
 * Workspaces administer themselves in the dashboard; this is the layer
 * above them, for whoever runs Voxera itself: how many workspaces exist,
 * who is using what, which queues are stuck, and the one blunt instrument
 * an operator needs — suspending a workspace. Access is gated by
 * `isPlatformOperator` in the route; nothing here trusts the client.
 */
import { dbStats, get, list, nowIso, projectFields, update, type Doc } from './db';
import { audit } from './audit';
import type { OrgDoc, UserDoc } from './auth';

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  region: string;
  createdAt: string;
  suspended: boolean;
  members: number;
  calls: number;
  minutes: number;
  spend: number;
  lastActivityAt: string | null;
}

export interface AdminOverview {
  source: 'server';
  generatedAt: string;
  totals: {
    orgs: number;
    suspendedOrgs: number;
    users: number;
    calls: number;
    minutes: number;
    spend: number;
  };
  queues: {
    messagesPending: number;
    messagesFailed: number;
    messagesBlocked: number;
    webhookFailed: number;
    webhookRetrying: number;
  };
  store: { collections: Record<string, number>; docs: number };
  orgs: AdminOrgRow[];
}

export function adminOverview(): AdminOverview {
  const orgs = list<OrgDoc>('orgs');
  const users = list<UserDoc>('users');
  const calls = projectFields('calls', ['orgId', 'durationSeconds', 'cost.total', 'startedAt']);
  const messages = list<Doc & { orgId?: string; status?: string }>('messages');
  const deliveries = list<Doc & { orgId?: string; status?: string }>('webhookDeliveries');
  const stats = dbStats();

  const byOrg = new Map<string, AdminOrgRow>();
  for (const org of orgs) {
    byOrg.set(org.id, {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      region: org.region,
      createdAt: org.createdAt,
      suspended: Boolean(org.suspended),
      members: 0,
      calls: 0,
      minutes: 0,
      spend: 0,
      lastActivityAt: null,
    });
  }
  for (const u of users) {
    const row = byOrg.get(u.orgId);
    if (row) row.members += 1;
  }
  let totalMinutes = 0;
  let totalSpend = 0;
  for (const c of calls) {
    const durationSeconds = Number(c.durationSeconds ?? 0);
    const spend = Number(c['cost.total'] ?? 0);
    const startedAt = String(c.startedAt ?? '');
    totalMinutes += durationSeconds / 60;
    totalSpend += spend;
    const row = byOrg.get(String(c.orgId ?? ''));
    if (!row) continue;
    row.calls += 1;
    row.minutes += durationSeconds / 60;
    row.spend += spend;
    if (startedAt && (!row.lastActivityAt || startedAt > row.lastActivityAt)) row.lastActivityAt = startedAt;
  }

  const count = (rows: { status?: string }[], status: string) => rows.filter((r) => r.status === status).length;
  return {
    source: 'server',
    generatedAt: nowIso(),
    totals: {
      orgs: orgs.length,
      suspendedOrgs: orgs.filter((o) => o.suspended).length,
      users: users.length,
      calls: calls.length,
      minutes: Number(totalMinutes.toFixed(1)),
      spend: Number(totalSpend.toFixed(2)),
    },
    queues: {
      messagesPending: count(messages, 'pending'),
      messagesFailed: count(messages, 'failed'),
      messagesBlocked: count(messages, 'blocked'),
      webhookFailed: count(deliveries, 'failed'),
      webhookRetrying: count(deliveries, 'retrying'),
    },
    store: { collections: stats, docs: Object.values(stats).reduce((s, n) => s + n, 0) },
    orgs: [...byOrg.values()]
      .map((r) => ({ ...r, minutes: Number(r.minutes.toFixed(1)), spend: Number(r.spend.toFixed(2)) }))
      .sort((a, b) => b.calls - a.calls),
  };
}

/** Suspend or reactivate a workspace, with an audit row left in that workspace. */
export function setOrgSuspended(orgId: string, suspended: boolean, actor: { userId: string; email: string }) {
  const org = get<OrgDoc>('orgs', orgId);
  if (!org) return null;
  const next = update<OrgDoc>('orgs', orgId, {
    suspended,
    suspendedAt: suspended ? nowIso() : undefined,
    suspendedBy: suspended ? actor.email : undefined,
  } as Partial<OrgDoc>);
  audit({
    orgId,
    actor: actor.email,
    action: suspended ? 'org.suspended' : 'org.reactivated',
    kind: 'operator',
    target: orgId,
    detail: suspended ? `Workspace suspended by operator ${actor.email}` : `Workspace reactivated by operator ${actor.email}`,
  });
  return next;
}
