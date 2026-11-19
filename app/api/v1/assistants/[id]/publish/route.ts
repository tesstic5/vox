import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole, requireVerifiedEmail } from '@/lib/server/api';
import { get, update, nowIso, type Doc } from '@/lib/server/db';
import { snapshotAssistant } from '@/lib/server/versions';
import { audit } from '@/lib/server/audit';
import { deliverWebhook } from '@/lib/server/webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /v1/assistants/{id}/publish — freeze the current config as a version. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth(req, { scopes: ['assistants:write'] });
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  // Publishing puts an agent in front of real callers, so it needs a verified
  // account behind it — see `requireVerifiedEmail`.
  const unverified = requireVerifiedEmail(ctx);
  if (unverified) return unverified;
  const assistant = get<Doc & Record<string, unknown>>('assistants', id);
  if (!assistant || assistant.orgId !== ctx.orgId) {
    return fail('NOT_FOUND', `No assistant with id ${id}.`, { requestId: ctx.requestId });
  }
  const body = await readJson<{ message?: string }>(req);
  if (body instanceof NextResponse) return body;

  const published = update<Doc & Record<string, unknown>>('assistants', id, {
    status: 'published',
    publishedAt: nowIso(),
    updatedAt: nowIso(),
  });
  if (!published) return fail('INTERNAL_ERROR', 'Publish failed.', { requestId: ctx.requestId });

  const snapshot = snapshotAssistant(published, body.message ?? 'Publish', 'dashboard');
  void deliverWebhook({
    orgId: ctx.orgId,
    event: 'assistant.updated',
    payload: { type: 'assistant.updated', assistant: { id, status: 'published', version: snapshot.version } },
  });
  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'assistant.published', target: id, detail: body.message ?? '' });

  return ok({ id, status: 'published', version: snapshot.version, publishedAt: published.publishedAt }, { requestId: ctx.requestId });
}
