'use client';

import { useSyncExternalStore } from 'react';
import { fmtRelative, labelNow } from '@/lib/utils';

/* Nothing to subscribe to: the answer changes once, when hydration finishes. */
const subscribe = () => () => {};
const hydrated = () => true;
const notYet = () => false;

/**
 * A relative timestamp ("3h ago", "just now") that cannot cause a hydration
 * mismatch.
 *
 * The age of a row is `now − when`, and `now` is not the same anywhere: the
 * server rendered this page at build time, and the browser renders it when the
 * reader arrives. Any row sitting on a rounding boundary then reads differently
 * in the two renders — the server wrote "38m ago" and the browser, a minute
 * later, wrote "39m ago" — which is exactly the React #418 that `/dashboard/logs`
 * and `/dashboard/notifications` kept producing (D9), and why every attempt to
 * pin a single module-level clock ended up chasing the *last* subtree to hydrate.
 *
 * `useSyncExternalStore`'s third argument is the value React uses during server
 * rendering **and through hydration**, then it re-renders once with the live
 * value. So the first render reproduces the server's exact string — there is no
 * flag to race and no warning to suppress — and every render after it is the
 * honest age, measured against `labelNow()` (the instant the page was rendered)
 * until then and against the real clock afterwards. */
export function Ago({ at }: { at?: string | Date | null }) {
  const live = useSyncExternalStore(subscribe, hydrated, notYet);
  if (!at) return null;
  return <span>{fmtRelative(at, live ? Date.now() : labelNow())}</span>;
}
