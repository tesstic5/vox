/**
 * Real analytics math for the dashboard Overview and Analytics pages.
 *
 * Everything here is computed from the workspace's own call records — no
 * constants, no invented deltas. Both pages used to hardcode their trend
 * deltas ("+18.4%"), their latency sparklines and their latency-budget
 * breakdown; those numbers could not be true for any workspace.
 *
 * The same `buildAnalytics` runs in two places: server-side over every call
 * in the store (`GET /api/v1/analytics`, via `lib/server/calls.ts`), and
 * client-side as a fallback when there is no session. The dashboard only
 * ever holds the newest 100 calls (the list API caps a page at 100), so
 * client-only figures silently truncated — the server bundle is the truth
 * whenever it answers, and it says so through `source`.
 */
import type { Call } from './types';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The structural slice of a call the analytics need (client Call and server CallDoc both fit). */
export type AggCall = Pick<Call, 'assistantName' | 'status' | 'type' | 'startedAt' | 'durationSeconds' | 'cost' | 'metrics'> & {
  source?: string;
  analysis: Pick<Call['analysis'], 'successEvaluation' | 'intent' | 'score'>;
};

export interface AnalyticsBundle {
  calls: number;
  /** Explicit demo, simulation, public-demo, or dashboard browser-test rows. */
  testCalls: number;
  ended: number;
  resolved: number;
  /** Ended calls with an explicit pass/fail evaluation. */
  evaluated: number;
  /** Share of evaluated calls marked resolved, 0–100; inspect `evaluated` first. */
  containment: number;
  totalCost: number;
  platformCost: number;
  segments: { platform: number; stt: number; llm: number; tts: number; telephony: number };
  minutes: number;
  latency: { p50: number; p90: number; p99: number; samples: number };
  /** Share of latency samples at or under 500ms, 0–100. */
  under500Pct: number;
  peakConcurrency: number;
  avgScore: number;
  lowScoreCount: number;
  byIntent: { label: string; value: number }[];
  byAssistant: { name: string; calls: number; cost: number; resolved: number; evaluated: number }[];
  series: { label: string; calls: number; contained: number; cost: number; avgLatency: number }[];
}

export interface AnalyticsReport {
  days: number;
  current: AnalyticsBundle;
  previous: { calls: number; evaluated: number; containment: number; totalCost: number; p50: number };
}

export function inWindow(calls: Call[], now: number, days: number): Call[] {
  const from = now - days * DAY_MS;
  return calls.filter((c) => {
    const t = Date.parse(c.startedAt);
    return Number.isFinite(t) && t >= from && t <= now;
  });
}

/** The equal-length window immediately before the current one. */
export function previousWindow(calls: Call[], now: number, days: number): Call[] {
  const from = now - 2 * days * DAY_MS;
  const to = now - days * DAY_MS;
  return calls.filter((c) => {
    const t = Date.parse(c.startedAt);
    return Number.isFinite(t) && t >= from && t < to;
  });
}

/** Percentage change of `current` against `previous`; null when it cannot be said. */
export function deltaPct(current: number, previous: number): string | null {
  if (!previous) return null;
  const pct = ((current - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function percentile(values: number[], p: number): number {
  const xs = values.filter((n) => n > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
}

export function latencyStats(calls: AggCall[]) {
  const xs = calls.map((c) => c.metrics.latencyMs);
  return {
    p50: percentile(xs, 50),
    p90: percentile(xs, 90),
    p99: percentile(xs, 99),
    samples: xs.filter((n) => n > 0).length,
  };
}

/** Share of calls (0–100) whose voice-to-voice latency is at or under `budgetMs`. */
export function withinBudget(calls: AggCall[], budgetMs: number): number {
  const xs = calls.map((c) => c.metrics.latencyMs).filter((n) => n > 0);
  if (!xs.length) return 0;
  return (xs.filter((n) => n <= budgetMs).length / xs.length) * 100;
}

/** Peak number of calls running at the same instant, from real start/duration intervals. */
export function peakConcurrency(calls: AggCall[]): number {
  const events: { t: number; d: number }[] = [];
  for (const c of calls) {
    const start = Date.parse(c.startedAt);
    if (!Number.isFinite(start)) continue;
    events.push({ t: start, d: 1 });
    events.push({ t: start + Math.max(0, c.durationSeconds) * 1000, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function isTestCall(call: AggCall) {
  return (
    call.source === 'demo' ||
    call.source === 'simulation' ||
    call.source === 'public_demo' ||
    (call.type === 'web' && call.source === 'dashboard')
  );
}

function aggregate(calls: AggCall[]): Omit<AnalyticsBundle, 'series'> {
  const ended = calls.filter((c) => c.status === 'ended');
  const evaluatedCalls = ended.filter(
    (c) => c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false'
  );
  const resolved = evaluatedCalls.filter((c) => c.analysis.successEvaluation === 'true').length;
  const latSamples = ended.map((c) => c.metrics.latencyMs).filter((n) => n > 0);
  const sum = (f: (c: AggCall) => number) => calls.reduce((s, c) => s + f(c), 0);
  const segments = {
    platform: sum((c) => c.cost.platform),
    stt: sum((c) => c.cost.stt),
    llm: sum((c) => c.cost.llm),
    tts: sum((c) => c.cost.tts),
    telephony: sum((c) => c.cost.telephony),
  };
  const intents = new Map<string, number>();
  ended.forEach((c) => intents.set(c.analysis.intent, (intents.get(c.analysis.intent) ?? 0) + 1));
  const assistants = new Map<string, { name: string; calls: number; cost: number; resolved: number; evaluated: number }>();
  calls.forEach((c) => {
    const row = assistants.get(c.assistantName) ?? { name: c.assistantName, calls: 0, cost: 0, resolved: 0, evaluated: 0 };
    row.calls += 1;
    row.cost += c.cost.total;
    if (c.status === 'ended' && (c.analysis.successEvaluation === 'true' || c.analysis.successEvaluation === 'false')) {
      row.evaluated += 1;
      if (c.analysis.successEvaluation === 'true') row.resolved += 1;
    }
    assistants.set(c.assistantName, row);
  });
  return {
    calls: calls.length,
    testCalls: calls.filter(isTestCall).length,
    ended: ended.length,
    resolved,
    evaluated: evaluatedCalls.length,
    containment: evaluatedCalls.length ? (resolved / evaluatedCalls.length) * 100 : 0,
    totalCost: sum((c) => c.cost.total),
    platformCost: segments.platform,
    segments,
    minutes: sum((c) => c.durationSeconds) / 60,
    latency: latencyStats(ended),
    under500Pct: latSamples.length ? (latSamples.filter((n) => n <= 500).length / latSamples.length) * 100 : 0,
    peakConcurrency: peakConcurrency(calls),
    avgScore: evaluatedCalls.length
      ? Math.round(evaluatedCalls.reduce((s, c) => s + c.analysis.score, 0) / evaluatedCalls.length)
      : 0,
    lowScoreCount: evaluatedCalls.filter((c) => c.analysis.score < 60).length,
    byIntent: Array.from(intents.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label: label.replace(/_/g, ' '), value })),
    byAssistant: Array.from(assistants.values()).sort((a, b) => b.calls - a.calls),
  };
}

function seriesFor(calls: AggCall[], now: number, days: number): AnalyticsBundle['series'] {
  // Hourly buckets for a 24h view, daily up to 30 days, weekly beyond.
  const bucketMs = days === 1 ? HOUR_MS : days > 30 ? 7 * DAY_MS : DAY_MS;
  const count = Math.ceil((days * DAY_MS) / bucketMs);
  const buckets = new Map<string, { calls: number; contained: number; cost: number; lat: number[] }>();
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - i * bucketMs);
    const label = days === 1 ? t.toISOString().slice(11, 16) : t.toISOString().slice(5, 10);
    keys.push(label);
    buckets.set(label, { calls: 0, contained: 0, cost: 0, lat: [] });
  }
  for (const c of calls) {
    const t = Date.parse(c.startedAt);
    if (!Number.isFinite(t)) continue;
    const age = Math.floor((now - t) / bucketMs);
    const label = keys[keys.length - 1 - age];
    const b = label ? buckets.get(label) : undefined;
    if (!b) continue;
    b.calls += 1;
    b.cost += c.cost.total;
    if (c.metrics.latencyMs > 0) b.lat.push(c.metrics.latencyMs);
    if (c.status === 'ended' && c.analysis.successEvaluation === 'true') b.contained += 1;
  }
  return keys.map((label) => {
    const b = buckets.get(label)!;
    return {
      label,
      calls: b.calls,
      contained: b.contained,
      cost: Number(b.cost.toFixed(2)),
      avgLatency: b.lat.length ? Math.round(b.lat.reduce((s, x) => s + x, 0) / b.lat.length) : 0,
    };
  });
}

/** Full current-vs-previous analytics for a window, from any call list. */
export function buildAnalytics(calls: AggCall[], now: number, days: number): AnalyticsReport {
  const current = calls.filter((c) => {
    const t = Date.parse(c.startedAt);
    return Number.isFinite(t) && t >= now - days * DAY_MS && t <= now;
  });
  const previous = calls.filter((c) => {
    const t = Date.parse(c.startedAt);
    return Number.isFinite(t) && t >= now - 2 * days * DAY_MS && t < now - days * DAY_MS;
  });
  const prevAgg = aggregate(previous);
  return {
    days,
    current: { ...aggregate(current), series: seriesFor(current, now, days) },
    previous: {
      calls: prevAgg.calls,
      evaluated: prevAgg.evaluated,
      containment: prevAgg.containment,
      totalCost: prevAgg.totalCost,
      p50: prevAgg.latency.p50,
    },
  };
}
