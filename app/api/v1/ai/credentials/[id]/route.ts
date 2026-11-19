import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { aiCredentialsFor, deleteAiCredential, publicAiCredential, testAiCredential, verifyCredential } from '@/lib/server/ai/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — one credential's state. POST — re-verify it against the provider. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing provider credentials requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const doc = aiCredentialsFor(ctx.orgId).find((c) => c.id === id);
  if (!doc) return fail('NOT_FOUND', `No AI credential with id ${id}.`, { requestId: ctx.requestId });
  return ok(publicAiCredential(doc), { requestId: ctx.requestId });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing provider credentials requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const doc = aiCredentialsFor(ctx.orgId).find((c) => c.id === id);
  if (!doc) return fail('NOT_FOUND', `No AI credential with id ${id}.`, { requestId: ctx.requestId });

  const body = await readJson<{ action?: 'verify' | 'test'; prompt?: string }>(req);
  if (body instanceof NextResponse) return body;

  // `test` is the stronger check: one real completion, on the customer's key, so
  // "it answered" rather than "the URL exists" is what the dashboard reports.
  if (body.action === 'test') {
    const result = await testAiCredential(ctx.orgId, doc.id, body.prompt);
    if (!result.ok) {
      return fail('VALIDATION_ERROR', result.error, { param: 'baseUrl', detail: 'endpoint_test_failed', requestId: ctx.requestId });
    }
    return ok(result, { requestId: ctx.requestId });
  }

  const result = await verifyCredential(ctx.orgId, doc.id);
  if (!result.ok) return fail('VALIDATION_ERROR', result.error, { requestId: ctx.requestId });
  return ok({ verified: result.verified, models: result.models, note: result.note }, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.auth !== 'session') return fail('FORBIDDEN', 'Managing provider credentials requires a signed-in person.', { requestId: ctx.requestId });
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const doc = deleteAiCredential(ctx.orgId, id);
  if (!doc) return fail('NOT_FOUND', `No AI credential with id ${id}.`, { requestId: ctx.requestId });
  return ok({ id: doc.id, provider: doc.provider, deleted: true, note: 'Assistants on this provider fall back to the rule engine.' }, { requestId: ctx.requestId });
}
