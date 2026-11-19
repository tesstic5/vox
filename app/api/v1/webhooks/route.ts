import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { get, insert, list, newId, nowIso, remove, update } from '@/lib/server/db';
import { deliveriesFor, publicWebhook, sealWebhookSecret, type WebhookSubscription } from '@/lib/server/webhooks';
import { audit } from '@/lib/server/audit';
import { redeliver } from '@/lib/server/webhooks';
import { guardUrl } from '@/lib/server/net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const subs = list<WebhookSubscription>('webhooks', (w) => w.orgId === ctx.orgId).map(publicWebhook);
  return ok({ subscriptions: subs, deliveries: deliveriesFor(ctx.orgId, 20) }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ url?: string; events?: string[]; secret?: string; redeliverId?: string }>(req);
  if (body instanceof NextResponse) return body;
  const unknown = Object.keys(body).find((key) => !['url', 'events', 'secret', 'redeliverId'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not accepted.`, { param: unknown, requestId: ctx.requestId });

  if (body.redeliverId) {
    if (Object.keys(body).some((key) => key !== 'redeliverId')) {
      return fail('VALIDATION_ERROR', '`redeliverId` cannot be combined with subscription fields.', { param: 'redeliverId', requestId: ctx.requestId });
    }
    const result = await redeliver(ctx.orgId, body.redeliverId);
    if (!result) return fail('NOT_FOUND', `No delivery with id ${body.redeliverId}.`, { requestId: ctx.requestId });
    return ok({ redelivered: true, delivery: result[0] }, { requestId: ctx.requestId });
  }

  const url = String(body.url ?? '').trim();
  if (!/^https?:\/\//.test(url) || url.length > 2_000) {
    return fail('VALIDATION_ERROR', 'Webhook URLs must be valid http(s) URLs of at most 2,000 characters.', { param: 'url', requestId: ctx.requestId });
  }
  if (process.env.NODE_ENV === 'production' && !url.startsWith('https://')) {
    return fail('VALIDATION_ERROR', 'Production webhook URLs must use HTTPS.', { param: 'url', requestId: ctx.requestId });
  }
  // A subscription is an instruction to make the server fetch that URL on every
  // event, so the address is checked here as well as at delivery time: a private
  // or unresolvable target is refused up front instead of failing every time.
  const verdict = await guardUrl(url);
  if (verdict.policy === 'blocked') {
    return fail('VALIDATION_ERROR', `That URL cannot be called: ${verdict.reason}. Use a publicly reachable https endpoint.`, {
      param: 'url',
      detail: verdict.reason,
      requestId: ctx.requestId,
    });
  }
  const events = body.events?.length ? body.events : ['call.ended'];
  if (!Array.isArray(events) || events.length > 30 || events.some((event) => typeof event !== 'string' || !/^(\*|[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)$/.test(event))) {
    return fail('VALIDATION_ERROR', '`events` must contain at most 30 event names such as call.ended, or *.', { param: 'events', requestId: ctx.requestId });
  }
  const signingSecret = String(body.secret ?? newId('whsec_'));
  if (signingSecret.length < 16 || signingSecret.length > 512) {
    return fail('VALIDATION_ERROR', '`secret` must be between 16 and 512 characters.', { param: 'secret', requestId: ctx.requestId });
  }
  const sub = insert<WebhookSubscription>('webhooks', {
    id: newId('wh_'),
    orgId: ctx.orgId,
    url,
    events: [...new Set(events)],
    secretSealed: sealWebhookSecret(signingSecret),
    active: true,
    createdAt: nowIso(),
  } as WebhookSubscription);

  audit({ orgId: ctx.orgId, actor: 'dashboard', action: 'webhook.created', target: sub.id, detail: url });
  return ok(
    {
      ...publicWebhook(sub),
      ...(body.secret === undefined ? { signingSecret, warning: 'Store this signing secret now; it cannot be retrieved again.' } : {}),
    },
    { requestId: ctx.requestId, status: 201 }
  );
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ id?: string; active?: boolean }>(req);
  if (body instanceof NextResponse) return body;
  const unknown = Object.keys(body).find((key) => !['id', 'active'].includes(key));
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not accepted.`, { param: unknown, requestId: ctx.requestId });
  const id = String(body.id ?? '');
  if (!id || typeof body.active !== 'boolean') {
    return fail('VALIDATION_ERROR', '`id` and boolean `active` are required.', { requestId: ctx.requestId });
  }
  const existing = get<WebhookSubscription>('webhooks', id);
  if (!existing || existing.orgId !== ctx.orgId) return fail('NOT_FOUND', `No webhook with id ${id}.`, { requestId: ctx.requestId });
  const saved = update<WebhookSubscription>('webhooks', id, { active: body.active } as Partial<WebhookSubscription>);
  audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? ctx.key?.name ?? ctx.userId, action: body.active ? 'webhook.resumed' : 'webhook.paused', target: id, detail: existing.url });
  return ok({ subscription: publicWebhook(saved!) }, { requestId: ctx.requestId });
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireConfigRole(ctx);
  if (denied) return denied;
  const body = await readJson<{ id?: string }>(req);
  if (body instanceof NextResponse) return body;
  const unknown = Object.keys(body).find((key) => key !== 'id');
  if (unknown) return fail('VALIDATION_ERROR', `\`${unknown}\` is not accepted.`, { param: unknown, requestId: ctx.requestId });
  const id = String(body.id ?? '');
  const existing = id ? get<WebhookSubscription>('webhooks', id) : undefined;
  if (!existing || existing.orgId !== ctx.orgId) return fail('NOT_FOUND', `No webhook with id ${id || '(missing)'}.`, { requestId: ctx.requestId });
  remove('webhooks', id);
  // Delivery rows are operational history and remain visible after an endpoint is
  // removed; deleting configuration must not rewrite what was actually sent.
  audit({ orgId: ctx.orgId, actor: ctx.user?.email ?? ctx.key?.name ?? ctx.userId, action: 'webhook.deleted', target: id, detail: existing.url });
  return ok({ deleted: true, id }, { requestId: ctx.requestId });
}
