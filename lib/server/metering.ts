/**
 * Metering.
 *
 * Every call already writes a `usageEvents` row with its minutes and cost, and
 * the assistant keeps running totals. What nothing ever touched was the number
 * on the organisation itself: `balanceMinutes` has been reported by login, `/me`
 * and signup since the beginning and was entirely decorative — it could only go
 * up (signup grants 60) and never down.
 *
 * That is the difference between a number that reads like billing and a number
 * that behaves like it. This module decrements it, keeps a cumulative `minutesUsed`
 * alongside so nothing is lost when the balance hits zero, and writes an audit
 * entry when a workspace crosses from having minutes to not having any.
 *
 * Enforcement is deliberately soft here (a demo workspace should not brick itself
 * mid-story). The number is now real; refusing new calls once it is exhausted is
 * a policy decision the deployment makes, not a side effect of the meter.
 */

import { get, nowIso, update, type Doc } from './db';
import { audit } from './audit';

export type MeterableOrg = Doc & {
  name?: string;
  balanceMinutes?: number;
  minutesUsed?: number;
  lowBalanceNotifiedAt?: string;
};

export function meterMinutes(orgId: string, minutes: number) {
  const org = get<MeterableOrg>('orgs', orgId);
  if (!org) return undefined;
  const balance = Math.max(0, (org.balanceMinutes ?? 0) - minutes);
  const used = Number(((org.minutesUsed ?? 0) + minutes).toFixed(4));
  update<MeterableOrg>('orgs', orgId, {
    balanceMinutes: Number(balance.toFixed(4)),
    minutesUsed: used,
    lastMeteredAt: nowIso(),
  } as Partial<MeterableOrg>);

  // One notice per crossing, not one per call: the point is that a workspace
  // owner can see when the account ran dry.
  if (balance === 0 && (org.balanceMinutes ?? 0) > 0) {
    audit({
      orgId,
      actor: 'metering',
      action: 'org.balance_exhausted',
      target: orgId,
      detail: `${used} minutes used; balance reached zero`,
    });
    update<MeterableOrg>('orgs', orgId, { lowBalanceNotifiedAt: nowIso() } as Partial<MeterableOrg>);
  }
  return balance;
}
