import { NextResponse, type NextRequest } from 'next/server';
import { fail, requireAuth } from '@/lib/server/api';
import { callsForDay, type CallDoc } from '@/lib/server/calls';
import { audit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** RFC 4180-ish CSV cell. */
function cell(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const BASE_COLUMNS = ['id', 'assistantId', 'assistantName', 'type', 'status', 'startedAt', 'endedAt', 'durationSeconds'];

/**
 * GET /v1/analytics/export — a real export over the org's own call records.
 * `include=analysis,metrics,cost` widens the projection; `format=ndjson` streams
 * one JSON object per line instead.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const start = url.searchParams.get('startDate');
  const end = url.searchParams.get('endDate');
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();
  const include = new Set((url.searchParams.get('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const days = Number(url.searchParams.get('days') ?? 30) || 30;

  if (!['csv', 'ndjson', 'json'].includes(format)) {
    return fail('VALIDATION_ERROR', 'format must be csv, ndjson, or json.', { param: 'format', requestId: ctx.requestId });
  }

  let calls = callsForDay(ctx.orgId, days);
  if (start) calls = calls.filter((c) => c.startedAt >= start);
  if (end) calls = calls.filter((c) => c.startedAt <= `${end}T23:59:59.999Z`);

  const project = (call: CallDoc) => {
    const row: Record<string, unknown> = {};
    BASE_COLUMNS.forEach((k) => {
      row[k] = (call as unknown as Record<string, unknown>)[k];
    });
    row.endedReason = call.endedReason;
    row.from = call.from;
    row.to = call.to;
    row.turns = call.metrics.turns;
    if (include.has('analysis')) {
      row.intent = call.analysis.intent;
      row.sentiment = call.analysis.sentiment;
      row.successEvaluation = call.analysis.successEvaluation;
      row.summary = call.analysis.summary;
      row.structuredData = call.analysis.structuredData;
    }
    if (include.has('metrics')) {
      row.latencyMs = call.metrics.latencyMs;
      row.interruptions = call.metrics.interruptions;
      row.guardrails = (call.guardrails ?? []).map((g) => g.kind);
      row.toolCalls = (call.toolCalls ?? []).map((t) => t.name);
    }
    if (include.has('cost')) row.cost = call.cost;
    if (include.has('transcript')) row.transcript = call.transcript;
    return row;
  };

  const rows = calls.map(project);
  audit({
    orgId: ctx.orgId,
    actor: ctx.auth === 'key' ? `key:${ctx.key?.name}` : 'dashboard',
    action: 'analytics.export',
    detail: `${rows.length} calls · ${format}${include.size ? ` · ${[...include].join(',')}` : ''}`,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    return NextResponse.json(
      { object: 'list', window: { start: start ?? `${days}d`, end: end ?? stamp }, total: rows.length, data: rows },
      { headers: { 'x-request-id': ctx.requestId, 'content-disposition': `attachment; filename="voxera-calls-${stamp}.json"` } }
    );
  }
  if (format === 'ndjson') {
    return new NextResponse(rows.map((r) => JSON.stringify(r)).join('\n'), {
      headers: {
        'content-type': 'application/x-ndjson',
        'x-request-id': ctx.requestId,
        'content-disposition': `attachment; filename="voxera-calls-${stamp}.ndjson"`,
      },
    });
  }

  const header = Object.keys(rows[0] ?? { id: '', assistantId: '' });
  const csv = [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n');
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'x-request-id': ctx.requestId,
      'content-disposition': `attachment; filename="voxera-calls-${stamp}.csv"`,
    },
  });
}
