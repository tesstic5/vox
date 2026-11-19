import crypto from 'node:crypto';

/** The product channel that requested a native diary operation. */
export type ScheduleOrigin = 'staff' | 'phone' | 'public' | 'waitlist' | 'system' | 'sync';

export type ScheduleErrorCode =
  | 'SLOT_TAKEN'
  | 'CONFLICT'
  | 'SCHEDULE_UNAVAILABLE'
  | 'IDENTITY_REVIEW_REQUIRED';

/** A safe, typed scheduling failure that callers may translate without string matching. */
export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly code: ScheduleErrorCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** Stable canonical hash used for idempotency keys and native slot fingerprints. */
export function stableHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
