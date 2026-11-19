import { NextResponse, type NextRequest } from 'next/server';
import { applyListQuery, fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { createCall } from '@/lib/server/calls';
import { list, listAllByOrg, type Doc } from '@/lib/server/db';
import type { CallDoc } from '@/lib/server/calls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v1/calls — history, with the filter vocabulary the reference documents.
 *
 * `?endedReason=in:error,customer-busy&durationSecondsGt=300&sort=score:asc` is a
 * real query: the published error taxonomy, a numeric range, and worst-first
 * ordering. `assistant_id`, `status` and `since` are kept as the short forms they
 * have always been; a filter field that does not exist is a 400, not an
 * unfiltered page.
 */
const CALL_FILTERS = [
  'status',
  'endedReason',
  'type',
  'source',
  'assistantId',
  'assistantName',
  'from',
  'to',
  'startedAt',
  'endedAt',
  'createdAt',
  'durationSeconds',
  'score',
  'intent',
  'cost',
  'campaignId',
  'bookingId',
  'customer.number',
];

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['calls:read'] });
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);

  let calls = listAllByOrg<CallDoc>('calls', ctx.orgId);
  const since = url.searchParams.get('since');
  if (since) {
    const t = new Date(since).getTime();
    if (!Number.isNaN(t)) calls = calls.filter((c) => new Date(c.startedAt).getTime() >= t);
  }

  const query = applyListQuery(calls as unknown as Record<string, unknown>[], url.searchParams, {
    fields: CALL_FILTERS,
    aliases: { score: 'analysis.score', intent: 'analysis.intent', cost: 'cost.total', assistant_id: 'assistantId' },
    sortable: ['startedAt', 'createdAt', 'endedAt', 'durationSeconds', 'score', 'cost'],
    defaultSort: { field: 'startedAt', dir: 'desc' },
    passthrough: ['limit', 'cursor', 'since', 't', 'format'],
  });
  if (query.error) {
    return fail('VALIDATION_ERROR', `Unknown filter field \`${query.error.field}\`.`, {
      param: query.error.field,
      detail: `Known fields: ${query.error.known.join(', ')}.`,
      requestId: ctx.requestId,
    });
  }

  const filtered = query.rows as unknown as CallDoc[];
  return ok(
    {
      object: 'list',
      data: filtered.slice(0, limit),
      total: filtered.length,
      has_more: filtered.length > limit,
      applied_filters: query.applied,
    },
    { requestId: ctx.requestId }
  );
}

/** POST /v1/calls — creates a call and returns the assistant's opening turn. */
export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req, { scopes: ['calls:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  const assistantId = String(body.assistantId ?? body.assistant_id ?? '');
  if (!assistantId) return fail('VALIDATION_ERROR', 'assistantId is required.', { param: 'assistantId', requestId: ctx.requestId });

  const assistant = list<Doc>('assistants', (a) => a.id === assistantId && a.orgId === ctx.orgId)[0];
  if (!assistant) {
    return fail('VALIDATION_ERROR', `No assistant with id ${assistantId} in this organisation.`, {
      param: 'assistantId',
      requestId: ctx.requestId,
    });
  }
  if (assistant.status !== 'published' && body.allowDraft !== true) {
    return fail('VALIDATION_ERROR', 'That assistant is still a draft. Publish it, or pass allowDraft: true to test it.', {
      param: 'assistantId',
      detail: 'invalid_assistant_config',
      requestId: ctx.requestId,
    });
  }

  const { call, error } = createCall({
    orgId: ctx.orgId,
    assistantId,
    type: (body.type as 'inbound' | 'outbound' | 'web') ?? 'web',
    from: String(body.from ?? '+14155550198'),
    to: String(body.to ?? '+14155550100'),
    customer: body.customer as { name: string; number: string } | undefined,
    source: ctx.auth === 'key' ? 'api' : 'dashboard',
    // A call can be opened *about* a booking — that is what makes the agent's
    // booking tools act on the real record instead of a template.
    bookingId: body.bookingId as string | undefined,
    campaignId: body.campaignId as string | undefined,
    purpose: body.purpose as string | undefined,
  });
  if (error || !call) return fail('VALIDATION_ERROR', 'The call could not be created.', { requestId: ctx.requestId });

  return ok(call, { requestId: ctx.requestId, status: 201 });
}
