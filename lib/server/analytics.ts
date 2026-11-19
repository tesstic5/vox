/**
 * Analytics aggregates.
 *
 * The docs described `/analytics/*` as "pre-aggregated, cached, and consistent
 * with what the dashboard renders". Rather than keep that promise in prose, this
 * module computes the numbers from the same records the dashboard reads — the
 * `calls` and `usageEvents` documents — so an API response and a dashboard
 * screenshot cannot disagree, because they are the same arithmetic.
 *
 * Everything is derived from ended calls inside the requested window. Nothing is
 * seeded, estimated or back-filled; a workspace with no calls gets zeroes.
 */

import { listAllByOrg, type Doc } from './db';
import type { CallDoc } from './calls';

const DAY = 86_400_000;

export type Window = { start: number; end: number; label: string };

/** Reads `startDate`/`endDate`/`days` off a URL, defaulting to the last 7 days. */
export function windowFrom(url: URL): Window {
  const endParam = url.searchParams.get('endDate');
  const startParam = url.searchParams.get('startDate');
  const days = Math.min(Number(url.searchParams.get('days') ?? 7) || 7, 365);
  const end = endParam ? Date.parse(endParam) : Date.now();
  const start = startParam ? Date.parse(startParam) : end - days * DAY;
  const safeEnd = Number.isFinite(end) ? end : Date.now();
  const safeStart = Number.isFinite(start) ? start : safeEnd - days * DAY;
  return { start: safeStart, end: safeEnd, label: `${new Date(safeStart).toISOString()} → ${new Date(safeEnd).toISOString()}` };
}

function callsIn(orgId: string, w: Window, assistantId?: string | null) {
  return listAllByOrg<CallDoc>('calls', orgId).filter((c) => {
    if (assistantId && c.assistantId !== assistantId) return false;
    const at = Date.parse(c.startedAt);
    return at >= w.start && at <= w.end;
  });
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const money = (n: number) => n.toFixed(4);
const pct = (part: number, whole: number) => (whole ? Number((part / whole).toFixed(3)) : 0);

export function overview(orgId: string, w: Window, options: { assistantId?: string | null; granularity?: string }) {
  const calls = callsIn(orgId, w, options.assistantId);
  const ended = calls.filter((c) => c.status === 'ended');
  const minutes = ended.reduce((n, c) => n + c.durationSeconds / 60, 0);
  const cost = ended.reduce((n, c) => n + c.cost.total, 0);
  const evaluated = ended.filter((c) => c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false');
  const resolved = evaluated.filter((c) => c.analysis.successEvaluation === 'true').length;
  const transferred = ended.filter((c) => Boolean(c.endedReason?.includes('forwarded')) || c.analysis.intent === 'transfer').length;

  // Series buckets: hour for short windows, day otherwise, week when asked.
  const granularity = options.granularity === 'hour' || options.granularity === 'week' ? options.granularity : 'day';
  const bucketKey = (ms: number) => {
    const d = new Date(ms);
    if (granularity === 'hour') return d.toISOString().slice(0, 13) + ':00Z';
    if (granularity === 'week') {
      const offset = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)).toISOString().slice(0, 10);
    }
    return d.toISOString().slice(0, 10);
  };
  const buckets = new Map<string, { date: string; calls: number; minutes: number; cost: number; resolved: number; evaluated: number }>();
  for (const call of ended) {
    const key = bucketKey(Date.parse(call.startedAt));
    const row = buckets.get(key) ?? { date: key, calls: 0, minutes: 0, cost: 0, resolved: 0, evaluated: 0 };
    row.calls += 1;
    row.minutes += call.durationSeconds / 60;
    row.cost += call.cost.total;
    if (call.analysis.successEvaluation === 'true' || call.analysis.successEvaluation === 'false') {
      row.evaluated += 1;
      if (call.analysis.successEvaluation === 'true') row.resolved += 1;
    }
    buckets.set(key, row);
  }

  return {
    range: { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() },
    scope: { assistantId: options.assistantId ?? null },
    totals: {
      calls: calls.length,
      ended: ended.length,
      inProgress: calls.length - ended.length,
      minutes: Number(minutes.toFixed(2)),
      cost: money(cost),
      avgDurationSeconds: ended.length ? Math.round(ended.reduce((n, c) => n + c.durationSeconds, 0) / ended.length) : 0,
      evaluatedCalls: evaluated.length,
      successRate: evaluated.length ? pct(resolved, evaluated.length) : null,
      transferRate: pct(transferred, ended.length),
    },
    latency: {
      p50Ms: percentile(ended.map((c) => c.metrics.latencyMs).filter((n) => n > 0), 50),
      p90Ms: percentile(ended.map((c) => c.metrics.latencyMs).filter((n) => n > 0), 90),
      p99Ms: percentile(ended.map((c) => c.metrics.latencyMs).filter((n) => n > 0), 99),
    },
    // Derived only from cost components already stored on calls. This is not a
    // provider invoice or subscription rate.
    costPerMinute: minutes && cost ? money(cost / minutes) : null,
    series: [...buckets.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({
        date: row.date,
        calls: row.calls,
        minutes: Number(row.minutes.toFixed(2)),
        cost: money(row.cost),
        evaluatedCalls: row.evaluated,
        successRate: row.evaluated ? pct(row.resolved, row.evaluated) : null,
      })),
  };
}

export function costs(orgId: string, w: Window, options: { assistantId?: string | null }) {
  const ended = callsIn(orgId, w, options.assistantId).filter((c) => c.status === 'ended');
  const components = ended.reduce(
    (acc, c) => {
      acc.platform += c.cost.platform;
      acc.stt += c.cost.stt;
      acc.tts += c.cost.tts;
      acc.llm += c.cost.llm;
      acc.telephony += c.cost.telephony;
      acc.total += c.cost.total;
      return acc;
    },
    { platform: 0, stt: 0, tts: 0, llm: 0, telephony: 0, total: 0 }
  );

  // Component names do not prove which external vendor invoiced them. Provider
  // attribution stays unavailable until a provider receipt/usage import exists.
  const byProvider: { provider: string; component: string; cost: string; calls: number }[] = [];

  const byAssistant = Object.entries(
    ended.reduce<Record<string, { cost: number; minutes: number }>>((acc, c) => {
      const row = acc[c.assistantId] ?? { cost: 0, minutes: 0 };
      row.cost += c.cost.total;
      row.minutes += c.durationSeconds / 60;
      acc[c.assistantId] = row;
      return acc;
    }, {})
  ).map(([assistantId, row]) => ({ assistantId, cost: money(row.cost), minutes: Number(row.minutes.toFixed(2)) }));

  const events = listAllByOrg<Doc>('usageEvents', orgId);
  return {
    range: { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() },
    total: money(components.total),
    calls: ended.length,
    // Internal usage observations only; external provider reconciliation is not implemented.
    ledgerEvents: events.length,
    providerAttributionAvailable: false,
    components: {
      platform: money(components.platform),
      stt: money(components.stt),
      tts: money(components.tts),
      llm: money(components.llm),
      telephony: money(components.telephony),
    },
    byProvider,
    byAssistant,
  };
}

export function outcomes(orgId: string, w: Window, options: { assistantId?: string | null }) {
  const ended = callsIn(orgId, w, options.assistantId).filter((c) => c.status === 'ended');

  const byIntent = Object.entries(
    ended.reduce<Record<string, CallDoc[]>>((acc, c) => {
      acc[c.analysis.intent] = [...(acc[c.analysis.intent] ?? []), c];
      return acc;
    }, {})
  )
    .map(([intent, rows]) => {
      const evaluated = rows.filter((r) => r.analysis.successEvaluation === 'true' || r.analysis.successEvaluation === 'false');
      return {
        intent,
        calls: rows.length,
        evaluatedCalls: evaluated.length,
        successRate: evaluated.length
          ? pct(evaluated.filter((r) => r.analysis.successEvaluation === 'true').length, evaluated.length)
          : null,
        avgDurationSeconds: Math.round(rows.reduce((n, r) => n + r.durationSeconds, 0) / rows.length),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const byEndedReason = Object.entries(
    ended.reduce<Record<string, number>>((acc, c) => {
      const reason = c.endedReason ?? 'unknown';
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {})
  ).map(([endedReason, calls]) => ({ endedReason, calls }));

  const byTool = Object.entries(
    ended.reduce<Record<string, { calls: number; ok: number }>>((acc, c) => {
      for (const tool of c.toolCalls ?? []) {
        const row = acc[tool.name] ?? { calls: 0, ok: 0 };
        row.calls += 1;
        if (tool.status === 'ok') row.ok += 1;
        acc[tool.name] = row;
      }
      return acc;
    }, {})
  ).map(([tool, row]) => ({ tool, calls: row.calls, successRate: pct(row.ok, row.calls) }));

  // Bookings are the business outcome this product exists to move, so the
  // outcome report carries their end state too.
  const bookings = listAllByOrg<Doc & { orgId?: string; status?: string }>('bookings', orgId);
  const byBookingStatus = Object.entries(
    bookings.reduce<Record<string, number>>((acc, b) => {
      const status = String(b.status ?? 'unknown');
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {})
  ).map(([status, count]) => ({ status, count }));

  return {
    range: { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() },
    calls: ended.length,
    byIntent,
    byEndedReason,
    byTool,
    bookings: { total: bookings.length, byBookingStatus },
  };
}
