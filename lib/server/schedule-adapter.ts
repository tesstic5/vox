import type { AvailabilityQuery, AvailabilityResult } from './availability';
import type { BookingDoc, BookingInput } from './bookings';
import { stableHash, type ScheduleOrigin } from './schedule-core';

export type ScheduleContext = {
  origin: ScheduleOrigin;
  actor?: string;
  callId?: string;
  offerId?: string;
  requestId?: string;
  idempotencyKey: string;
};

/** Bind an offer to the exact resource tuple and duration approved by availability. */
export function scheduleSlotFingerprint(input: {
  serviceId?: string;
  locationId?: string;
  providerId?: string;
  startsAt: string;
  durationMinutes: number;
}) {
  const start = new Date(input.startsAt).toISOString();
  const end = new Date(Date.parse(start) + input.durationMinutes * 60_000).toISOString();
  return stableHash(['schedule-slot-v1', input.serviceId ?? '', input.locationId ?? '', input.providerId ?? '', start, end]);
}

export type ScheduleFreeVerdict = {
  free: boolean;
  reason?: string;
  conflicts: Array<{ id: string; startsAt: string; service?: string }>;
  slotFingerprint?: string;
};
export type ScheduleCreateInput = BookingInput & { orgId: string; source?: BookingDoc['source'] };
export type ScheduleMoveInput = {
  orgId: string; bookingId: string; startsAt: string; durationMinutes?: number;
  providerId?: string; locationId?: string; roomId?: string; note?: string; fundingOverrideReason?: string;
};
export type ScheduleCancelInput = { orgId: string; bookingId: string; reason?: string; fundingOverrideReason?: string };
export type ScheduleMutationResult = { booking: BookingDoc; confirmed: true; slotFingerprint?: string };

/** Internal deterministic-test seam around Voxera's native scheduling implementation. */
export interface ScheduleAdapter {
  findSlots(query: AvailabilityQuery, context: ScheduleContext): Promise<AvailabilityResult>;
  isFree(input: {
    orgId: string; providerId: string; startsAt: string; durationMinutes: number;
    serviceId?: string; locationId?: string; ignoreBookingId?: string;
  }, context: ScheduleContext): Promise<ScheduleFreeVerdict>;
  createAppointment(input: ScheduleCreateInput, context: ScheduleContext): Promise<ScheduleMutationResult>;
  moveAppointment(input: ScheduleMoveInput, context: ScheduleContext): Promise<ScheduleMutationResult>;
  cancelAppointment(input: ScheduleCancelInput, context: ScheduleContext): Promise<ScheduleMutationResult>;
}
