/**
 * Managed telephony.
 *
 * Numbers are self-serve: a client picks an area code and gets a line, without
 * first having to create a Twilio account of their own. The way that works is the
 * deployment's own carrier account — the platform buys the number and hands it to
 * the workspace, and "connect your own carrier" becomes an *option* rather than a
 * prerequisite.
 *
 * Two things keep that honest:
 *
 *   1. **It is never assumed.** With no platform credentials (or no workspace
 *      carrier) the API says so — `mode: 'none'` — and points at the carriers
 *      page rather than pretending a purchase succeeded.
 *   2. **Ownership is visible.** The managed account is a synthetic `CarrierDoc`
 *      with `managed: true` and no stored secrets; it is never written to the
 *      carriers collection, so the Carriers page keeps showing only accounts the
 *      client actually connected, while the Numbers page shows where each number
 *      came from.
 */

import { list, type Doc } from './db';
import type { CarrierDoc } from './carriers';
import { encryptSecret } from './carriers';

/** The environment a managed deployment reads its telephony account from. */
export const MANAGED_ENV = {
  accountSid: 'TWILIO_ACCOUNT_SID',
  authToken: 'TWILIO_AUTH_TOKEN',
} as const;

export const MANAGED_CARRIER_ID = 'carrier_managed';

/**
 * The deployment's own carrier account, expressed as a carrier document so the
 * same provider client can talk to it.
 *
 * The auth token is encrypted exactly as a workspace credential would be, so
 * nothing downstream has to know this one came from the environment — and nothing
 * logs it either, because `publicCarrier` masks whatever it is given.
 */
export function managedCarrier(): (CarrierDoc & { managed: true }) | undefined {
  const accountSid = process.env[MANAGED_ENV.accountSid];
  const authToken = process.env[MANAGED_ENV.authToken];
  if (!accountSid || !authToken) return undefined;

  const sealed = sealForManaged(authToken);
  return {
    id: MANAGED_CARRIER_ID,
    orgId: '__platform__',
    provider: 'twilio',
    label: 'Voxera-managed numbers',
    accountSid,
    ...sealed,
    webhookBase: process.env.VOXERA_PUBLIC_URL ?? 'http://127.0.0.1:3000',
    verified: true,
    verifiedAt: new Date().toISOString(),
    verifiedAccountName: 'Voxera platform account',
    capabilities: ['voice', 'sms', 'numbers'],
    managed: true,
  };
}

function sealForManaged(authToken: string): { encrypted: string; iv: string; authTag: string } {
  const sealed = encryptSecret(authToken);
  return { encrypted: sealed.encrypted, iv: sealed.iv, authTag: sealed.authTag };
}

export type TelephonyMode = 'workspace' | 'managed' | 'none';

/**
 * Which account would dial, and buy numbers, for this workspace.
 *
 * A client's own carrier always wins: they are paying for it, they can see the
 * bill, and a deployment must never quietly route their traffic through the
 * platform account instead.
 */
export function telephonyMode(orgId: string): TelephonyMode {
  const own = list<CarrierDoc>('carriers', (c) => c.orgId === orgId);
  if (own.length) return 'workspace';
  return managedCarrier() ? 'managed' : 'none';
}

/** The carrier to dial and buy with: the workspace's own, else the platform's. */
export function dialerFor(orgId: string, carrierId?: string): CarrierDoc | undefined {
  const own = list<CarrierDoc>('carriers', (c) => c.orgId === orgId);
  const picked = carrierId ? own.find((c) => c.id === carrierId) : undefined;
  return picked ?? own[0] ?? managedCarrier();
}

/** Where a number came from, for the dashboard to show rather than guess. */
export function numberOrigin(number: Doc & { carrierId?: string }, orgId: string): 'workspace' | 'managed' | 'none' {
  if (number.carrierId === MANAGED_CARRIER_ID) return 'managed';
  if (number.carrierId) return 'workspace';
  return telephonyMode(orgId);
}

/**
 * Area codes a client can choose from.
 *
 * The list is a starting point rather than a limit — any area code the carrier
 * actually has inventory in works — but offering a handful by name beats making
 * someone look up which digits belong to their city.
 */
export const MANAGED_AREA_CODES = [
  { code: '415', label: 'San Francisco, CA', country: 'US' },
  { code: '212', label: 'New York, NY', country: 'US' },
  { code: '312', label: 'Chicago, IL', country: 'US' },
  { code: '646', label: 'Manhattan, NY', country: 'US' },
  { code: '703', label: 'Northern Virginia', country: 'US' },
  { code: '206', label: 'Seattle, WA', country: 'US' },
  { code: '305', label: 'Miami, FL', country: 'US' },
  { code: '720', label: 'Denver, CO', country: 'US' },
  { code: '512', label: 'Austin, TX', country: 'US' },
  { code: '404', label: 'Atlanta, GA', country: 'US' },
];

export function areaCodeLabel(code: string) {
  return MANAGED_AREA_CODES.find((a) => a.code === code)?.label ?? `Area code ${code}`;
}
