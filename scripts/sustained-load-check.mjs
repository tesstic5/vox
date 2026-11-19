#!/usr/bin/env node
/**
 * Sustained, read-heavy controlled-pilot load gate.
 *
 * Run this against an optimized production process on the same VPS as PostgreSQL.
 * It drives a reproducible mix of diary, client, reporting, billing, field-service,
 * session and public-booking reads at a fixed arrival rate. A static sentinel
 * measures event-loop responsiveness independently of database health, while the
 * metrics endpoint records interval event-loop delay, utilization, memory and CPU.
 *
 * This is a single-practice pilot gate, not a high-scale or remote-database claim.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const DURATION_SECONDS = positiveNumber('VOXERA_LOAD_DURATION_SECONDS', 300);
const REQUESTS_PER_SECOND = positiveNumber('VOXERA_LOAD_RPS', 12);
const MAX_INFLIGHT = positiveInteger('VOXERA_LOAD_MAX_INFLIGHT', 32);
const SENTINEL_INTERVAL_MS = positiveNumber('VOXERA_LOAD_SENTINEL_INTERVAL_MS', 250);
const METRICS_INTERVAL_MS = positiveNumber('VOXERA_LOAD_METRICS_INTERVAL_MS', 5_000);
const REQUEST_TIMEOUT_MS = positiveNumber('VOXERA_LOAD_REQUEST_TIMEOUT_MS', 15_000);
const MAX_SCHEDULE_LAG_MS = positiveNumber('VOXERA_LOAD_MAX_SCHEDULE_LAG_MS', 1_000);
const ARTIFACT = process.env.VOXERA_LOAD_ARTIFACT ?? 'screenshots/sustained-load-check.json';

const BUDGETS = {
  p95Ms: positiveNumber('VOXERA_LOAD_P95_BUDGET_MS', 500),
  p99Ms: positiveNumber('VOXERA_LOAD_P99_BUDGET_MS', 1_000),
  sentinelP99Ms: positiveNumber('VOXERA_LOAD_SENTINEL_P99_BUDGET_MS', 500),
  eventLoopP99Ms: positiveNumber('VOXERA_LOAD_EVENT_LOOP_P99_BUDGET_MS', 200),
  eventLoopMaxMs: positiveNumber('VOXERA_LOAD_EVENT_LOOP_MAX_BUDGET_MS', 1_000),
  eventLoopUtilization: positiveNumber('VOXERA_LOAD_EVENT_LOOP_UTILIZATION_BUDGET', 0.95),
  // Keep at least ~20% headroom below the default 1536 MiB app cgroup limit.
  residentMemoryBytes: positiveNumber('VOXERA_LOAD_RSS_BUDGET_BYTES', 1_200 * 1024 * 1024),
};

function positiveNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function positiveInteger(name, fallback) {
  return Math.max(1, Math.floor(positiveNumber(name, fallback)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function request(path, { headers = {}, method = 'GET', body } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    return {
      path,
      status: response.status,
      ms: round(performance.now() - started),
      bytes,
      setCookie: response.headers.get('set-cookie') ?? '',
    };
  } catch (error) {
    return {
      path,
      status: 0,
      ms: round(performance.now() - started),
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
      setCookie: '',
    };
  }
}

function parseMetrics(text) {
  const values = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.includes('{')) continue;
    const split = line.lastIndexOf(' ');
    if (split <= 0) continue;
    const value = Number(line.slice(split + 1));
    if (Number.isFinite(value)) values[line.slice(0, split)] = value;
  }
  return values;
}

async function metricsSnapshot(label) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/api/metrics`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    return {
      label,
      at: new Date().toISOString(),
      status: response.status,
      ms: round(performance.now() - started),
      values: parseMetrics(text),
    };
  } catch (error) {
    return {
      label,
      at: new Date().toISOString(),
      status: 0,
      ms: round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
      values: {},
    };
  }
}

function summary(samples) {
  const times = samples.map((sample) => sample.ms);
  const statuses = {};
  for (const sample of samples) statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
  return {
    requests: samples.length,
    ok: samples.filter((sample) => sample.status >= 200 && sample.status < 300).length,
    statuses,
    p50Ms: round(percentile(times, 0.50)),
    p95Ms: round(percentile(times, 0.95)),
    p99Ms: round(percentile(times, 0.99)),
    maxMs: round(times.length ? Math.max(...times) : 0),
    averageBytes: samples.length ? Math.round(samples.reduce((total, sample) => total + sample.bytes, 0) / samples.length) : 0,
  };
}

const loginStarted = performance.now();
const loginResponse = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
await loginResponse.arrayBuffer();
const login = {
  status: loginResponse.status,
  ms: round(performance.now() - loginStarted),
};
const cookie = (loginResponse.headers.get('set-cookie') ?? '').split(';')[0];
if (login.status !== 200 || !cookie) {
  console.error(`login failed: HTTP ${login.status}${cookie ? '' : ' (no session cookie)'}`);
  process.exit(2);
}

const auth = { cookie };
const weightedTargets = [
  ...Array(5).fill({ name: 'three-day diary', path: '/api/v1/day?days=3', headers: auth }),
  ...Array(3).fill({ name: 'clients', path: '/api/v1/clients?limit=50', headers: auth }),
  ...Array(2).fill({ name: 'session', path: '/api/auth/me', headers: auth }),
  ...Array(2).fill({ name: 'workspace profile', path: '/api/v1/workspace/profile', headers: auth }),
  { name: 'reports', path: '/api/v1/reports', headers: auth },
  { name: 'invoices', path: '/api/v1/invoices?include=all', headers: auth },
  { name: 'field jobs', path: '/api/v1/jobs', headers: auth },
  { name: 'scheduler state', path: '/api/v1/scheduler', headers: auth },
  { name: 'public booking page', path: '/api/public/workspaces/northwind-labs/booking', headers: {} },
];
const uniqueTargets = [...new Map(weightedTargets.map((target) => [target.name, target])).values()];

console.log(`warming ${uniqueTargets.length} representative routes…`);
for (const target of uniqueTargets) {
  const warm = await request(target.path, { headers: target.headers });
  if (warm.status < 200 || warm.status >= 300) {
    console.error(`warmup failed for ${target.name}: HTTP ${warm.status}${warm.error ? ` (${warm.error})` : ''}`);
    process.exit(2);
  }
}

// The metrics endpoint resets its event-loop interval histogram after rendering.
const baselineMetrics = await metricsSnapshot('baseline');
if (baselineMetrics.status !== 200) {
  console.error(`metrics baseline failed: HTTP ${baselineMetrics.status}`);
  process.exit(2);
}

const planned = Math.floor(DURATION_SECONDS * REQUESTS_PER_SECOND);
const intervalMs = 1_000 / REQUESTS_PER_SECOND;
const samples = [];
const sentinelSamples = [];
const scheduleLagMs = [];
const metricsSnapshots = [];
const pending = new Set();
let dropped = 0;
let peakInflight = 0;
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const runEnds = runStarted + DURATION_SECONDS * 1_000;

async function sentinelLoop() {
  let due = runStarted;
  while (due < runEnds) {
    await sleep(due - performance.now());
    if (performance.now() >= runEnds) break;
    sentinelSamples.push(await request('/robots.txt'));
    due += SENTINEL_INTERVAL_MS;
  }
}

async function metricsLoop() {
  let due = runStarted + METRICS_INTERVAL_MS;
  let index = 1;
  while (due < runEnds) {
    await sleep(due - performance.now());
    if (performance.now() >= runEnds) break;
    metricsSnapshots.push(await metricsSnapshot(`interval-${index}`));
    index += 1;
    due += METRICS_INTERVAL_MS;
  }
}

const sentinelPromise = sentinelLoop();
const metricsPromise = metricsLoop();

console.log(`running ${DURATION_SECONDS}s at ${REQUESTS_PER_SECOND} req/s (max ${MAX_INFLIGHT} in flight)…`);
for (let index = 0; index < planned; index += 1) {
  const due = runStarted + index * intervalMs;
  if (due >= runEnds) break;
  await sleep(due - performance.now());
  const lag = Math.max(0, performance.now() - due);
  scheduleLagMs.push(lag);
  if (lag > MAX_SCHEDULE_LAG_MS || pending.size >= MAX_INFLIGHT) {
    dropped += 1;
    continue;
  }
  const target = weightedTargets[index % weightedTargets.length];
  let task;
  task = request(target.path, { headers: target.headers })
    .then((sample) => samples.push({ ...sample, name: target.name }))
    .finally(() => pending.delete(task));
  pending.add(task);
  peakInflight = Math.max(peakInflight, pending.size);
}

await Promise.all([...pending]);
await Promise.all([sentinelPromise, metricsPromise]);
metricsSnapshots.push(await metricsSnapshot('final'));
const runFinishedAt = new Date().toISOString();
const elapsedSeconds = (performance.now() - runStarted) / 1_000;

const overall = summary(samples);
const sentinel = summary(sentinelSamples);
const byEndpoint = uniqueTargets.map((target) => ({
  name: target.name,
  path: target.path,
  ...summary(samples.filter((sample) => sample.name === target.name)),
}));

const validMetricSnapshots = metricsSnapshots.filter((snapshot) => snapshot.status === 200);
const metricValues = validMetricSnapshots.map((snapshot) => snapshot.values);
const maximumMetric = (name) => Math.max(0, ...metricValues.map((values) => values[name] ?? 0));
const lastMetrics = validMetricSnapshots.at(-1)?.values ?? {};
const baselineValues = baselineMetrics.values;
const server = {
  scrapeIntervals: metricsSnapshots.length,
  successfulScrapes: validMetricSnapshots.length,
  eventLoopDelayP99IntervalPeakMs: round(maximumMetric('voxera_event_loop_delay_ms_p99'), 3),
  eventLoopDelayMaxMs: round(maximumMetric('voxera_event_loop_delay_ms_max'), 3),
  eventLoopUtilizationIntervalPeak: round(maximumMetric('voxera_event_loop_utilization_ratio'), 4),
  residentMemoryPeakBytes: maximumMetric('voxera_process_resident_memory_bytes'),
  heapUsedPeakBytes: maximumMetric('voxera_process_heap_used_bytes'),
  cpuUserSeconds: round(Math.max(0, (lastMetrics.voxera_process_cpu_user_seconds_total ?? 0) - (baselineValues.voxera_process_cpu_user_seconds_total ?? 0)), 3),
  cpuSystemSeconds: round(Math.max(0, (lastMetrics.voxera_process_cpu_system_seconds_total ?? 0) - (baselineValues.voxera_process_cpu_system_seconds_total ?? 0)), 3),
  recentHttpP99Ms: lastMetrics.voxera_http_request_duration_ms_p99 ?? null,
};

const issues = [];
if (overall.ok !== overall.requests) issues.push(`HTTP success: ${overall.ok}/${overall.requests}`);
if (dropped) issues.push(`arrival schedule dropped ${dropped}/${planned} request(s)`);
if (overall.p95Ms > BUDGETS.p95Ms) issues.push(`request p95 ${overall.p95Ms} ms > ${BUDGETS.p95Ms} ms`);
if (overall.p99Ms > BUDGETS.p99Ms) issues.push(`request p99 ${overall.p99Ms} ms > ${BUDGETS.p99Ms} ms`);
if (sentinel.ok !== sentinel.requests) issues.push(`static sentinel success: ${sentinel.ok}/${sentinel.requests}`);
if (sentinel.p99Ms > BUDGETS.sentinelP99Ms) issues.push(`static sentinel p99 ${sentinel.p99Ms} ms > ${BUDGETS.sentinelP99Ms} ms`);
if (validMetricSnapshots.length !== metricsSnapshots.length) issues.push(`metrics scrapes: ${validMetricSnapshots.length}/${metricsSnapshots.length} succeeded`);
if (server.eventLoopDelayP99IntervalPeakMs > BUDGETS.eventLoopP99Ms) {
  issues.push(`event-loop interval p99 peak ${server.eventLoopDelayP99IntervalPeakMs} ms > ${BUDGETS.eventLoopP99Ms} ms`);
}
if (server.eventLoopDelayMaxMs > BUDGETS.eventLoopMaxMs) {
  issues.push(`event-loop max ${server.eventLoopDelayMaxMs} ms > ${BUDGETS.eventLoopMaxMs} ms`);
}
if (server.eventLoopUtilizationIntervalPeak > BUDGETS.eventLoopUtilization) {
  issues.push(`event-loop utilization peak ${server.eventLoopUtilizationIntervalPeak} > ${BUDGETS.eventLoopUtilization}`);
}
if (server.residentMemoryPeakBytes > BUDGETS.residentMemoryBytes) {
  issues.push(`resident memory peak ${server.residentMemoryPeakBytes} B > ${BUDGETS.residentMemoryBytes} B`);
}

const artifact = {
  at: runFinishedAt,
  startedAt: runStartedAt,
  base: BASE,
  loopback: true,
  scope: 'single-workspace, read-heavy controlled physiotherapy pilot; not a remote-database or high-scale claim',
  config: {
    durationSeconds: DURATION_SECONDS,
    requestsPerSecond: REQUESTS_PER_SECOND,
    plannedRequests: planned,
    maxInflight: MAX_INFLIGHT,
    sentinelIntervalMs: SENTINEL_INTERVAL_MS,
    metricsIntervalMs: METRICS_INTERVAL_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    budgets: BUDGETS,
  },
  login,
  elapsedSeconds: round(elapsedSeconds, 3),
  achievedRequestsPerSecond: round(samples.length / elapsedSeconds, 3),
  dropped,
  peakInflight,
  scheduleLag: {
    p95Ms: round(percentile(scheduleLagMs, 0.95)),
    p99Ms: round(percentile(scheduleLagMs, 0.99)),
    maxMs: round(scheduleLagMs.length ? Math.max(...scheduleLagMs) : 0),
  },
  overall,
  byEndpoint,
  sentinel: { path: '/robots.txt', ...sentinel },
  server,
  baselineMetrics,
  metricsSnapshots,
  issues,
};

mkdirSync(ARTIFACT.slice(0, Math.max(0, ARTIFACT.lastIndexOf('/'))) || '.', { recursive: true });
writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`${issues.length ? 'FAIL' : 'PASS'}  HTTP ${overall.ok}/${overall.requests} · ${round(samples.length / elapsedSeconds, 1)} req/s · p95 ${overall.p95Ms} ms · p99 ${overall.p99Ms} ms`);
console.log(`${issues.length ? 'CHECK' : 'PASS'}  static sentinel p99 ${sentinel.p99Ms} ms · event-loop p99 interval peak ${server.eventLoopDelayP99IntervalPeakMs} ms · max ${server.eventLoopDelayMaxMs} ms`);
console.log(`${issues.length ? 'CHECK' : 'PASS'}  ELU peak ${server.eventLoopUtilizationIntervalPeak} · RSS peak ${(server.residentMemoryPeakBytes / 1024 / 1024).toFixed(1)} MiB · dropped ${dropped}`);
console.log(`artifact: ${ARTIFACT}`);
if (issues.length) {
  for (const issue of issues) console.log(`  - ${issue}`);
  process.exit(1);
}
