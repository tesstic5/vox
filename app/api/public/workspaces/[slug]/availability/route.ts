import { fail, ok, requestId } from '@/lib/server/api';
import { publicWorkspace } from '@/lib/server/booking-page';
import { scheduleGatewayFor } from '@/lib/server/schedule-gateway';
import { ScheduleError } from '@/lib/server/schedule-core';
import { practiceProfile } from '@/lib/server/practice';
import { rateLimit, rateHeaders } from '@/lib/server/ratelimit';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Free times for the public page.
 *
 * The engine does the work — the same one the phone agent and the calendar use —
 * and this route only decides what a stranger may see: free slots, the site's
 * clock, and the booking policy. Never the appointments around them.
 *
 * Rate limited per connection: the page refetches as the visitor changes service
 * or day, and that is fine for a person and abusive from a script.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const id = requestId();
  const workspace = publicWorkspace(slug);
  if (!workspace) return fail('NOT_FOUND', 'That booking page does not exist.', { requestId: id });
  const { org, settings } = workspace;
  if (!settings.enabled) return fail('NOT_FOUND', 'Online booking is switched off for this workspace.', { requestId: id });

  // 60 checks per five minutes per connection: a person changing service and day
  // will not come close, and a script walking the diary will.
  const limit = rateLimit(`pub-avail:${clientKey(req)}`, 60, 5 * 60_000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many availability checks. Give it a minute.', { requestId: id, headers: rateHeaders(limit) });
  }

  const url = new URL(req.url);
  const serviceId = url.searchParams.get('serviceId') ?? undefined;
  const providerId = url.searchParams.get('providerId') ?? undefined;
  const locationId = url.searchParams.get('locationId') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 14) || 14, 1), 31);
  const daysLimit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 60) || 60, 1), 120);
  if (!serviceId) return fail('VALIDATION_ERROR', 'Choose a service first.', { param: 'serviceId', requestId: id });

  const profile = practiceProfile(org.id);
  let result;
  try {
    result = await scheduleGatewayFor(org.id).findSlots({
      serviceId,
      providerId,
      locationId,
      from,
      days,
      limit: daysLimit,
    }, { origin: 'public', requestId: id });
  } catch (error) {
    const unavailable = error instanceof ScheduleError;
    return fail(unavailable ? 'SCHEDULE_UNAVAILABLE' : 'VALIDATION_ERROR', unavailable
      ? 'Appointment availability is temporarily unavailable. Please call the practice; no slot has been held.'
      : error instanceof Error ? error.message : 'Could not check availability.', { requestId: id });
  }

  // Grouped by local day: the page shows a day at a time, and grouping in SQL
  // (here, in the scan) beats grouping in a browser on a phone.
  const byDay = new Map<
    string,
    { date: string; slots: { startsAt: string; label: string; providerId: string; providerName: string; providerTitle?: string; locationId: string; locationName: string }[] }
  >();
  for (const slot of result.slots) {
    const day = byDay.get(slot.local.date) ?? { date: slot.local.date, slots: [] };
    day.slots.push({
      startsAt: slot.startsAt,
      label: slot.local.start,
      providerId: slot.providerId,
      providerName: slot.providerName,
      // Where the time is. A slot is not just an hour: echoing it back to the
      // booking endpoint without the site books the *right* time at the *wrong*
      // place, and the diary answers that with a refusal that reads like a clash.
      // The site list is already public on this page.
      locationId: slot.locationId,
      locationName: slot.locationName,
    });
    byDay.set(slot.local.date, day);
  }

  return ok(
    {
      timezone: result.timezone,
      service: result.service,
      days: [...byDay.values()],
      total: result.slots.length,
      reason: result.reason,
      policy: {
        minNoticeMinutes: profile.minNoticeMinutes,
        maxAdvanceDays: profile.maxAdvanceDays,
        slotStepMinutes: profile.slotStepMinutes,
      },
      scanned: result.scanned,
    },
    { requestId: id, headers: rateHeaders(limit) }
  );
}

/**
 * The client address, first hop of `x-forwarded-for`.
 *
 * That header is trusted because this app is deployed behind a proxy that sets
 * it; a deployment exposed directly to the internet should read the socket
 * address instead. The limiter is a speed bump either way.
 */
function clientKey(req: NextRequest) {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}
