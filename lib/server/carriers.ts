/**
 * Carrier credentials, stored so they can actually be used.
 *
 * A phone number is useless without its carrier account: inbound webhooks, and
 * above all outbound dialling, both need the account SID and auth token. They
 * are encrypted at rest with AES-256-GCM — the key comes from
 * `VOXERA_SECRET_KEY` when the deployment sets one, otherwise a key file is
 * generated in `data/` so credentials are never written in clear.
 *
 * Nothing here is ever returned by an API read: routes hand back a masked hint
 * and a `verified` flag, which is all the dashboard needs to render.
 */

import crypto from 'node:crypto';
import { get, insert, list, nowIso, remove, update, type Doc } from './db';
import { audit } from './audit';
import { openSecret, sealSecret } from './secrets';

export type CarrierDoc = Doc & {
  orgId: string;
  provider: 'twilio';
  label: string;
  accountSid: string;
  encrypted: string;
  iv: string;
  authTag: string;
  webhookBase: string;
  verified: boolean;
  verifiedAt?: string;
  verifiedAccountName?: string;
  balance?: string;
  capabilities?: string[];
  lastError?: string;
  lastUsedAt?: string;
};

/* --------------------------------------------------------------- encryption */

// Carriers share the same hardened AES-GCM key lifecycle as model credentials,
// TOTP and tool headers. In particular, a read-only production filesystem never
// falls back to a public, deterministic key.
export const encryptSecret = sealSecret;

export function decryptSecret(doc: Pick<CarrierDoc, 'encrypted' | 'iv' | 'authTag'>) {
  return openSecret(doc);
}

/* -------------------------------------------------------------------- store */

export function maskSid(sid: string) {
  return sid.length > 8 ? `${sid.slice(0, 6)}••••${sid.slice(-3)}` : '••••';
}

/** Every carrier account on an org. */
export function carriersFor(orgId: string) {
  return list<CarrierDoc>('carriers', (c) => c.orgId === orgId);
}

export function carrierFor(orgId: string, provider?: string) {
  const all = list<CarrierDoc>('carriers', (c) => c.orgId === orgId);
  if (provider) return all.find((c) => c.provider === provider);
  return all[0];
}

export function createCarrier(input: {
  orgId: string;
  provider: CarrierDoc['provider'];
  label: string;
  accountSid: string;
  authToken: string;
  webhookBase: string;
}) {
  const existing = carrierFor(input.orgId, input.provider);
  const secret = encryptSecret(input.authToken);
  if (existing) {
    const updated = update<CarrierDoc>('carriers', existing.id, {
      ...secret,
      accountSid: input.accountSid,
      label: input.label,
      webhookBase: input.webhookBase,
      verified: false,
      lastError: undefined,
    });
    audit({ orgId: input.orgId, actor: 'dashboard', action: 'carrier.credentials_rotated', target: existing.id, detail: input.provider });
    return updated ?? { ...existing, ...secret };
  }
  const doc = insert<CarrierDoc>('carriers', {
    id: `car_${crypto.randomBytes(6).toString('hex')}`,
    orgId: input.orgId,
    provider: input.provider,
    label: input.label,
    accountSid: input.accountSid,
    ...secret,
    webhookBase: input.webhookBase,
    verified: false,
    createdAt: nowIso(),
  } as CarrierDoc);
  audit({ orgId: input.orgId, actor: 'dashboard', action: 'carrier.connected', target: doc.id, detail: `${input.provider} ${maskSid(input.accountSid)}` });
  return doc;
}

export function deleteCarrier(orgId: string, id: string) {
  const doc = get<CarrierDoc>('carriers', id);
  if (!doc || doc.orgId !== orgId) return undefined;
  remove('carriers', id);
  audit({ orgId, actor: 'dashboard', action: 'carrier.disconnected', target: id, detail: doc.provider });
  return doc;
}

/** The shape every read of a carrier returns — credentials never included. */
export function publicCarrier(doc: CarrierDoc) {
  return {
    id: doc.id,
    provider: doc.provider,
    label: doc.label,
    accountSid: maskSid(String(doc.accountSid)),
    verified: Boolean(doc.verified),
    verifiedAt: doc.verifiedAt,
    verifiedAccountName: doc.verifiedAccountName,
    balance: doc.balance,
    capabilities: doc.capabilities,
    webhookBase: doc.webhookBase,
    lastError: doc.lastError,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

/** Records the outcome of any carrier call so the dashboard can show health. */
export function markCarrierUse(id: string, patch: { ok: boolean; error?: string }) {
  update<CarrierDoc>('carriers', id, {
    lastUsedAt: nowIso(),
    lastError: patch.ok ? undefined : (patch.error ?? 'unknown error').slice(0, 300),
  });
}
