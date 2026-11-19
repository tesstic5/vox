import { NextResponse } from 'next/server';
import { fail, requireDeskRole, type ApiContext } from './api';
import type { BookingDoc } from './bookings';
import { providerById } from './practice';

/**
 * Desk roles and scoped API keys may run the diary. A practitioner may perform a
 * lifecycle action only on an appointment assigned to the provider record linked
 * to their own login. This keeps “My day” actionable without granting access to
 * a colleague's diary.
 */
export function requireBookingActionRole(ctx: ApiContext, booking: BookingDoc): NextResponse | null {
  if (ctx.auth !== 'session' || ctx.user?.role !== 'practitioner') {
    return requireDeskRole(ctx);
  }

  const provider = booking.providerId ? providerById(ctx.orgId, booking.providerId) : undefined;
  if (provider?.userId === ctx.userId) return null;

  return fail('FORBIDDEN', "Practitioners can change only appointments in their own linked diary.", {
    requestId: ctx.requestId,
  });
}
