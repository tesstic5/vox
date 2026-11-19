import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { actorLabel } from '@/lib/server/access-log';
import { dayViewFor, linkProviderToUser } from '@/lib/server/day';
import { providerById } from '@/lib/server/practice';
import { locationById } from '@/lib/server/practice';
import { permissionDecision } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * My day — one practitioner's diary, in the order they live it.
 *
 * `GET` answers for the practitioner behind the calling login: what is next and
 * how long until it, who has arrived, what has been done, what is left, what is
 * free and whether that free time is actually bookable. An owner or admin may
 * add `providerId=` to read somebody else's day; anybody may read their own. A
 * login with no practitioner record attached gets an honest empty answer plus
 * the shortlist it may link itself to — not a 404, and never somebody else's
 * diary standing in for their own.
 *
 * `POST` is the link itself: `provider:link` / `provider:unlink`. Attaching your
 * own record to your own login is allowed; attaching somebody else's is an
 * owner/admin action. It is deliberately *not* behind the practice-config role
 * gate — a practitioner who is not a config admin still needs to become
 * findable by their own diary.
 */

const SUPPORTED = new Set(['date', 'days', 'locationId', 'providerId', 'format', 't']);

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);

  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED.has(key)) {
      return fail(
        'VALIDATION_ERROR',
        `Unknown query parameter \`${key}\`. This route accepts: ${[...SUPPORTED].join(', ')}.`,
        { param: key, detail: [...SUPPORTED].join(', '), requestId: ctx.requestId }
      );
    }
  }

  const providerId = url.searchParams.get('providerId') ?? undefined;
  const locationId = url.searchParams.get('locationId') ?? undefined;
  if (locationId && !locationById(ctx.orgId, locationId)) {
    return fail('NOT_FOUND', `No location with id ${locationId}.`, { requestId: ctx.requestId });
  }
  if (providerId && !providerById(ctx.orgId, providerId)) {
    return fail('NOT_FOUND', `No practitioner with id ${providerId}.`, { requestId: ctx.requestId });
  }

  const days = url.searchParams.get('days');
  if (days && !/^[1-7]$/.test(days)) {
    return fail('VALIDATION_ERROR', '`days` must be a whole number from 1 to 7.', { param: 'days', requestId: ctx.requestId });
  }
  const date = url.searchParams.get('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return fail('VALIDATION_ERROR', '`date` must be a local calendar date, `YYYY-MM-DD`.', { param: 'date', requestId: ctx.requestId });
  }

  // A key is a machine, and a machine has no day. Rather than answering with a
  // blank diary, say what is missing.
  if (ctx.auth !== 'session' && !providerId) {
    return fail(
      'VALIDATION_ERROR',
      'An API key has no practitioner identity. Pass `providerId=` to read that practitioner\'s day, or sign in as a practitioner to read your own.',
      { param: 'providerId', detail: 'providerId', requestId: ctx.requestId }
    );
  }

  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });
  const view = dayViewFor(ctx.orgId, {
    userId: ctx.userId,
    email: ctx.user?.email,
    role: ctx.user?.role,
    auth: ctx.auth,
    providerId,
    locationId,
    date: date ?? undefined,
    days: days ? Number(days) : 1,
    actor,
    actorName,
    includeClinicalAlerts:
      ctx.auth === 'key'
        ? Boolean(ctx.key?.scopes.includes('*') || ctx.key?.scopes.includes('clinical:read'))
        : Boolean(ctx.user && permissionDecision(ctx.user, 'clinical.alerts.read', { area: 'clinical' }).allowed),
  });

  // The one thing the payload cannot decide for itself: whether *this* caller was
  // allowed to ask for *that* practitioner. Say it, in words, with a code.
  if (view.requested && view.requested.allowed === false) {
    return fail(
      'FORBIDDEN',
      'That is another practitioner\'s day. Owners and admins can look at anybody\'s; a practitioner sees their own.',
      { param: 'providerId', requestId: ctx.requestId }
    );
  }

  return ok({ ...view, actor: { label: actor, name: actorName } }, { requestId: ctx.requestId });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;

  if (ctx.auth !== 'session' || !ctx.user) {
    return fail('FORBIDDEN', 'Linking a practitioner record to a login is a signed-in action. Sign in and try again.', {
      requestId: ctx.requestId,
    });
  }

  const body = await readJson<{ action?: string; providerId?: string | null; userId?: string }>(req);
  if (body instanceof NextResponse) return body;
  const { actor, actorName } = actorLabel(ctx.auth, { email: ctx.user.email, keyId: ctx.key?.id });
  const userId = body.userId || ctx.user.id;

  switch (body.action) {
    case 'provider:link':
    case 'provider:unlink': {
      const result = linkProviderToUser(ctx.orgId, {
        providerId: body.action === 'provider:unlink' ? null : String(body.providerId ?? '') || null,
        userId,
        actor,
        actorName,
        actorId: ctx.user.id,
        actorRole: ctx.user.role,
      });
      if (!result.ok) {
        const code = result.error === 'not_found' ? 'NOT_FOUND' : result.error === 'conflict' ? 'CONFLICT' : 'FORBIDDEN';
        return fail(code, result.message, { requestId: ctx.requestId });
      }
      // Answer with the day that now exists, so the page needs no second call.
      const view = dayViewFor(ctx.orgId, {
        userId,
        email: ctx.user.email,
        role: ctx.user.role,
        auth: ctx.auth,
        actor,
        actorName,
      });
      return ok({ linked: result.provider, user: result.user, day: view }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', '`action` must be one of: provider:link, provider:unlink.', {
        param: 'action',
        requestId: ctx.requestId,
      });
  }
}
