import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { dbStats, storeDriver } from '@/lib/server/db';
import { dataDir } from '@/lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness in one answer.
 *
 * A load balancer needs to know two different things and this endpoint is careful
 * not to conflate them: the process is up (liveness — if this route answers at
 * all, it is), and the store it depends on can be read (readiness). A process
 * that is too busy or was started against an unwritable volume should be taken
 * out of rotation, not restarted forever.
 *
 * The body is deliberately thin: a version, how long it has been up, and whether
 * the store answered. Counts are useful when a person reads it and mildly
 * interesting to a stranger, so only totals are exposed — never a workspace id,
 * a document id, or anything a client said.
 */
/** The build the process is actually serving, read once. */
let cachedBuild: string | null | undefined;
function buildId() {
  if (cachedBuild !== undefined) return cachedBuild;
  try {
    cachedBuild = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    cachedBuild = null;
  }
  return cachedBuild;
}

export async function GET() {
  const started = Date.now();
  let store: { readable: boolean; writable?: boolean; driver?: string; bytes?: number; collections?: number; docs?: number; error?: string } = { readable: false };
  try {
    const counts = dbStats();
    const driver = storeDriver();
    // Report local file weight when a file engine is in use. PostgreSQL reports
    // no byte count here: its storage belongs to the database service, whose own
    // metrics are authoritative.
    const candidates = ['voxera-db.sqlite', 'voxera-db.sqlite-wal', 'voxera-db.json'];
    let size = 0;
    const root = dataDir();
    for (const name of candidates) {
      const file = path.join(/* turbopackIgnore: true */ root, name);
      if (fs.existsSync(/* turbopackIgnore: true */ file)) size += fs.statSync(/* turbopackIgnore: true */ file).size;
    }
    fs.accessSync(/* turbopackIgnore: true */ root, fs.constants.R_OK | fs.constants.W_OK);
    store = {
      readable: true,
      writable: true,
      driver,
      ...(driver === 'postgres' ? {} : { bytes: size }),
      collections: Object.keys(counts).length,
      docs: Object.values(counts).reduce((sum, n) => sum + n, 0),
    };
  } catch (error) {
    store = { readable: false, writable: false, error: error instanceof Error ? error.message : 'unavailable' };
  }

  const status = store.readable && store.writable ? 200 : 503;
  return NextResponse.json(
    {
      status: store.readable && store.writable ? 'ok' : 'degraded',
      build: buildId(),
      uptimeSeconds: Math.round(process.uptime()),
      store,
      checks: { storeMs: Date.now() - started },
    },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}
