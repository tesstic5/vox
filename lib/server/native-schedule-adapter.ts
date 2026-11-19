import { findSlots, isFree, type AvailabilityQuery } from './availability';
import { applyOutcome, bookingByExternalId, upsertBooking } from './bookings';
import { serviceById } from './practice';
import { moveAppointment as moveDiaryAppointment, setAppointmentStatus } from './diary';
import type { ScheduleAdapter, ScheduleCancelInput, ScheduleContext, ScheduleCreateInput, ScheduleMoveInput } from './schedule-adapter';
import { scheduleSlotFingerprint } from './schedule-adapter';
import { ScheduleError } from './schedule-core';

export class NativeScheduleAdapter implements ScheduleAdapter {
  async findSlots(query: AvailabilityQuery, _context: ScheduleContext) { return findSlots(query); }

  async isFree(input: {
    orgId: string; providerId: string; startsAt: string; durationMinutes: number;
    serviceId?: string; locationId?: string; ignoreBookingId?: string;
  }, _context: ScheduleContext) {
    const verdict = isFree({ ...input, service: input.serviceId ? serviceById(input.orgId, input.serviceId) : undefined });
    return { ...verdict, slotFingerprint: scheduleSlotFingerprint(input) };
  }

  async createAppointment(input: ScheduleCreateInput, _context: ScheduleContext) {
    const occupiesDiary = !['completed', 'cancelled', 'no_show'].includes(String(input.status ?? 'confirmed'));
    if (input.providerId && occupiesDiary) {
      const existing = bookingByExternalId(input.orgId, input.externalId);
      const verdict = isFree({
        orgId: input.orgId, providerId: input.providerId, startsAt: input.startsAt,
        durationMinutes: input.durationMinutes ?? 30,
        service: input.serviceId ? serviceById(input.orgId, input.serviceId) : undefined,
        locationId: input.locationId, ignoreBookingId: existing?.id,
      });
      if (!verdict.free) throw new ScheduleError(verdict.reason ?? 'That appointment time is no longer available.', 'SLOT_TAKEN');
    }
    const { booking } = upsertBooking(input);
    return {
      booking, confirmed: true as const,
      slotFingerprint: scheduleSlotFingerprint({
        serviceId: booking.serviceId, locationId: booking.locationId, providerId: booking.providerId,
        startsAt: booking.startsAt, durationMinutes: booking.durationMinutes,
      }),
    };
  }

  async moveAppointment(input: ScheduleMoveInput, context: ScheduleContext) {
    const result = moveDiaryAppointment({
      orgId: input.orgId, id: input.bookingId, startsAt: input.startsAt,
      durationMinutes: input.durationMinutes, providerId: input.providerId,
      locationId: input.locationId, roomId: input.roomId,
      actor: context.actor ?? 'schedule-gateway',
      fundingOverride: input.fundingOverrideReason ? { by: context.actor ?? 'schedule-gateway', reason: input.fundingOverrideReason } : undefined,
    });
    if (!result.ok) throw new ScheduleError(result.message, result.error === 'conflict' ? 'CONFLICT' : 'SCHEDULE_UNAVAILABLE');
    const booking = applyOutcome({
      orgId: input.orgId, bookingId: input.bookingId, outcome: 'rescheduled',
      callId: context.callId, note: input.note, actor: context.actor ?? 'schedule-gateway',
    }) ?? result.booking;
    return { booking, confirmed: true as const };
  }

  async cancelAppointment(input: ScheduleCancelInput, context: ScheduleContext) {
    const result = setAppointmentStatus({
      orgId: input.orgId, id: input.bookingId, status: 'cancelled', note: input.reason,
      actor: context.actor ?? 'schedule-gateway',
      fundingOverride: input.fundingOverrideReason ? { by: context.actor ?? 'schedule-gateway', reason: input.fundingOverrideReason } : undefined,
    });
    if (!result.ok) throw new ScheduleError(result.message, 'SCHEDULE_UNAVAILABLE');
    const booking = applyOutcome({
      orgId: input.orgId, bookingId: input.bookingId, outcome: 'cancelled',
      callId: context.callId, note: input.reason, actor: context.actor ?? 'schedule-gateway',
    }) ?? result.booking;
    return { booking, confirmed: true as const };
  }
}
