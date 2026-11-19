import { NextResponse, type NextRequest } from 'next/server';
import { ok, readJson, requireAuth, requireWriteRole } from '@/lib/server/api';
import { bookingSettings, setBookingSettings, publicSites, type OrgRow } from '@/lib/server/booking-page';
import { messagesFor } from '@/lib/server/messages';
import { list } from '@/lib/server/db';
import { actorLabel } from '@/lib/server/access-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The workspace's own view of its booking page: the link, the switches, and what
 * the message queue has been doing.
 *
 * The public page has its own unauthenticated route under `/api/public`; this one
 * is for the practice and carries the counts a receptionist cares about.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const org = list<OrgRow>('orgs', (o) => o.id === ctx.orgId)[0];
  const settings = bookingSettings(org ?? ({ id: ctx.orgId } as OrgRow));
  const messages = messagesFor(ctx.orgId);
  const tally = messages.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.status]: (acc[m.status] ?? 0) + 1 }), {});
  const samples = messages
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8)
    .map((m) => ({ channel: m.channel, status: m.status, to: m.to, body: m.body, at: m.sentAt ?? m.sendAt, reason: m.reason }));

  return ok(
    {
      slug: org?.slug,
      link: `/book/${org?.slug ?? ''}`,
      booking: settings,
      sites: publicSites(ctx.orgId),
      messages: {
        pending: tally.pending ?? 0,
        sent: tally.sent ?? 0,
        blocked: tally.blocked ?? 0,
        failed: tally.failed ?? 0,
        cancelled: tally.cancelled ?? 0,
      },
      samples,
    },
    { requestId: ctx.requestId }
  );
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = requireWriteRole(ctx);
  if (denied) return denied;
  const body = await readJson<{
    enabled?: boolean;
    showProviders?: boolean;
    maxPerNumber?: number;
    windowDays?: number;
  }>(req);
  if (body instanceof NextResponse) return body;
  const { actor } = actorLabel(ctx.auth, { email: ctx.user?.email, keyId: ctx.key?.id });

  const patch: Record<string, unknown> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.showProviders === 'boolean') patch.showProviders = body.showProviders;
  for (const key of ['maxPerNumber', 'windowDays'] as const) {
    if (body[key] !== undefined) {
      const value = Number(body[key]);
      // A cap of zero would quietly close the page; a window of a year would
      // make the cap meaningless. Both are clamped rather than rejected, because
      // the field is a number input and people type what they type.
      patch[key] = key === 'maxPerNumber' ? Math.min(Math.max(value || 1, 1), 50) : Math.min(Math.max(value || 1, 1), 365);
    }
  }
  const next = setBookingSettings(ctx.orgId, patch, actor);
  return ok({ booking: next }, { requestId: ctx.requestId });
}
