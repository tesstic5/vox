/**
 * Production entry point.
 *
 * `next start` cannot accept a WebSocket upgrade, and the media-stream path needs
 * exactly that: a socket that stays open for the length of a phone call. So the
 * app is mounted on a plain Node HTTP server here, and the media worker attaches
 * its own upgrade handler alongside it.
 *
 * Everything except `/api/telephony/twilio/media` is untouched — Next handles
 * every HTTP request exactly as it would under `next start`, which is why
 * `npm start` and `npm run start:next` behave identically for the rest of the
 * app. `tsx` runs this file directly so the worker can be written in TypeScript
 * and import from `lib/server/*` like any other server module.
 */

import { createServer } from 'node:http';
import next from 'next';
import { attachMediaWorker } from './lib/server/media/worker';
import { claimScheduler } from './lib/server/instance-lock';
import { logEvent, observeRequest, observeSchedulerRun } from './lib/server/log';
import { mediaSigningAvailable } from './lib/server/media/secret';
import { startMaintenance } from './lib/server/maintenance';
import { startScheduler } from './lib/server/scheduler';
import { normalizeLegacyInferredCallClaims } from './lib/server/calls';
import { normalizeLegacyToolHeaders } from './lib/server/tools';
import { normalizeLegacyWebhookSecrets } from './lib/server/webhooks';
import { normalizeLegacyRetentionClaims } from './lib/server/retention-policy';
import { resolvedClientIp } from './lib/server/request-ip';
import { assertProductionConfig } from './lib/server/production-config';
import { closeStore } from './lib/server/db';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const dev = process.env.NODE_ENV !== 'production';

async function main() {
  const config = assertProductionConfig();
  if (config.strict) logEvent('info', 'config.production_valid', { profile: config.profile });
  else if (!dev) logEvent('warn', 'config.production_not_strict', { warnings: config.warnings.length, errors: config.errors.length });

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const normalizedClaims = normalizeLegacyInferredCallClaims();
  if (normalizedClaims.migrated) {
    logEvent('info', 'migration.call_claims', normalizedClaims);
  }
  const normalizedToolHeaders = normalizeLegacyToolHeaders();
  if (normalizedToolHeaders.migrated) {
    logEvent('info', 'migration.tool_headers', normalizedToolHeaders);
  }
  const normalizedWebhookSecrets = normalizeLegacyWebhookSecrets();
  if (normalizedWebhookSecrets.migrated) {
    logEvent('info', 'migration.webhook_secrets', normalizedWebhookSecrets);
  }
  const normalizedRetention = normalizeLegacyRetentionClaims();
  if (normalizedRetention.migrated) {
    logEvent('info', 'migration.retention_claims', {
      migrated: normalizedRetention.migrated,
      clients: normalizedRetention.collections.clients,
      notes: normalizedRetention.collections.notes,
    });
  }

  /**
   * Every request, logged once, in one line.
   *
   * `finish` rather than a timer: the status is only known when the response is
   * done. The query string is dropped on purpose — a manage token, a claim token
   * and a booking link all travel in one, and a log pipeline is the last place a
   * live credential should be sitting in plain text.
   */
  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    // Route code cannot see the TCP peer after Next wraps the request. Resolve it
    // here and overwrite the internal header unconditionally, so a direct client
    // cannot forge the address used by login/public-write rate limits or audits.
    req.headers['x-voxera-client-ip'] = resolvedClientIp({
      directAddress: req.socket.remoteAddress,
      forwardedFor: Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'].join(',') : req.headers['x-forwarded-for'],
      realIp: Array.isArray(req.headers['x-real-ip']) ? req.headers['x-real-ip'][0] : req.headers['x-real-ip'],
      trustProxy: process.env.VOXERA_TRUST_PROXY === '1',
      trustedHops: Number(process.env.VOXERA_TRUST_PROXY_HOPS ?? 1),
    });
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      observeRequest(res.statusCode, ms);
      const path = (req.url ?? '/').split('?')[0];
      // Assets and the health probe are noise at info level; keep them at debug.
      // `VOXERA_LOG_REQUESTS=0` turns the per-request line off entirely, for a
      // deployment whose proxy already logs traffic and a host that does not want
      // two copies of it.
      if (process.env.VOXERA_LOG_REQUESTS === '0') return;
      const quiet = path.startsWith('/_next/') || path === '/api/health' || path === '/api/metrics' || path === '/favicon.ico';
      logEvent(quiet ? 'debug' : res.statusCode >= 500 ? 'error' : 'info', 'http.request', {
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
      });
    });
    void handle(req, res);
  });

  // Attached before serving traffic so no upgrade can be missed.
  const mediaServer = attachMediaWorker(server);

  // Retention (the store) and the scheduler (the work) are separate clocks.
  // Keep their stop functions: a rolling deploy must stop producing work before
  // the old process releases its scheduler lease and closes the store.
  const stopMaintenance = startMaintenance(6 * 60 * 60 * 1000);
  let stopScheduler: (() => void) | undefined;
  let releaseScheduler: (() => void) | undefined;
  let schedulerRetry: NodeJS.Timeout | undefined;

  /** Exactly one job runner, with standby re-election after a rolling deploy. */
  const tryScheduler = () => {
    if (stopScheduler || process.env.VOXERA_SCHEDULER === '0') return;
    const claim = claimScheduler();
    if (!claim.owns) {
      const holder = claim.holder ? `pid ${claim.holder.pid} on ${claim.holder.host}` : 'another instance';
      logEvent('warn', 'scheduler.not_owner', { holder });
      if (!schedulerRetry) {
        schedulerRetry = setInterval(tryScheduler, 30_000);
        schedulerRetry.unref?.();
      }
      return;
    }
    if (schedulerRetry) {
      clearInterval(schedulerRetry);
      schedulerRetry = undefined;
    }
    releaseScheduler = claim.release;
    stopScheduler = startScheduler(60_000, { onRun: (failed: boolean) => observeSchedulerRun(failed) } as never);
    logEvent('info', 'scheduler.owner', { pid: process.pid });
  };

  if (process.env.VOXERA_SCHEDULER === '0') {
    console.log('  scheduler    : DISABLED — VOXERA_SCHEDULER=0, nothing will send on its own');
  } else {
    tryScheduler();
  }

  server.listen(port, hostname, () => {
    const providers = [process.env.DEEPGRAM_API_KEY ? 'deepgram' : null, process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : process.env.OPENAI_API_KEY ? 'openai-tts' : null].filter(Boolean);
    console.log(
      `Voxera ready on http://${hostname}:${port} (${dev ? 'development' : 'production'})` +
        (mediaSigningAvailable()
          ? `\n  media stream : ws://${hostname}:${port}/api/telephony/twilio/media`
          : `\n  media stream : DISABLED — VOXERA_MEDIA_SECRET is not set, so raw-audio calls are refused and numbers answer with carrier-side speech recognition`) +
        `\n  voice pipeline: ${providers.length ? providers.join(' + ') : 'no provider keys set — audio is not transcribed or spoken'}`
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('info', 'process.shutdown', { signal });
    stopMaintenance();
    stopScheduler?.();
    releaseScheduler?.();
    if (schedulerRetry) clearInterval(schedulerRetry);
    // Stop accepting new media and ask active sockets to leave cleanly. The hard
    // deadline below handles a provider that never completes its close handshake.
    for (const client of mediaServer.clients) client.close(1001, 'server restart');
    mediaServer.close();
    server.close(() => {
      try {
        closeStore();
        process.exit(0);
      } catch (error) {
        console.error('store close failed', error);
        process.exit(1);
      }
    });
    setTimeout(() => {
      server.closeAllConnections?.();
      try {
        closeStore();
      } finally {
        process.exit(1);
      }
    }, 20_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('failed to start', err);
  process.exit(1);
});
