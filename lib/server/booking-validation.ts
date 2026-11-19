import { BOOKING_STATUSES, type BookingInput, type BookingStatus } from './bookings';
import { isValidTimezone } from './practice';

export type BookingValidationFailure = { error: string; param: string };
export type BookingValidationResult = { value: BookingInput } | BookingValidationFailure;

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalId(value: unknown, param: string): string | undefined | BookingValidationFailure {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return { error: `\`${param}\` must be a string.`, param };
  const clean = value.trim();
  if (!clean || clean.length > 200) return { error: `\`${param}\` must be 1 to 200 characters.`, param };
  return clean;
}

/** Validate and normalise one external booking before any store write occurs. */
export function validateBookingInput(raw: unknown): BookingValidationResult {
  if (!plainObject(raw)) return { error: 'Each booking must be a JSON object.', param: 'bookings' };

  const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : '';
  if (!externalId || externalId.length > 200) {
    return { error: '`externalId` must be 1 to 200 characters.', param: 'externalId' };
  }

  if (!plainObject(raw.customer)) return { error: '`customer` must be an object.', param: 'customer' };
  const customerUnknown = Object.keys(raw.customer).find((key) => !['name', 'number', 'email'].includes(key));
  if (customerUnknown) return { error: `\`customer.${customerUnknown}\` is not supported.`, param: `customer.${customerUnknown}` };

  const number = String(raw.customer.number ?? '').replace(/[^\d+]/g, '');
  if (!E164.test(number)) return { error: '`customer.number` must be E.164.', param: 'customer.number' };
  const customerName = raw.customer.name === undefined ? 'Customer' : String(raw.customer.name).trim();
  if (!customerName || customerName.length > 160) {
    return { error: '`customer.name` must be 1 to 160 characters.', param: 'customer.name' };
  }
  const email = raw.customer.email === undefined || raw.customer.email === null || raw.customer.email === ''
    ? undefined
    : String(raw.customer.email).trim().toLowerCase();
  if (email && (email.length > 254 || !EMAIL.test(email))) {
    return { error: '`customer.email` must be a valid email address.', param: 'customer.email' };
  }

  if (typeof raw.startsAt !== 'string' || !raw.startsAt.trim()) {
    return { error: '`startsAt` must be an ISO timestamp.', param: 'startsAt' };
  }
  const starts = Date.parse(raw.startsAt);
  if (!Number.isFinite(starts)) return { error: '`startsAt` must be a valid ISO timestamp.', param: 'startsAt' };

  let durationMinutes: number | undefined;
  if (raw.durationMinutes !== undefined && raw.durationMinutes !== null) {
    durationMinutes = Number(raw.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1_440) {
      return { error: '`durationMinutes` must be an integer from 5 to 1440.', param: 'durationMinutes' };
    }
  }

  let status: BookingStatus | undefined;
  if (raw.status !== undefined && raw.status !== null && raw.status !== '') {
    if (typeof raw.status !== 'string' || !BOOKING_STATUSES.includes(raw.status as BookingStatus)) {
      return { error: `\`status\` must be one of: ${BOOKING_STATUSES.join(', ')}.`, param: 'status' };
    }
    status = raw.status as BookingStatus;
  }

  const timezone = raw.timezone === undefined || raw.timezone === null || raw.timezone === '' ? undefined : String(raw.timezone).trim();
  if (timezone && (timezone.length > 100 || !isValidTimezone(timezone))) {
    return { error: '`timezone` must be a valid IANA timezone.', param: 'timezone' };
  }

  const service = raw.service === undefined || raw.service === null ? undefined : String(raw.service).trim();
  if (service !== undefined && (!service || service.length > 160)) {
    return { error: '`service` must be 1 to 160 characters.', param: 'service' };
  }
  const notes = raw.notes === undefined || raw.notes === null ? undefined : String(raw.notes);
  if (notes !== undefined && notes.length > 4_000) return { error: '`notes` is too long.', param: 'notes' };

  let value: number | undefined;
  if (raw.value !== undefined && raw.value !== null) {
    value = Number(raw.value);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      return { error: '`value` must be a non-negative finite amount.', param: 'value' };
    }
  }

  let metadata: Record<string, string> | undefined;
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (!plainObject(raw.metadata)) return { error: '`metadata` must be an object of string values.', param: 'metadata' };
    const entries = Object.entries(raw.metadata);
    if (entries.length > 50) return { error: '`metadata` may contain at most 50 entries.', param: 'metadata' };
    metadata = {};
    for (const [key, item] of entries) {
      if (['removedFromSource', 'syncSourceId'].includes(key)) {
        return { error: `\`metadata.${key}\` is server-managed.`, param: `metadata.${key}` };
      }
      if (!key.trim() || key.length > 100 || typeof item !== 'string' || item.length > 1_000) {
        return { error: '`metadata` keys must be 1 to 100 characters and values must be strings up to 1000 characters.', param: 'metadata' };
      }
      metadata[key] = item;
    }
  }

  const ids: Record<'providerId' | 'serviceId' | 'locationId' | 'roomId' | 'caseId' | 'coverageId' | 'authorisationId', string | undefined> = {
    providerId: undefined,
    serviceId: undefined,
    locationId: undefined,
    roomId: undefined,
    caseId: undefined,
    coverageId: undefined,
    authorisationId: undefined,
  };
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    const result = optionalId(raw[key], key);
    if (plainObject(result) && 'error' in result) return result;
    ids[key] = result as string | undefined;
  }

  const fundingOverrideReason = raw.fundingOverrideReason === undefined || raw.fundingOverrideReason === null || raw.fundingOverrideReason === ''
    ? undefined
    : String(raw.fundingOverrideReason).trim();
  if (fundingOverrideReason && (fundingOverrideReason.length > 500 || /[\u0000-\u001f]/.test(fundingOverrideReason))) {
    return { error: '`fundingOverrideReason` must be plain text up to 500 characters.', param: 'fundingOverrideReason' };
  }

  return {
    value: {
      externalId,
      customer: { name: customerName, number, email },
      service,
      startsAt: new Date(starts).toISOString(),
      durationMinutes,
      timezone,
      status,
      notes,
      value,
      metadata,
      fundingOverrideReason,
      ...ids,
    },
  };
}

export function isHistoricalTerminalBooking(input: Pick<BookingInput, 'startsAt' | 'durationMinutes' | 'status'>): boolean {
  const end = new Date(input.startsAt).getTime() + (input.durationMinutes ?? 30) * 60_000;
  return end < Date.now() && ['completed', 'cancelled', 'no_show'].includes(input.status ?? 'confirmed');
}
