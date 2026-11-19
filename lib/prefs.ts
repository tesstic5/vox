/**
 * Dashboard preferences.
 *
 * A preference is what a person chose about their own screen: hide client names
 * on the grid, start the calendar on the work week. It is not a record, and it
 * is not about a client — which is why it is allowed in the browser when a
 * client list is not.
 *
 * The line is worth drawing carefully, because "it is only a preference" is how
 * browser storage gets filled with things that are not:
 *
 *   - only keys listed in `PREF_KEYS` may be written, and every key is a
 *     constant in this file rather than a string built at a call site;
 *   - only primitives are stored. An object parameter is stringified, so a
 *     caller cannot smuggle a client record into a preference;
 *   - a value that looks like a record is refused outright.
 *
 * `scripts/privacy_check.ts` holds that line.
 */

import { findPrivateData } from './privacy';

export const PREF_KEYS = {
  /**
   * Privacy mode: the diary hides client names on the grid. Set here rather than
   * per-appointment because the reason to use it (a screen that a waiting room
   * can see) does not change between appointments.
   */
  calendarPrivacy: 'voxera.pref.calendarPrivacy',
} as const;

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

const ALLOWED = new Set<string>(Object.values(PREF_KEYS));

export function readPref(key: PrefKey): string | null {
  if (!ALLOWED.has(key) || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes a preference. Returns false when it was refused — which is a caller
 * bug, not a user-facing error, so callers may ignore it; the value simply does
 * not persist.
 */
export function writePref(key: PrefKey, value: string | number | boolean): boolean {
  if (!ALLOWED.has(key) || typeof window === 'undefined') return false;
  const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  if (!scalar || findPrivateData({ [key]: scalar }).length) return false;
  try {
    window.localStorage.setItem(key, scalar);
    return true;
  } catch {
    return false;
  }
}

/** Every preference key this build is allowed to write. */
export function prefKeys(): string[] {
  return [...ALLOWED];
}
