import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, rateHeaders, rateLimit, readJson, requestId } from '@/lib/server/api';
import { decideEstimate, publicEstimate } from '@/lib/server/field-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failed(result: { ok: false; code: 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'FORBIDDEN'; error: string; detail?: string }, rid: string) {
  return fail(result.code, result.error, { detail: result.detail, requestId: rid });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rid = requestId();
  const { token } = await params;
  const result = publicEstimate(token);
  if (!result.ok) return failed(result, rid);
  return ok(result.value, { requestId: rid, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rid = requestId();
  const limit = rateLimit(`estimate-decision:${clientIp(req)}`, 20, 15 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many estimate attempts from this address. Try again later.', {
      requestId: rid,
      headers: { 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)), ...rateHeaders(limit) },
    });
  }
  const { token } = await params;
  const body = await readJson<{ decision?: 'accepted' | 'declined'; name?: string; email?: string }>(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  if (!body.decision || !['accepted', 'declined'].includes(body.decision)) {
    return fail('VALIDATION_ERROR', '`decision` must be accepted or declined.', { param: 'decision', requestId: rid });
  }
  const result = decideEstimate({
    token,
    decision: body.decision,
    name: String(body.name ?? ''),
    email: body.email,
    ip: clientIp(req),
    userAgent: req.headers.get('user-agent') ?? undefined,
  });
  if (!result.ok) return failed(result, rid);
  return ok(result.value, { requestId: rid, headers: { 'cache-control': 'no-store' } });
}
