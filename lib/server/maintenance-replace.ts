/**
 * Capability gate for intentional whole-store replacement.
 *
 * Runtime code must never be able to turn append-only clinical evidence into an
 * ordinary mutable collection. The few offline/test tools that deliberately
 * replace an entire throwaway store receive an unforgeable process-local token,
 * and only while an explicit non-production maintenance window is open.
 */

const CAPABILITY = Object.freeze({ kind: 'voxera-destructive-maintenance' });
let active = false;

type Capability = typeof CAPABILITY;

function enabled() {
  return process.env.VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE === '1';
}

export function assertDestructiveMaintenanceCapability(value: unknown): asserts value is Capability {
  if (!active || value !== CAPABILITY) {
    throw new Error('destructive store replacement requires an active private maintenance capability');
  }
  if (!enabled()) {
    throw new Error('destructive maintenance is disabled; set VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE=1 in the offline tool process');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('destructive maintenance windows are forbidden when NODE_ENV=production');
  }
}

/** Synchronous by design: the capability cannot escape across an await. */
export function withDestructiveMaintenance<T>(reason: string, work: (capability: Capability) => T): T {
  if (!reason.trim()) throw new Error('destructive maintenance requires a recorded reason');
  if (active) throw new Error('nested destructive maintenance windows are forbidden');
  if (!enabled()) {
    throw new Error('destructive maintenance is disabled; set VOXERA_ALLOW_DESTRUCTIVE_MAINTENANCE=1 in the offline tool process');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('destructive maintenance windows are forbidden when NODE_ENV=production');
  }
  active = true;
  try {
    const result = work(CAPABILITY);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('destructive maintenance work must be synchronous');
    }
    return result;
  } finally {
    active = false;
  }
}
