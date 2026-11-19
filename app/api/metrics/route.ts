import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { renderPrometheus } from '@/lib/server/log';
import { dbStats } from '@/lib/server/db';
import { dataPath } from '@/lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Prometheus metrics.
 *
 * Text exposition format, no auth — which is the usual trade for a scrape endpoint:
 * a scraper that has to hold a secret needs a secret rotated in two places. The
 * numbers here are process and aggregate counts only. There is no workspace id, no
 * client detail, and nothing a request path could have carried.
 *
 * If the deployment exposes this route to the internet, put it behind the proxy's
 * private-network rule — the same rule that should already hide `/api/health`'s
 * detail from the public.
 */

/**
 * The backup sidecar's last known outcome, if it shares a volume with the app.
 *
 * `backup-store.ts` writes `status.json` beside its copies; the Compose sidecar
 * mounts the same `voxera-data` volume, so the app can read what it wrote. The
 * point of reading it here is that a backup which quietly stopped running is
 * invisible until the restore — a timestamp a scraper can alert on is the
 * difference between "backups exist" and "backups are happening".
 */
function backupStatus(): Record<string, unknown> | null {
  const statusPath = process.env.VOXERA_BACKUP_STATUS ?? dataPath('backups', 'status.json');
  try {
    // The path is intentionally deployment-configurable and is not a build dependency.
    return JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ statusPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET() {
  const counts = dbStats();
  const documents = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const extra: Record<string, number> = {
    voxera_store_documents: documents,
    voxera_store_collections: Object.keys(counts).length,
  };

  const status = backupStatus();
  if (status) {
    const attemptedAt = typeof status.at === 'string' ? Date.parse(status.at) : NaN;
    if (!Number.isNaN(attemptedAt)) extra.voxera_backup_last_attempt_timestamp_seconds = Math.round(attemptedAt / 1000);
    const successValue = typeof status.lastSuccessAt === 'string' ? status.lastSuccessAt : status.ok === true ? status.at : undefined;
    const lastSuccess = typeof successValue === 'string' ? Date.parse(successValue) : NaN;
    if (!Number.isNaN(lastSuccess)) {
      extra.voxera_backup_last_success_timestamp_seconds = Math.round(lastSuccess / 1000);
      extra.voxera_backup_last_success_age_seconds = Math.max(0, Math.round((Date.now() - lastSuccess) / 1000));
    }
    if (typeof status.bytes === 'number') extra.voxera_backup_last_bytes = status.bytes;
    if (typeof status.copies === 'number') extra.voxera_backup_copies = status.copies;
    if (typeof status.ok === 'boolean') extra.voxera_backup_ok = status.ok ? 1 : 0;
  }

  const body = renderPrometheus(extra);
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
  });
}
