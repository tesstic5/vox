/**
 * The recall screen's own API.
 *
 * `GET` is the desk reading the list — who is due, on whose window, and who is
 * standing in the way. `POST` is the desk acting on it: *send these*, or *send
 * everybody due*, plus one action for switching the daily loop on and off without
 * leaving the screen (it writes the same outreach rules the messaging screen does,
 * so the two can never disagree).
 *
 * Both go through `lib/server/recalls.ts`, which is also what the scheduler job
 * uses. A screen with its own copy of the rules is a screen that texts somebody
 * the job would have refused.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { outreachRules, setOutreachRules } from '@/lib/server/outreach-rules';
import { queueRecalls, recallCandidates, recallState, sendRecalls } from '@/lib/server/recalls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50));

  const state = recallState(ctx.orgId);
  const candidates = recallCandidates(ctx.orgId);
  return ok(
    {
      state,
      rules: outreachRules(ctx.orgId).recall,
      counts: {
        due: candidates.length,
        held: candidates.filter((c) => c.holdReason).length,
        blocked: candidates.filter((c) => !c.holdReason && c.blockedReason).length,
        sendable: candidates.filter((c) => !c.holdReason && !c.blockedReason).length,
      },
      rows: candidates.slice(0, limit).map((c) => ({
        clientId: c.clientId,
        name: c.name,
        number: c.number,
        email: c.email,
        lastSeenAt: c.lastSeenAt,
        lastSeenDays: c.lastSeenDays,
        intervalDays: c.intervalDays,
        intervalSource: c.intervalSource,
        overdueDays: c.overdueDays,
        serviceId: c.serviceId,
        serviceName: c.serviceName,
        channel: c.channel,
        to: c.to,
        /**
         * Exactly one of these, and the screen prints whichever is set. The
         * `sendable` / `held` / `blocked` trio is what the console reads; the
         * `reachable` / `holdReason` / `blockedReason` trio is the same verdict in
         * the words the reports use, so an API caller learns one vocabulary.
         */
        sendable: !c.holdReason && !c.blockedReason,
        reachable: !c.holdReason && !c.blockedReason,
        held: c.holdReason,
        holdReason: c.holdReason,
        holdKind: c.holdKind,
        blocked: c.holdReason ? undefined : c.blockedReason,
        blockedReason: c.holdReason ? undefined : c.blockedReason,
        lastRecallAt: c.lastRecallAt,
      })),
    },
    { requestId: ctx.requestId }
  );
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    action?: 'send' | 'send-all' | 'run-due' | 'save';
    clientIds?: string[];
    limit?: number;
    enabled?: boolean;
    channels?: string[];
    cooldownDays?: number;
    maxPerDay?: number;
  }>(req);
  if (body instanceof NextResponse) return body;

  if (body.action === 'save') {
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.channels !== undefined) patch.channels = body.channels;
    if (body.cooldownDays !== undefined) patch.cooldownDays = body.cooldownDays;
    if (body.maxPerDay !== undefined) patch.maxPerDay = body.maxPerDay;
    if (!Object.keys(patch).length) {
      return fail('VALIDATION_ERROR', 'Nothing to save — send `enabled`, `channels`, `cooldownDays` or `maxPerDay`.', { requestId: ctx.requestId });
    }
    const rules = setOutreachRules(ctx.orgId, { recall: patch } as never, ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard');
    return ok({ rules: rules.recall, state: recallState(ctx.orgId) }, { requestId: ctx.requestId });
  }

  if (body.action === 'run-due') {
    // The job's own path, for the desk that would rather see it work than wait
    // until tonight. Same ceiling, same everything.
    const result = queueRecalls(Date.now(), ctx.orgId);
    const run = Array.isArray(result) ? result[0] : result;
    return ok({ run }, { requestId: ctx.requestId });
  }

  if (body.action === 'send' || body.action === 'send-all') {
    const all = body.action === 'send-all';
    const clientIds = (body.clientIds ?? []).filter((id) => typeof id === 'string');
    if (!all && !clientIds.length) {
      return fail('VALIDATION_ERROR', 'Name the clients to recall, or use `send-all`.', { param: 'clientIds', requestId: ctx.requestId });
    }
    if (!all) {
      // An id that is not on the list is a screen that is out of date — say so
      // rather than quietly sending to a subset.
      const due = new Set(recallCandidates(ctx.orgId).map((c) => c.clientId));
      const stale = clientIds.filter((id) => !due.has(id));
      if (stale.length) {
        return fail('CONFLICT', `${stale.length} of those clients are no longer due a recall — reload the list.`, {
          detail: `Not due: ${stale.slice(0, 5).join(', ')}`,
          requestId: ctx.requestId,
        });
      }
    }
    const run = sendRecalls({
      orgId: ctx.orgId,
      clientIds,
      all,
      limit: body.limit,
      actor: ctx.auth === 'key' ? `key:${ctx.key?.id}` : 'dashboard',
      actorName: ctx.user?.name || ctx.user?.email,
    });
    return ok({ run, state: recallState(ctx.orgId) }, { requestId: ctx.requestId, status: 201 });
  }

  return fail('VALIDATION_ERROR', `Unknown action "${String(body.action ?? '')}".`, { requestId: ctx.requestId });
}
