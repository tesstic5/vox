import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtDate(input: string | Date, opts?: Intl.DateTimeFormatOptions) {
  const d = typeof input === 'string' ? new Date(input) : input;
  return d.toLocaleDateString('en-US', opts ?? { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * "3h ago" — the age of something, which is `now − when`.
 *
 * Do not call this from JSX: the browser's `now` and the server's are different
 * instants, so the label can differ across hydration (React #418). Render
 * `<Ago at={…} />` instead, which handles that; `now` is still overridable here
 * for callers that hold a meaningful instant, such as tests. */
export function fmtRelative(input: string | Date, now = Date.now()) {
  const d = typeof input === 'string' ? new Date(input) : input;
  const diff = now - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
}

export function money(n: number, digits = 2) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/* ----------------------------------------------------------- randomness

   Two JS contexts build the demo workspace: the server renders the page, then
   the browser hydrates it. If `Math.random()` and `Date.now()` answer
   differently in each — and they always do — the two renders disagree, React
   reports a hydration mismatch (#418) and throws the server's HTML away. That is
   what happened on every dashboard page (D9).

   So randomness and the clock are *pinnable*: `pinRandomness(at)` fixes both to
   one instant and one PRNG stream, and the store pins them from a value the
   server puts in the page (`StoreProvider seedAt`). Unpinned — the default for
   everything outside the demo store — these behave exactly as they always did. */

let rng: () => number = Math.random;
let clock: () => number = Date.now;

/** Fix the stream and the clock. Call once, before building seeded state. */
export function pinRandomness(at: number) {
  clock = () => at;
  let state = (at >>> 0) || 1;
  rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pinned clock — the instant the demo workspace was seeded from. */
export function pinnedNow() {
  return clock();
}

/**
 * The instant the page was rendered, when something pinned it (`StoreProvider`).
 *
 * `<Ago>` labels against this until its own hydration is done, so the string the
 * browser first renders is the string the server wrote; see
 * `components/dash/Ago.tsx`, and the note on `fmtRelative` below. */
let renderedAt: number | null = null;

export function pinLabelClock(at: number) {
  renderedAt = at;
}

/** The instant the page was rendered — or now, if nothing pinned it. */
export function labelNow() {
  return renderedAt ?? Date.now();
}

/** One draw from the current stream (pinned or not). */
export function randF() {
  return rng();
}

export function uid(prefix = '') {
  // The suffix keeps the pinned clock, so a seeded id is identical on both sides;
  // the stream keeps advancing, so ids minted after mount are still unique.
  return `${prefix}${rng().toString(36).slice(2, 10)}${clock().toString(36).slice(-4)}`;
}

export function rand(min: number, max: number) {
  return rng() * (max - min) + min;
}

export function randInt(min: number, max: number) {
  return Math.floor(rand(min, max + 1));
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
