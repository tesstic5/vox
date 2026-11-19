/**
 * Rate limiting, kept in the database rather than in process memory.
 *
 * The original version was a `Map` in `lib/server/api.ts`. Two problems with
 * that on this deployment: the counter resets on every restart (which is also
 * how you reset a brute-force window), and the store is loaded twice — the Next
 * bundle and the media worker each have their own copy — so "120/min" was really
 * two separate budgets that neither process could see.
 *
 * Buckets live in the `rateBuckets` collection, keyed by identity, and expire on
 * their own window. `pruneRateBuckets` runs from the maintenance sweep.
 *
 * This is deliberately not a distributed rate limiter: the store is a file, so
 * it is exactly as consistent as the file is. It is, however, shared by every
 * process on the box and survives a restart, which is what the limits are for.
 */

import { get, incrementRateBucketAtomic, insert, nowIso, remove, removeRateBucketAtomic, list, storeDriver, update, type Doc } from './db';

export type RateLimitInfo = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

type BucketDoc = Doc & {
  /** The identity being limited, also used as the document id. */
  id: string;
  windowMs: number;
  count: number;
  resetAt: number;
  updatedAt: string;
};

export function rateLimit(identity: string, limit = 120, windowMs = 60_000): RateLimitInfo {
  const key = `rl_${Buffer.from(identity).toString('base64url').slice(0, 120)}`;
  const now = Date.now();
  if (storeDriver() === 'postgres') {
    const bucket = incrementRateBucketAtomic({ id: key, windowMs, now });
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
      limit,
    };
  }
  const existing = get<BucketDoc>('rateBuckets', key);

  if (!existing || existing.resetAt < now) {
    if (existing) {
      update<BucketDoc>('rateBuckets', key, { count: 1, resetAt: now + windowMs, windowMs } as Partial<BucketDoc>);
    } else {
      insert<BucketDoc>('rateBuckets', {
        id: key,
        windowMs,
        count: 1,
        resetAt: now + windowMs,
        createdAt: nowIso(),
      } as BucketDoc);
    }
    return { allowed: 1 <= limit, remaining: Math.max(0, limit - 1), resetAt: now + windowMs, limit };
  }

  const count = existing.count + 1;
  update<BucketDoc>('rateBuckets', key, { count } as Partial<BucketDoc>);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: existing.resetAt,
    limit,
  };
}

export function rateHeaders(info: RateLimitInfo) {
  return {
    'x-ratelimit-limit': String(info.limit),
    'x-ratelimit-remaining': String(info.remaining),
    'x-ratelimit-reset': String(Math.ceil(info.resetAt / 1000)),
  };
}

/* ------------------------------------------------- failure counters (lockout) */

/**
 * Per-identity *failure* counting, for the sign-in account throttle.
 *
 * `rateLimit` above counts every attempt, which is the right shape for "how
 * often may this IP knock" but the wrong shape for "has this account been
 * guessed at": a person who signs in successfully twenty times a day must
 * never drift toward a lockout. So failures get their own bucket discipline —
 * record on failure, peek without spending, clear on success. Same store,
 * same expiry sweep.
 */
function failureKey(identity: string) {
  return `rlf_${Buffer.from(identity).toString('base64url').slice(0, 110)}`;
}

export function recordFailure(identity: string, windowMs = 15 * 60_000): { count: number; resetAt: number } {
  const key = failureKey(identity);
  const now = Date.now();
  if (storeDriver() === 'postgres') return incrementRateBucketAtomic({ id: key, windowMs, now });
  const existing = get<BucketDoc>('rateBuckets', key);
  if (!existing || existing.resetAt < now) {
    const doc = { id: key, windowMs, count: 1, resetAt: now + windowMs, createdAt: nowIso(), updatedAt: nowIso() } as BucketDoc;
    if (existing) update<BucketDoc>('rateBuckets', key, doc as Partial<BucketDoc>);
    else insert<BucketDoc>('rateBuckets', doc);
    return { count: 1, resetAt: now + windowMs };
  }
  const count = existing.count + 1;
  update<BucketDoc>('rateBuckets', key, { count, updatedAt: nowIso() } as Partial<BucketDoc>);
  return { count, resetAt: existing.resetAt };
}

/** How many failures are on the clock right now. Never mutates. */
export function failureCount(identity: string): { count: number; resetAt: number } {
  const existing = get<BucketDoc>('rateBuckets', failureKey(identity));
  if (!existing || existing.resetAt < Date.now()) return { count: 0, resetAt: 0 };
  return { count: existing.count, resetAt: existing.resetAt };
}

export function clearFailures(identity: string) {
  const key = failureKey(identity);
  if (storeDriver() === 'postgres') {
    removeRateBucketAtomic(key);
    return;
  }
  if (get<BucketDoc>('rateBuckets', key)) remove('rateBuckets', key);
}

/** Drops expired buckets. Called on boot and from the maintenance sweep. */
export function pruneRateBuckets(): number {
  const now = Date.now();
  const stale = list<BucketDoc>('rateBuckets', (b) => b.resetAt < now);
  for (const bucket of stale) remove('rateBuckets', bucket.id);
  return stale.length;
}
