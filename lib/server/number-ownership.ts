import { insert, list, listBy, newId, nowIso, remove, type Doc } from './db';

export type NumberClaim = Doc & {
  orgId: string;
  number?: string;
  carrierId?: string;
  carrierSid?: string;
  status?: string;
};

export type NumberReservation = Doc & {
  orgId: string;
  number: string;
  carrierId: string;
  operation: 'purchase' | 'adopt' | 'onboarding-purchase';
  createdAt: string;
  expiresAt: string;
};

const RESERVATION_MS = 10 * 60 * 1000;

export function normalizeDialableNumber(value: unknown): string {
  return String(value ?? '').replace(/[^\d+]/g, '');
}

function activeReservations(number: string, excludeId?: string): NumberReservation[] {
  const now = Date.now();
  const wanted = normalizeDialableNumber(number);
  // This path also runs immediately after a database unique-index loser. Use the
  // engine-backed equality query rather than the short-lived collection cache so
  // the losing process can name the winner even inside the cache poll interval.
  const rows = listBy<NumberReservation>('numberClaims', { number: wanted }, { limit: 100 });
  const active: NumberReservation[] = [];
  for (const row of rows) {
    if (new Date(row.expiresAt).getTime() <= now) {
      remove('numberClaims', row.id);
      continue;
    }
    if (row.id !== excludeId) active.push(row);
  }
  return active;
}

/** Active platform claims for one dialable E.164 number, across every tenant. */
export function claimsForNumber(number: string, opts?: { excludeId?: string; excludeReservationId?: string }): NumberClaim[] {
  const wanted = normalizeDialableNumber(number);
  if (!/^\+[1-9]\d{7,14}$/.test(wanted)) return [];
  return list<NumberClaim>(
    'numbers',
    (row) =>
      row.id !== opts?.excludeId &&
      row.status !== 'released' &&
      Boolean(row.carrierId || row.carrierSid) &&
      normalizeDialableNumber(row.number) === wanted
  );
}

export function numberClaimConflict(
  number: string,
  orgId: string,
  opts?: { excludeId?: string; excludeReservationId?: string }
): NumberClaim | undefined {
  const pending = activeReservations(number, opts?.excludeReservationId).map<NumberClaim>((row) => ({
    ...row,
    carrierSid: 'pending',
    status: 'claiming',
  }));
  const claims = [...claimsForNumber(number, opts), ...pending];
  return claims.find((row) => row.orgId !== orgId) ?? claims[0];
}

/**
 * Reserve a number before an async carrier mutation.
 *
 * Route-level preflight checks are not enough: two tenants can both pass them,
 * await the carrier, and then race to persist. SQLite's partial unique index on
 * this collection is the final arbiter; the JSON fallback remains safe inside a
 * single process because check + insert contains no await.
 */
export function reserveNumberClaim(input: {
  number: string;
  orgId: string;
  carrierId: string;
  operation: NumberReservation['operation'];
}): { ok: true; reservation: NumberReservation } | { ok: false; conflict?: NumberClaim } {
  const number = normalizeDialableNumber(input.number);
  const conflict = numberClaimConflict(number, input.orgId);
  if (conflict) return { ok: false, conflict };
  const createdAt = nowIso();
  try {
    const reservation = insert<NumberReservation>('numberClaims', {
      id: newId('ncl_'),
      orgId: input.orgId,
      number,
      carrierId: input.carrierId,
      operation: input.operation,
      createdAt,
      expiresAt: new Date(Date.now() + RESERVATION_MS).toISOString(),
    } as NumberReservation);
    return { ok: true, reservation };
  } catch {
    return { ok: false, conflict: numberClaimConflict(number, input.orgId) };
  }
}

export function releaseNumberReservation(reservation: NumberReservation | string | undefined) {
  const id = typeof reservation === 'string' ? reservation : reservation?.id;
  if (id) remove('numberClaims', id);
}
