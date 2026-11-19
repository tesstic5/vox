import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

/**
 * Structured logs and process metrics.
 *
 * Two things a deployment needs that `console.log` cannot give it: lines a log
 * pipeline can parse without a regex per message, and a counter endpoint a
 * scraper can read. Both are deliberately small.
 *
 * ### Logs
 *
 * One JSON object per line on stdout — the shape every collector (Loki, CloudWatch,
 * Datadog, `jq`) already understands. The message stays human: person-readable in
 * a terminal, parseable in a pipeline. Levels follow the usual severity words so a
 * collector can filter without knowing this app.
 *
 * Request logs drop the query string. A link token, a claim token and a manage
 * token all live in a path or a query parameter somewhere in this product, and a
 * log pipeline is the last place one should be sitting in plain text.
 *
 * ### Metrics
 *
 * Counters live on `globalThis` rather than in a module variable, because Next
 * bundles each route handler separately: a module-level counter in `lib/server/*`
 * can exist several times in one process, and a metrics endpoint reading its own
 * copy would report near-zero while the app was busy. `globalThis` is allocated
 * once per process, which is the scope the numbers are about.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, string | number | boolean | null | undefined>;

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = String(process.env.VOXERA_LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

/** Values that must never reach a log line, whatever a caller passes. */
function scrub(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/secret|token|password|authorization|cookie|api[_-]?key/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function logEvent(level: Level, event: string, fields: Fields = {}) {
  if (LEVEL_ORDER[level] < threshold()) return;
  const line = {
    at: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...scrub(fields),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

/* ------------------------------------------------------------------ metrics */

type Metrics = {
  requests: Record<string, number>;
  durationsMs: number[];
  startedAt: number;
  schedulerRuns: number;
  schedulerErrors: number;
  eventLoopDelay: ReturnType<typeof monitorEventLoopDelay>;
  eventLoopBaseline: EventLoopUtilization;
};

const GLOBAL_KEY = '__voxeraMetrics';

function metrics(): Metrics {
  const scope = globalThis as unknown as Record<string, Metrics | undefined>;
  if (!scope[GLOBAL_KEY]) {
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    scope[GLOBAL_KEY] = {
      requests: {},
      durationsMs: [],
      startedAt: Date.now(),
      schedulerRuns: 0,
      schedulerErrors: 0,
      eventLoopDelay,
      eventLoopBaseline: performance.eventLoopUtilization(),
    };
  }
  return scope[GLOBAL_KEY]!;
}

export function observeRequest(status: number, durationMs: number) {
  const m = metrics();
  const klass = `${Math.floor(status / 100)}xx`;
  m.requests[klass] = (m.requests[klass] ?? 0) + 1;
  m.durationsMs.push(durationMs);
  // Keep a bounded window: a process that runs for a month should not accumulate
  // one number per request forever.
  if (m.durationsMs.length > 2048) m.durationsMs.splice(0, m.durationsMs.length - 2048);
}

export function observeSchedulerRun(failed: boolean) {
  const m = metrics();
  m.schedulerRuns += 1;
  if (failed) m.schedulerErrors += 1;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Prometheus text exposition format — no client library, no dependency. */
export function renderPrometheus(extra: Record<string, number> = {}): string {
  const m = metrics();
  const lines: string[] = [];
  const push = (name: string, help: string, type: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };

  lines.push('# HELP voxera_up Whether the process is serving requests.');
  lines.push('# TYPE voxera_up gauge');
  lines.push('voxera_up 1');
  push('voxera_uptime_seconds', 'Seconds since this process started.', 'gauge', Math.round((Date.now() - m.startedAt) / 1000));
  push('voxera_scheduler_runs_total', 'Scheduler ticks executed by this process.', 'counter', m.schedulerRuns);
  push('voxera_scheduler_errors_total', 'Scheduler ticks that threw.', 'counter', m.schedulerErrors);

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const eventLoop = performance.eventLoopUtilization(m.eventLoopBaseline);
  m.eventLoopBaseline = performance.eventLoopUtilization();
  const delaySamples = Number(m.eventLoopDelay.count);
  const delayMs = (nanoseconds: number) => Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : 0;
  push('voxera_process_resident_memory_bytes', 'Resident memory used by this process.', 'gauge', memory.rss);
  push('voxera_process_heap_used_bytes', 'V8 heap memory used by this process.', 'gauge', memory.heapUsed);
  push('voxera_process_heap_total_bytes', 'V8 heap memory allocated by this process.', 'gauge', memory.heapTotal);
  push('voxera_process_cpu_user_seconds_total', 'User CPU consumed by this process.', 'counter', cpu.user / 1e6);
  push('voxera_process_cpu_system_seconds_total', 'System CPU consumed by this process.', 'counter', cpu.system / 1e6);
  push('voxera_event_loop_utilization_ratio', 'Event-loop utilization since the previous metrics scrape.', 'gauge', eventLoop.utilization);
  push('voxera_event_loop_delay_ms_p50', 'Event-loop delay p50 since the previous metrics scrape.', 'gauge', delaySamples ? delayMs(m.eventLoopDelay.percentile(50)) : 0);
  push('voxera_event_loop_delay_ms_p95', 'Event-loop delay p95 since the previous metrics scrape.', 'gauge', delaySamples ? delayMs(m.eventLoopDelay.percentile(95)) : 0);
  push('voxera_event_loop_delay_ms_p99', 'Event-loop delay p99 since the previous metrics scrape.', 'gauge', delaySamples ? delayMs(m.eventLoopDelay.percentile(99)) : 0);
  push('voxera_event_loop_delay_ms_max', 'Maximum event-loop delay since the previous metrics scrape.', 'gauge', delaySamples ? delayMs(m.eventLoopDelay.max) : 0);
  push('voxera_event_loop_delay_samples', 'Event-loop delay samples since the previous metrics scrape.', 'gauge', delaySamples);
  m.eventLoopDelay.reset();

  lines.push('# HELP voxera_http_requests_total Requests served, by status class.');
  lines.push('# TYPE voxera_http_requests_total counter');
  for (const [klass, count] of Object.entries(m.requests)) lines.push(`voxera_http_requests_total{class="${klass}"} ${count}`);

  push('voxera_http_request_duration_ms', 'Recent request duration (p50), milliseconds.', 'gauge', Math.round(percentile(m.durationsMs, 50)));
  push('voxera_http_request_duration_ms_p99', 'Recent request duration (p99), milliseconds.', 'gauge', Math.round(percentile(m.durationsMs, 99)));

  for (const [name, value] of Object.entries(extra)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
