/**
 * Growth: the funnel a workspace walks from signup to value.
 *
 * Until now the product measured a practice's business (reports) and a
 * call's journey (analytics), but never its own: how many workspaces
 * sign up, how many get an assistant live, how many take a first call.
 * You cannot fix a funnel you cannot see, so this computes it from the
 * rows that already exist — no tracking pixel, no new event pipeline:
 *
 *   signed up → created an assistant → published it → connected a
 *   number → took a first call → made a first booking → got paid
 *
 * A stage counts when a row proving it exists for that workspace. The
 * demo workspace (`voxera-demo`, the public call demo's home) is not a
 * customer and is excluded, as are workspaces with no owner user —
 * gate probes and fixtures sign up too, and counting them would make
 * the funnel a measure of the test suite.
 */

import { list, type Doc } from './db';

type OrgDoc = Doc & { name?: string; slug?: string; createdAt?: string };

export type FunnelStage = { id: string; label: string; workspaces: number; fromPrevious: number; fromStart: number };
export type GrowthReport = {
  stages: FunnelStage[];
  workspaces: number;
  activated: number;
  activationRate: number;
  medianHoursToFirstCall: number | null;
  signupsByWeek: { week: string; signups: number }[];
};

const STAGE_DEFS: { id: string; label: string; collection: string; test?: (d: Doc) => boolean }[] = [
  { id: 'assistant_created', label: 'Created an assistant', collection: 'assistants' },
  { id: 'assistant_published', label: 'Published an assistant', collection: 'assistants', test: (d) => (d as { status?: string }).status === 'published' },
  { id: 'number_connected', label: 'Connected a number', collection: 'numbers' },
  { id: 'first_call', label: 'Took a first call', collection: 'calls' },
  { id: 'first_booking', label: 'Made a first booking', collection: 'bookings' },
  { id: 'first_payment', label: 'Got paid', collection: 'payments' },
];

function realWorkspaces(): OrgDoc[] {
  const owners = new Set(
    list<Doc & { orgId?: string; role?: string }>('users', (u) => u.role === 'owner').map((u) => String(u.orgId))
  );
  return list<OrgDoc>('orgs', (o) => o.slug !== 'voxera-demo' && owners.has(String(o.id)));
}

export function growthReport(now = Date.now()): GrowthReport {
  const orgs = realWorkspaces();
  const orgIds = new Set(orgs.map((o) => String(o.id)));

  // Earliest timestamp per (stage, workspace) — the funnel, and the
  // activation clock, both read from this.
  const earliest = new Map<string, number>();
  for (const stage of STAGE_DEFS) {
    const rows = list<Doc & { orgId?: string; createdAt?: string; startedAt?: string }>(stage.collection, (d) =>
      orgIds.has(String((d as { orgId?: string }).orgId))
    );
    for (const row of rows) {
      if (stage.test && !stage.test(row)) continue;
      const at = Date.parse(String(row.startedAt ?? row.createdAt ?? ''));
      if (!Number.isFinite(at)) continue;
      const key = `${stage.id}:${String(row.orgId)}`;
      if (at < (earliest.get(key) ?? Infinity)) earliest.set(key, at);
    }
  }

  const stages: FunnelStage[] = [{ id: 'signed_up', label: 'Signed up', workspaces: orgs.length, fromPrevious: 100, fromStart: 100 }];
  // A funnel stage is cumulative: a workspace that made a web call before it
  // connected a number has certainly made a call, but it has not completed the
  // advertised signup → assistant → number → call path. Counting every proof in
  // isolation made a later stage wider than the stage before it, which is a set
  // of activity totals rather than a conversion funnel. Carry the qualifying
  // workspace set forward so every downstream count is an honest subset.
  let qualified = new Set(orgs.map((org) => String(org.id)));
  const cumulativeReached = new Map<string, number>();
  for (const def of STAGE_DEFS) {
    qualified = new Set([...qualified].filter((orgId) => earliest.has(`${def.id}:${orgId}`)));
    const n = qualified.size;
    cumulativeReached.set(def.id, n);
    const prev = stages[stages.length - 1].workspaces;
    stages.push({
      id: def.id,
      label: def.label,
      workspaces: n,
      fromPrevious: prev ? Math.round((n / prev) * 1000) / 10 : 0,
      fromStart: orgs.length ? Math.round((n / orgs.length) * 1000) / 10 : 0,
    });
  }

  const activations: number[] = [];
  for (const org of orgs) {
    const firstCall = earliest.get(`first_call:${String(org.id)}`);
    const signedUp = Date.parse(String(org.createdAt ?? ''));
    // Seeded and imported histories can predate the workspace row itself;
    // a negative "time to first call" is a data artefact, not a speed,
    // so those workspaces are left out of the median rather than
    // dragging it below zero.
    if (firstCall && Number.isFinite(signedUp) && firstCall >= signedUp) activations.push((firstCall - signedUp) / 3_600_000);
  }
  activations.sort((a, b) => a - b);
  const median = activations.length ? activations[Math.floor(activations.length / 2)] : null;

  const weeks = new Map<string, number>();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now - i * 7 * 86_400_000);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    weeks.set(monday.toISOString().slice(0, 10), 0);
  }
  for (const org of orgs) {
    const at = new Date(String(org.createdAt ?? ''));
    if (Number.isNaN(at.getTime())) continue;
    const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - ((at.getUTCDay() + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    if (weeks.has(key)) weeks.set(key, (weeks.get(key) ?? 0) + 1);
  }

  const activated = cumulativeReached.get('first_call') ?? 0;
  return {
    stages,
    workspaces: orgs.length,
    activated,
    activationRate: orgs.length ? Math.round((activated / orgs.length) * 1000) / 10 : 0,
    medianHoursToFirstCall: median !== null ? Math.round(median * 10) / 10 : null,
    signupsByWeek: [...weeks.entries()].map(([week, signups]) => ({ week, signups })),
  };
}
