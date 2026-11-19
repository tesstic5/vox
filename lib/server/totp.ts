/**
 * Two-factor authentication: TOTP (RFC 6238) plus one-time recovery codes.
 *
 * Why this exists: until now `twoFactorEnabled` was a boolean the Security
 * screen could display but the sign-in flow never consulted — a control that
 * promised protection it did not provide. This module is the server half that
 * makes the promise true:
 *
 *   - Enrolment mints a random secret, sealed at rest (AES-256-GCM, via
 *     `secrets.ts`) on the user row. Nothing is "enabled" until the person
 *     proves they can read the secret back by producing a current code.
 *   - Sign-in with a correct password mints a short-lived *challenge* instead
 *     of a session. The challenge is a random token stored hashed, five
 *     minutes, five guesses — spent by `POST /api/auth/login/verify`.
 *   - Recovery codes are for the lost-phone day: eight codes, shown once,
 *     stored as sha256 hashes, each usable exactly once.
 *
 * TOTP itself is thirty lines on `node:crypto` (HMAC-SHA1, 30-second step,
 * 6 digits, ±1 step of clock drift) — small enough to own rather than depend
 * on, and verified below against the RFC 6238 test vectors by the security
 * gate's unit probe (`scripts/security_check.py` drives the HTTP surface;
 * the vectors are asserted in `scripts/totp-vectors.ts`).
 */

import crypto from 'node:crypto';
import { find, get, insert, list, remove, update, newId, nowIso, type Doc } from './db';
import { sha256, type UserDoc } from './auth';
import { sealSecret, openSecret, type Sealed } from './secrets';

/* ------------------------------------------------------------------ base32 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* -------------------------------------------------------------------- totp */

const STEP_MS = 30_000;
const DIGITS = 6;

export function totpCode(secret: Buffer, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / STEP_MS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Accepts the current step and one either side, for clock drift. */
export function verifyTotp(secret: Buffer, code: string, atMs: number = Date.now()): boolean {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  for (const drift of [-STEP_MS, 0, STEP_MS]) {
    const expected = totpCode(secret, atMs + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

export function newTotpSecret(): { base32: string; buffer: Buffer } {
  const buffer = crypto.randomBytes(20);
  return { base32: base32Encode(buffer), buffer };
}

export function otpauthUrl(email: string, base32: string): string {
  const label = encodeURIComponent(`Voxera:${email}`);
  return `otpauth://totp/${label}?secret=${base32}&issuer=Voxera&algorithm=SHA1&digits=6&period=30`;
}

/* ------------------------------------------------------------- recovery codes */

export function newRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function recoveryHash(code: string): string {
  return sha256(String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

/* ------------------------------------------------------------ user 2fa state */

export type TotpState = {
  /** Sealed secret awaiting confirmation; not yet a live factor. */
  pending?: Sealed;
  /** Sealed secret that is live. Presence + `twoFactorEnabled` = enforced. */
  sealed?: Sealed;
  enrolledAt?: string;
  recoveryHashes?: string[];
};

/** Narrows the loose user document to its 2FA state. */
export function totpState(user: UserDoc): TotpState {
  return ((user as UserDoc & { totp?: TotpState }).totp ?? {}) as TotpState;
}

export function twoFactorLive(user: UserDoc): boolean {
  const state = totpState(user);
  return Boolean(user.twoFactorEnabled && state.sealed);
}

function saveTotp(userId: string, state: TotpState, enabled: boolean) {
  update<UserDoc>('users', userId, { totp: state, twoFactorEnabled: enabled } as Partial<UserDoc>);
}

/** Step 1 of enrolment: mint a pending secret (shown once, as base32). */
export function beginEnrolment(user: UserDoc): { secret: string; otpauthUrl: string } {
  const { base32 } = newTotpSecret();
  const state = totpState(user);
  saveTotp(user.id, { ...state, pending: sealSecret(base32) }, Boolean(state.sealed) && user.twoFactorEnabled);
  return { secret: base32, otpauthUrl: otpauthUrl(user.email, base32) };
}

/**
 * Step 2: a current code against the pending secret makes it live and mints
 * the recovery codes (returned in plaintext exactly once).
 */
export function confirmEnrolment(user: UserDoc, code: string): { ok: true; recoveryCodes: string[] } | { ok: false; message: string } {
  const state = totpState(user);
  if (!state.pending) return { ok: false, message: 'Start enrolment first — there is no pending setup to confirm.' };
  const base32 = openSecret(state.pending);
  if (!base32) return { ok: false, message: 'The pending setup could not be read back. Start enrolment again.' };
  if (!verifyTotp(base32Decode(base32), code)) {
    return { ok: false, message: 'That code does not match the setup secret. Check the time on your phone and try the next code.' };
  }
  const recoveryCodes = newRecoveryCodes();
  saveTotp(
    user.id,
    { sealed: state.pending, enrolledAt: nowIso(), recoveryHashes: recoveryCodes.map(recoveryHash) },
    true
  );
  return { ok: true, recoveryCodes };
}

/** Checks a code against the live factor: TOTP first, then recovery codes. */
export function checkSecondFactor(user: UserDoc, code: string): { ok: boolean; via?: 'totp' | 'recovery' } {
  const state = totpState(user);
  if (!state.sealed) return { ok: false };
  const base32 = openSecret(state.sealed);
  if (base32 && verifyTotp(base32Decode(base32), code)) return { ok: true, via: 'totp' };
  const hash = recoveryHash(code);
  const hashes = state.recoveryHashes ?? [];
  const idx = hashes.indexOf(hash);
  if (idx >= 0) {
    // A recovery code works once; spending it is part of the check.
    const remaining = hashes.filter((_, i) => i !== idx);
    saveTotp(user.id, { ...state, recoveryHashes: remaining }, user.twoFactorEnabled);
    return { ok: true, via: 'recovery' };
  }
  return { ok: false };
}

/** Fresh recovery codes; the old set dies here. */
export function regenerateRecoveryCodes(user: UserDoc): string[] {
  const state = totpState(user);
  const recoveryCodes = newRecoveryCodes();
  saveTotp(user.id, { ...state, recoveryHashes: recoveryCodes.map(recoveryHash) }, user.twoFactorEnabled);
  return recoveryCodes;
}

export function disableTwoFactor(user: UserDoc) {
  saveTotp(user.id, {}, false);
}

export function twoFactorSummary(user: UserDoc) {
  const state = totpState(user);
  return {
    enabled: twoFactorLive(user),
    enrolledAt: state.enrolledAt ?? null,
    recoveryCodesRemaining: (state.recoveryHashes ?? []).length,
  };
}

/* ----------------------------------------------------------- login challenge */

export type MfaChallengeDoc = Doc & {
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
};

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;

/** Password accepted; now prove the second factor. Returns the raw token once. */
export function createMfaChallenge(userId: string): { token: string; expiresAt: string } {
  // One live challenge per person: a fresh sign-in replaces the last one.
  for (const old of list<MfaChallengeDoc>('mfaChallenges', (c) => c.userId === userId)) remove('mfaChallenges', old.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  insert<MfaChallengeDoc>('mfaChallenges', {
    id: newId('mfa_'),
    userId,
    tokenHash: sha256(token),
    createdAt: nowIso(),
    expiresAt,
    attempts: 0,
  } as MfaChallengeDoc);
  return { token, expiresAt };
}

/** Resolves a challenge token to its user, enforcing expiry and guess budget. */
export function resolveMfaChallenge(token: string): { user: UserDoc; challenge: MfaChallengeDoc } | { error: string } {
  const doc = find<MfaChallengeDoc>('mfaChallenges', (c) => c.tokenHash === sha256(String(token ?? '')));
  if (!doc) return { error: 'That sign-in attempt has expired. Sign in again.' };
  if (new Date(doc.expiresAt).getTime() < Date.now()) {
    remove('mfaChallenges', doc.id);
    return { error: 'That sign-in attempt has expired. Sign in again.' };
  }
  if (doc.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    remove('mfaChallenges', doc.id);
    return { error: 'Too many wrong codes. Sign in again to start over.' };
  }
  const user = get<UserDoc>('users', doc.userId);
  if (!user || user.active === false) return { error: 'That sign-in attempt has expired. Sign in again.' };
  return { user, challenge: doc };
}

export function recordChallengeGuess(challengeId: string) {
  const doc = get<MfaChallengeDoc>('mfaChallenges', challengeId);
  if (doc) update<MfaChallengeDoc>('mfaChallenges', challengeId, { attempts: doc.attempts + 1 } as Partial<MfaChallengeDoc>);
}

export function spendMfaChallenge(challengeId: string) {
  remove('mfaChallenges', challengeId);
}
