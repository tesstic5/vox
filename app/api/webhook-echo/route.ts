/**
 * A real endpoint to receive webhooks.
 *
 * Point a subscription at /api/webhook-echo (or use it from the dashboard's
 * webhook tester) and deliveries are stored and rendered back, signature
 * included — so "does webhook delivery actually work" is answerable by looking.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { nowIso } from '@/lib/server/db';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '@/lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOG = dataPath('webhook-echo.json');
const enabled = () => process.env.NODE_ENV !== 'production' || process.env.VOXERA_ENABLE_TEST_ENDPOINTS === '1';
const unavailable = () => NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, { status: 404 });

export async function POST(req: NextRequest) {
  // This endpoint stores arbitrary request bodies and exists only for the local
  // delivery gate. A public production deployment must not expose a writable
  // echo/log service merely because it shares the application image.
  if (!enabled()) return unavailable();
  const raw = await req.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep the raw body */
  }

  const entry = {
    at: nowIso(),
    event: req.headers.get('x-voxera-event') ?? 'unknown',
    deliveryId: req.headers.get('x-voxera-delivery') ?? null,
    signature: req.headers.get('x-voxera-signature') ?? null,
    contentType: req.headers.get('content-type') ?? null,
    bytes: raw.length,
    body: parsed,
  };

  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const existing = fs.existsSync(LOG) ? (JSON.parse(fs.readFileSync(LOG, 'utf8')) as unknown[]) : [];
    existing.unshift(entry);
    fs.writeFileSync(LOG, JSON.stringify(existing.slice(0, 100), null, 2));
  } catch (err) {
    console.error('[webhook-echo] could not persist', err);
  }

  return NextResponse.json({ received: true, event: entry.event, at: entry.at });
}

export async function GET() {
  if (!enabled()) return unavailable();
  try {
    const existing = fs.existsSync(LOG) ? (JSON.parse(fs.readFileSync(LOG, 'utf8')) as unknown[]) : [];
    return NextResponse.json({ deliveries: existing.slice(0, 25) });
  } catch {
    return NextResponse.json({ deliveries: [] });
  }
}
