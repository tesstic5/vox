#!/usr/bin/env node
/**
 * Loopback production-runtime performance and scheduler check.
 *
 * This is deliberately not a Web-Vitals claim. It measures the built app that is
 * already running, records warm API latency/response weight, applies a small
 * concurrent health burst, and runs the idempotent retention job twice. Results
 * are persisted so an efficiency claim has numbers behind it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE = process.env.VOXERA_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
const PASSWORD = process.env.VOXERA_PASSWORD ?? 'demo-password-2026';
const ITERATIONS = Number(process.env.VOXERA_PERF_ITERATIONS ?? 12);
const ARTIFACT = 'screenshots/runtime-performance-check.json';

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function timed(path, init = {}) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  return {
    path,
    status: response.status,
    ms: Number((performance.now() - started).toFixed(1)),
    bytes: Buffer.byteLength(text),
    setCookie: response.headers.get('set-cookie') ?? '',
    body: (() => {
      try { return JSON.parse(text); } catch { return text; }
    })(),
  };
}

const login = await timed('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 200) {
  console.error(`login failed: HTTP ${login.status}`);
  process.exit(2);
}
const cookie = login.setCookie.split(';')[0];
if (!cookie) {
  console.error('login returned no session cookie');
  process.exit(2);
}
const auth = { cookie };

const targets = [
  { name: 'health', path: '/api/health', budgetMs: 100, headers: {} },
  { name: 'session', path: '/api/auth/me', budgetMs: 150, headers: auth },
  { name: 'workspace profile', path: '/api/v1/workspace/profile', budgetMs: 200, headers: auth },
  { name: 'three-day diary', path: '/api/v1/day?days=3', budgetMs: 300, headers: auth },
  { name: 'clients', path: '/api/v1/clients?limit=50', budgetMs: 300, headers: auth },
  { name: 'reports', path: '/api/v1/reports', budgetMs: 500, headers: auth },
  { name: 'invoice list', path: '/api/v1/invoices?include=all', budgetMs: 400, headers: auth },
  { name: 'field jobs', path: '/api/v1/jobs', budgetMs: 300, headers: auth },
  { name: 'scheduler state', path: '/api/v1/scheduler', budgetMs: 300, headers: auth },
];

const endpoints = [];
const issues = [];
for (const target of targets) {
  await timed(target.path, { headers: target.headers }); // warm route/module caches
  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    samples.push(await timed(target.path, { headers: target.headers }));
  }
  const times = samples.map((sample) => sample.ms);
  const statuses = [...new Set(samples.map((sample) => sample.status))];
  const result = {
    name: target.name,
    path: target.path,
    samples: samples.length,
    status: statuses,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(...times),
    averageBytes: Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0) / samples.length),
    budgetP95Ms: target.budgetMs,
  };
  if (statuses.length !== 1 || statuses[0] !== 200) issues.push(`${target.name}: statuses ${statuses.join(', ')}`);
  if (result.p95Ms > target.budgetMs) issues.push(`${target.name}: p95 ${result.p95Ms} ms > ${target.budgetMs} ms`);
  endpoints.push(result);
  console.log(`${issues.some((issue) => issue.startsWith(`${target.name}:`)) ? 'FAIL' : 'PASS'}  ${target.name.padEnd(20)} p50 ${String(result.p50Ms).padStart(6)} ms · p95 ${String(result.p95Ms).padStart(6)} ms · ${result.averageBytes} B`);
}

const burstSamples = await Promise.all(Array.from({ length: 32 }, () => timed('/api/health')));
const burstTimes = burstSamples.map((sample) => sample.ms);
const burst = {
  requests: burstSamples.length,
  ok: burstSamples.filter((sample) => sample.status === 200).length,
  p50Ms: percentile(burstTimes, 0.5),
  p95Ms: percentile(burstTimes, 0.95),
  maxMs: Math.max(...burstTimes),
  budgetP95Ms: 500,
};
if (burst.ok !== burst.requests) issues.push(`health burst: ${burst.ok}/${burst.requests} returned 200`);
if (burst.p95Ms > burst.budgetP95Ms) issues.push(`health burst: p95 ${burst.p95Ms} ms > ${burst.budgetP95Ms} ms`);
console.log(`${burst.ok === burst.requests && burst.p95Ms <= burst.budgetP95Ms ? 'PASS' : 'FAIL'}  32-request health burst p95 ${burst.p95Ms} ms`);

const schedulerBefore = await timed('/api/v1/scheduler', { headers: auth });
const runRetention = () => timed('/api/v1/scheduler', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'run', job: 'retention', force: true }),
});
const firstRetention = await runRetention();
const secondRetention = await runRetention();
const schedulerAfter = await timed('/api/v1/scheduler', { headers: auth });
const beforeJob = schedulerBefore.body?.jobs?.find?.((job) => job.name === 'retention');
const afterJob = schedulerAfter.body?.jobs?.find?.((job) => job.name === 'retention');
const scheduler = {
  running: schedulerAfter.body?.running === true,
  jobs: Array.isArray(schedulerAfter.body?.jobs) ? schedulerAfter.body.jobs.length : 0,
  firstRetention: firstRetention.body?.run ?? null,
  secondRetention: secondRetention.body?.run ?? null,
  runsBefore: beforeJob?.runs ?? null,
  runsAfter: afterJob?.runs ?? null,
  failuresBefore: beforeJob?.failures ?? null,
  failuresAfter: afterJob?.failures ?? null,
};
if (!scheduler.running) issues.push('scheduler: process ticker is not running');
if (scheduler.jobs < 8) issues.push(`scheduler: only ${scheduler.jobs} jobs reported`);
if (firstRetention.status !== 200 || firstRetention.body?.run?.ok !== true) issues.push('scheduler: first retention run failed');
if (secondRetention.status !== 200 || secondRetention.body?.run?.ok !== true) issues.push('scheduler: second retention run failed');
if (scheduler.runsBefore !== null && scheduler.runsAfter !== scheduler.runsBefore + 2) {
  issues.push(`scheduler: run count ${scheduler.runsBefore} -> ${scheduler.runsAfter}, expected +2`);
}
if (scheduler.failuresBefore !== null && scheduler.failuresAfter !== scheduler.failuresBefore) {
  issues.push(`scheduler: failures changed ${scheduler.failuresBefore} -> ${scheduler.failuresAfter}`);
}
if (!/nothing to sweep/i.test(String(secondRetention.body?.run?.detail ?? ''))) {
  issues.push(`scheduler: repeat retention was not idempotent (${String(secondRetention.body?.run?.detail ?? 'no detail')})`);
}
console.log(`${issues.some((issue) => issue.startsWith('scheduler:')) ? 'FAIL' : 'PASS'}  scheduler retention repeated safely · ${scheduler.runsBefore} → ${scheduler.runsAfter} runs`);

mkdirSync('screenshots', { recursive: true });
writeFileSync(ARTIFACT, JSON.stringify({
  at: new Date().toISOString(),
  base: BASE,
  loopback: true,
  iterations: ITERATIONS,
  loginMs: login.ms,
  endpoints,
  burst,
  scheduler,
  issues,
}, null, 2));

console.log(`\n${issues.length ? 'FAILED' : 'RUNTIME PERFORMANCE PASS'} · ${ARTIFACT}`);
if (issues.length) {
  for (const issue of issues) console.log(`  - ${issue}`);
  process.exit(1);
}
