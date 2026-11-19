/**
 * The single native schedule command boundary.
 * Phone, public booking, self-service, waitlist and staff paths all enter here.
 */
import type { AvailabilityQuery } from './availability';
import { NativeScheduleAdapter } from './native-schedule-adapter';
import type { ScheduleAdapter, ScheduleCancelInput, ScheduleContext, ScheduleCreateInput, ScheduleMoveInput } from './schedule-adapter';
import { stableHash, type ScheduleOrigin } from './schedule-core';

export type GatewayContext = {
  origin: ScheduleOrigin; actor?: string; callId?: string; offerId?: string;
  requestId?: string; idempotencyKey?: string;
};
function readContext(context: GatewayContext, shape: unknown): ScheduleContext {
  return { ...context, idempotencyKey: context.idempotencyKey ?? `read:${stableHash(shape).slice(0, 48)}` };
}
function writeContext(context: GatewayContext): ScheduleContext {
  if (!context.idempotencyKey?.trim()) throw new Error('A stable idempotency key is required for schedule writes.');
  return { ...context, idempotencyKey: context.idempotencyKey.trim() };
}
export class ScheduleGateway {
  constructor(readonly orgId: string, private readonly override?: ScheduleAdapter) {}
  private adapter(): ScheduleAdapter { return this.override ?? new NativeScheduleAdapter(); }
  findSlots(query: Omit<AvailabilityQuery, 'orgId'> & { orgId?: string }, context: GatewayContext) {
    if (query.orgId && query.orgId !== this.orgId) throw new Error('Schedule query crossed workspace boundary.');
    const full = { ...query, orgId: this.orgId } as AvailabilityQuery;
    return this.adapter().findSlots(full, readContext(context, full));
  }
  isFree(input: {
    providerId: string; startsAt: string; durationMinutes: number; serviceId?: string;
    locationId?: string; ignoreBookingId?: string;
  }, context: GatewayContext) {
    const full = { ...input, orgId: this.orgId };
    return this.adapter().isFree(full, readContext(context, full));
  }
  createAppointment(input: Omit<ScheduleCreateInput, 'orgId'>, context: GatewayContext) {
    return this.adapter().createAppointment({ ...input, orgId: this.orgId }, writeContext(context));
  }
  moveAppointment(input: Omit<ScheduleMoveInput, 'orgId'>, context: GatewayContext) {
    return this.adapter().moveAppointment({ ...input, orgId: this.orgId }, writeContext(context));
  }
  cancelAppointment(input: Omit<ScheduleCancelInput, 'orgId'>, context: GatewayContext) {
    return this.adapter().cancelAppointment({ ...input, orgId: this.orgId }, writeContext(context));
  }
}
export function scheduleGatewayFor(orgId: string) { return new ScheduleGateway(orgId); }
