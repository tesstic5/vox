/**
 * The tokens behind password reset, magic links, email verification and
 * invitations.
 *
 * Four flows that look different and are the same thing underneath: a short
 * string that is mailed to somebody, proves they can read that inbox, works
 * once, and expires. So they share one collection and one rule set.
 *
 * The rules, and why each one is here rather than left to a caller:
 *
 *   - **Stored as a hash.** `authTokens` holds `sha256(plaintext)`. A leaked
 *     database file is not a pile of live reset links, for the same reason
 *     `sessions` holds hashes (`auth.ts`).
 *   - **Single use, enforced on read.** `redeem` marks `usedAt` before it hands
 *     the row back, so two requests arriving together cannot both win.
 *   - **Short lives.** Fifteen minutes for anything that signs somebody in or
 *     changes a credential; seven days for an invitation, because an invitation
 *     is a message a person may not read until Monday.
 *   - **Six-digit codes get an attempt budget.** Five wrong guesses locks the
 *     code for an hour — the number the verify screen has always printed. The
 *     lock lives on the row and survives a resend, so re-sending cannot be used
 *     to wipe the counter.
 *   - **One live token per kind per person.** Minting a new reset link revokes
 *     the previous one, so "the last email you received" is always the one that
 *     works.
 *
 * Server only. Nothing in this module is imported by a client component.
 */

import crypto from 'node:crypto';
import { find, get, insert, list, newId, nowIso, update, type Doc } from './db';

export type TokenKind = 'reset' | 'magic' | 'verify' | 'invite';

export type AuthTokenDoc = Doc & {
  kind: TokenKind;
  /** The account the token acts on. For an invitation this is the invited member. */
  userId: string;
  orgId: string;
  email: string;
  tokenHash: string;
  /** Only for `verify`: `sha256(id + ':' + code)`. The code itself is never stored. */
  codeHash?: string;
  attempts: number;
  maxAttempts: number;
  lockedUntil?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  requestIp?: string;
  /** Free-form extras — an invitation records who sent it and which role it grants. */
  meta?: Record<string, string>;
};

export const TOKEN_TTL_MS: Record<TokenKind, number> = {
  reset: 15 * 60_000,
  magic: 15 * 60_000,
  verify: 15 * 60_000,
  invite: 7 * 24 * 60 * 60_000,
};

/** How long a locked verification code stays locked. Printed on the verify screen. */
export const CODE_LOCK_MS = 60 * 60_000;
export const CODE_ATTEMPTS = 5;

const PREFIX: Record<TokenKind, string> = {
  reset: 'rt_',
  magic: 'ml_',
  verify: 'ev_',
  invite: 'inv_',
};

export function isTokenShaped(kind: TokenKind, value: string) {
  return value.startsWith(PREFIX[kind]) && value.length > PREFIX[kind].length + 10;
}

export type TokenFailure = 'unknown' | 'used' | 'expired' | 'revoked' | 'locked';

export type Peeked =
  | { valid: true; token: AuthTokenDoc; expiresAt: string }
  | { valid: false; reason: TokenFailure; token?: AuthTokenDoc; retryAt?: string };

function fresh(kind: TokenKind, doc: AuthTokenDoc | undefined, now = Date.now()): Peeked {
  if (!doc) return { valid: false, reason: 'unknown' };
  if (doc.revokedAt) return { valid: false, reason: 'revoked', token: doc };
  if (doc.usedAt) return { valid: false, reason: 'used', token: doc };
  if (doc.lockedUntil && new Date(doc.lockedUntil).getTime() > now) {
    return { valid: false, reason: 'locked', token: doc, retryAt: doc.lockedUntil };
  }
  if (new Date(doc.expiresAt).getTime() <= now) return { valid: false, reason: 'expired', token: doc };
  return { valid: true, token: doc, expiresAt: doc.expiresAt };
}

/** A human sentence for every way a token can fail, for the screen that shows it. */
export function tokenMessage(reason: TokenFailure) {
  switch (reason) {
    case 'used':
      return 'That link has already been used. Links work exactly once — request a fresh one.';
    case 'expired':
      return 'That link has expired. They last fifteen minutes, and an invitation lasts seven days.';
    case 'revoked':
      return 'That link was cancelled. Ask an owner or admin for a new one.';
    case 'locked':
      return 'Too many wrong codes. This one is locked for an hour — request a new code after that.';
    default:
      return 'That link is not valid. Check you copied the whole thing from the email.';
  }
}

function hashToken(plaintext: string) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

function hashCode(rowId: string, code: string) {
  return crypto.createHash('sha256').update(`${rowId}:${code}`).digest('hex');
}

/** Six digits, uniformly chosen, no leading-zero bias. */
export function sixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export type Minted = { token: AuthTokenDoc; plaintext: string; code?: string; expiresAt: string };

/**
 * Mints a token and revokes any live token of the same kind for the same person.
 *
 * Returns the plaintext exactly once; only its hash is stored.
 */
export function mintAuthToken(input: {
  kind: TokenKind;
  userId: string;
  orgId: string;
  email: string;
  requestIp?: string;
  meta?: Record<string, string>;
  /**
   * For `verify`. When true the row also carries a six-digit code, which is what
   * the email actually shows; the link in the email is a convenience that lands
   * on the code screen.
   */
  withCode?: boolean;
}): Minted {
  revokeTokensFor(input.userId, input.kind);

  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_TTL_MS[input.kind]).toISOString();
  const id = newId('atk_');
  const plaintext = `${PREFIX[input.kind]}${crypto.randomBytes(24).toString('base64url')}`;
  const code = input.withCode ? sixDigitCode() : undefined;

  const token = insert<AuthTokenDoc>('authTokens', {
    id,
    kind: input.kind,
    userId: input.userId,
    orgId: input.orgId,
    email: input.email,
    tokenHash: hashToken(plaintext),
    ...(code ? { codeHash: hashCode(id, code) } : {}),
    attempts: 0,
    maxAttempts: input.withCode ? CODE_ATTEMPTS : 0,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    requestIp: input.requestIp,
    meta: input.meta,
  } as AuthTokenDoc);

  return { token, plaintext, code, expiresAt };
}

export function tokenByPlaintext(kind: TokenKind, plaintext: string) {
  if (!isTokenShaped(kind, plaintext.trim())) return undefined;
  const hash = hashToken(plaintext.trim());
  return find<AuthTokenDoc>('authTokens', (t) => t.kind === kind && t.tokenHash === hash);
}

/** The newest live token of a kind for a person — used by the verify screen. */
export function liveTokenFor(userId: string, kind: TokenKind) {
  const rows = list<AuthTokenDoc>('authTokens', (t) => t.userId === userId && t.kind === kind && !t.usedAt && !t.revokedAt);
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
}

/** Reads a token without spending it: what a landing page needs to render itself. */
export function peekToken(kind: TokenKind, plaintext: string): Peeked {
  return fresh(kind, tokenByPlaintext(kind, plaintext));
}

export function peekRow(row: AuthTokenDoc | undefined): Peeked {
  return fresh(row?.kind ?? 'reset', row);
}

export function redeemToken(kind: TokenKind, plaintext: string): Peeked {
  const state = peekToken(kind, plaintext);
  if (!state.valid) return state;
  // Spend it before returning, so a second caller in the same tick loses.
  update<AuthTokenDoc>('authTokens', state.token.id, { usedAt: nowIso() } as Partial<AuthTokenDoc>);
  return state;
}

export function revokeToken(id: string) {
  update<AuthTokenDoc>('authTokens', id, { revokedAt: nowIso() } as Partial<AuthTokenDoc>);
}

export function revokeTokensFor(userId: string, kind?: TokenKind) {
  for (const row of list<AuthTokenDoc>('authTokens', (t) => t.userId === userId && (!kind || t.kind === kind) && !t.usedAt && !t.revokedAt)) {
    revokeToken(row.id);
  }
}

/**
 * Checks a six-digit code against a verification row.
 *
 * Returns the reason rather than throwing, because every one of these has a
 * different sentence to put on screen. The counter is incremented on the way
 * through, including on the fifth failure that locks the row.
 */
export function checkCode(row: AuthTokenDoc, code: string): { ok: true } | { ok: false; reason: TokenFailure; attemptsLeft: number } {
  const now = Date.now();
  if (row.lockedUntil && new Date(row.lockedUntil).getTime() > now) {
    return { ok: false, reason: 'locked', attemptsLeft: 0 };
  }
  const attempts = (row.attempts ?? 0) + 1;
  const matches = Boolean(row.codeHash) && hashCode(row.id, code.trim()) === row.codeHash;
  if (matches) {
    update<AuthTokenDoc>('authTokens', row.id, { attempts } as Partial<AuthTokenDoc>);
    return { ok: true };
  }
  const left = Math.max(0, (row.maxAttempts ?? CODE_ATTEMPTS) - attempts);
  update<AuthTokenDoc>('authTokens', row.id, {
    attempts,
    ...(left === 0 ? { lockedUntil: new Date(now + CODE_LOCK_MS).toISOString() } : {}),
  } as Partial<AuthTokenDoc>);
  return { ok: false, reason: left === 0 ? 'locked' : 'unknown', attemptsLeft: left };
}

/**
 * What the verify screen needs on load: is there a live code, how many tries are
 * left, and is it currently locked? One flat shape, because every caller asks
 * for a different subset of those four answers.
 */
export type VerifyState = {
  outstanding: boolean;
  expiresAt?: string;
  attemptsLeft?: number;
  locked?: boolean;
  retryAt?: string;
};

export function verificationState(userId: string): VerifyState {
  const row = liveTokenFor(userId, 'verify');
  if (!row) return { outstanding: false };
  const state = peekRow(row);
  if (state.valid) {
    return {
      outstanding: true,
      expiresAt: row.expiresAt,
      attemptsLeft: Math.max(0, (row.maxAttempts ?? CODE_ATTEMPTS) - (row.attempts ?? 0)),
      locked: false,
    };
  }
  if (state.reason === 'locked') return { outstanding: false, locked: true, retryAt: state.retryAt };
  return { outstanding: false };
}

export function tokenRowFor(id: string) {
  return get<AuthTokenDoc>('authTokens', id);
}
