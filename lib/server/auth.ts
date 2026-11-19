/**
 * Authentication, sessions, and API-key verification.
 *
 * Passwords are hashed with scrypt; sessions and API keys are stored as hashes
 * too, so a leaked database file does not hand over live credentials. Server
 * only — `node:crypto` and cookies are both required.
 */

import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { find, get, insert, list, update, newId, nowIso, type Doc } from './db';
import type { Sealed } from './secrets';
import {
  makeBusinessProfile,
  recommendedTermPack,
  type BusinessProfile,
  type BusinessType,
} from '../business';

export const SESSION_COOKIE = 'voxera_session';
const SESSION_DAYS = 30;

export type UserDoc = Doc & {
  email: string;
  name: string;
  passwordHash: string;
  orgId: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer' | 'receptionist' | 'practitioner';
  /** Optional granular role. Legacy `role` remains the compatibility baseline. */
  roleId?: string;
  /** Incremented when a role assignment changes, for session/cache invalidation. */
  permissionVersion?: number;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  /**
   * The live second factor (see `lib/server/totp.ts`). The secret is sealed at
   * rest; `twoFactorEnabled` is only true once enrolment has been confirmed
   * with a real code, and the sign-in flow refuses to mint a session without
   * one from then on.
   */
  totp?: {
    pending?: Sealed;
    sealed?: Sealed;
    enrolledAt?: string;
    recoveryHashes?: string[];
  };
  /**
   * The mobile this person rings in from, in E.164. Optional, and only ever used
   * for one thing: letting the assistant recognise a member of the team when
   * they call the practice's own line — see `report-tools.ts`.
   */
  phone?: string;
  createdAt: string;
  lastLoginAt?: string;
};

export type OrgDoc = Doc & {
  name: string;
  slug: string;
  plan: 'build' | 'scale' | 'enterprise';
  region: string;
  balanceMinutes: number;
  createdAt: string;
  /**
   * Absent on workspaces created before the multi-business rollout. Absence is
   * deliberate compatibility state: the dashboard keeps every existing module
   * until an owner explicitly saves a profile.
   */
  businessProfile?: BusinessProfile;
  /** Set by the platform operator (operator console). A suspended workspace's
   *  API access is refused until reactivated — see `requireAuth`. */
  suspended?: boolean;
  suspendedAt?: string;
  suspendedBy?: string;
};

export type SessionDoc = Doc & {
  userId: string;
  orgId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string;
  ip: string;
  revokedAt?: string;
};

export type ApiKeyDoc = Doc & {
  orgId: string;
  name: string;
  prefix: string;
  last4: string;
  keyHash: string;
  scopes: string[];
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

/* ------------------------------------------------------------------ hashing */

/**
 * scrypt, on the libuv threadpool.
 *
 * The synchronous form blocks the event loop for ~46 ms per hash (measured), and
 * this process also serves every API request and holds the media worker — so a
 * handful of concurrent logins would stall calls and dashboards along with them.
 * The async form costs the same CPU on a worker thread and returns the loop
 * immediately. Parameters are the Node defaults (N=16384, r=8, p=1, 64-byte key).
 */
function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

export async function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = (await scrypt(password, salt)).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, digest] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const candidate = await scrypt(password, salt);
  const b = Buffer.from(digest, 'hex');
  return candidate.length === b.length && crypto.timingSafeEqual(candidate, b);
}

export function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/* ---------------------------------------------------------------- api keys */

export const SUPPORTED_API_KEY_SCOPES = [
  '*',
  'assistants:read',
  'assistants:write',
  'bookings:read',
  'bookings:write',
  'calls:read',
  'calls:write',
  'clients:read',
  'clients:write',
  'clients:export',
  'cases:read',
  'cases:write',
  'clinical:read',
  'clinical:write',
  'documents:read',
  'documents:write',
  'documents:download',
  'documents:export',
  'forms:read',
  'forms:write',
  'tasks:read',
  'tasks:write',
  'automations:read',
  'automations:write',
  'referrals:read',
  'referrals:write',
  'letters:read',
  'letters:write',
  'privacy:read',
  'privacy:write',
  'field:read',
  'field:write',
  'integrations:read',
  'integrations:write',
  'integrations:sync',
  'numbers:read',
  'numbers:write',
] as const;

export function generateApiKey() {
  const secret = crypto.randomBytes(24).toString('hex');
  return { plaintext: `vk_live_${secret}`, prefix: 'vk_live', last4: secret.slice(-4), keyHash: sha256(secret) };
}

export function createApiKey(orgId: string, name: string, createdBy: string, scopes: string[] = ['*']) {
  const { plaintext, prefix, last4, keyHash } = generateApiKey();
  const doc = insert<ApiKeyDoc>('apiKeys', {
    id: newId('key_'),
    orgId,
    name,
    prefix,
    last4,
    keyHash,
    scopes,
    createdAt: nowIso(),
    createdBy,
  } as ApiKeyDoc);
  // The plaintext is returned once and never stored.
  return { key: doc, plaintext };
}

export function keyByPlaintext(plaintext: string) {
  const raw = plaintext.replace(/^Bearer\s+/i, '').trim();
  if (!raw.startsWith('vk_')) return undefined;
  const secret = raw.split('_').slice(2).join('_');
  const hash = sha256(secret);
  return find<ApiKeyDoc>('apiKeys', (k) => k.keyHash === hash && !k.revokedAt);
}

/* --------------------------------------------------------------- sessions */

export function createSession(user: UserDoc, meta: { userAgent: string; ip: string }) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = insert<SessionDoc>('sessions', {
    id: newId('ses_'),
    userId: user.id,
    orgId: user.orgId,
    tokenHash: sha256(token),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
    userAgent: meta.userAgent,
    ip: meta.ip,
  } as SessionDoc);
  return { token, session };
}

export function sessionFromToken(token: string | undefined) {
  if (!token) return undefined;
  const hash = sha256(token);
  const session = find<SessionDoc>('sessions', (s) => s.tokenHash === hash && !s.revokedAt);
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() < Date.now()) return undefined;
  return session;
}

export async function currentSession() {
  const jar = await cookies();
  return sessionFromToken(jar.get(SESSION_COOKIE)?.value);
}

export async function currentUser(): Promise<
  { user: UserDoc; org: OrgDoc; session: SessionDoc; auth: 'session' | 'key' } | undefined
> {
  const session = await currentSession();
  if (session) {
    const user = get<UserDoc>('users', session.userId);
    const org = get<OrgDoc>('orgs', session.orgId);
    // Deactivation ends the sessions it can find; this is the belt to that
    // braces — a cookie minted before somebody left must not keep working if a
    // revocation was ever missed.
    if (user && org && user.active !== false) return { user, org, session, auth: 'session' };
  }
  return undefined;
}

export function revokeSession(id: string) {
  update<SessionDoc>('sessions', id, { revokedAt: nowIso() } as Partial<SessionDoc>);
}

export function activeSessions(userId: string) {
  return list<SessionDoc>('sessions', (s) => s.userId === userId && !s.revokedAt).filter(
    (s) => new Date(s.expiresAt).getTime() > Date.now()
  );
}

/**
 * Flag the cookie `Secure` only when the request actually arrived over HTTPS.
 * Behind a proxy that means trusting `x-forwarded-proto`; on a plain-HTTP LAN
 * address it stays off, so the dashboard is still reachable at http://host:3000.
 */
export async function isHttpsRequest() {
  // A configured HTTPS public origin is the production source of truth. This
  // keeps session cookies Secure even if a reverse proxy forgets to forward the
  // scheme, while local HTTP remains usable when no public origin is configured.
  try {
    if (new URL(process.env.VOXERA_PUBLIC_URL ?? '').protocol === 'https:') return true;
  } catch {
    /* invalid/missing public URL: fall through to the request */
  }
  if (process.env.VOXERA_TRUST_PROXY !== '1') return false;
  const list = await headers();
  const proto = list.get('x-forwarded-proto') ?? '';
  return proto.split(',')[0].trim() === 'https';
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: await isHttpsRequest(),
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/* ------------------------------------------------------------- user+org ops */

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

export async function createUserWithOrg(input: {
  email: string;
  name: string;
  password: string;
  orgName: string;
  region: string;
  /** Optional for older API clients; the browser signup requires it. */
  businessType?: BusinessType;
  otherDescription?: string;
}) {
  const businessProfile = input.businessType
    ? {
        ...makeBusinessProfile(input.businessType, input.email.toLowerCase()),
        otherDescription: input.otherDescription?.trim() || undefined,
      }
    : undefined;
  const org = insert<OrgDoc>('orgs', {
    id: newId('org_'),
    name: input.orgName,
    slug: slugify(input.orgName) || 'workspace',
    plan: 'build',
    region: input.region,
    balanceMinutes: 60,
    createdAt: nowIso(),
    ...(businessProfile
      ? {
          businessProfile,
          // New workspaces start with the suitable interface vocabulary. This is
          // never run for existing workspaces and never guesses their type.
          practice: { termPack: recommendedTermPack(input.businessType!) },
        }
      : {}),
  } as OrgDoc);

  const user = insert<UserDoc>('users', {
    id: newId('usr_'),
    email: input.email.toLowerCase(),
    name: input.name,
    passwordHash: await hashPassword(input.password),
    orgId: org.id,
    role: 'owner',
    emailVerified: false,
    twoFactorEnabled: false,
    createdAt: nowIso(),
  } as UserDoc);

  return { user, org };
}

/**
 * Replaces somebody's password.
 *
 * Hashing lives here with the rest of the credential code, so a route never
 * touches `passwordHash` directly and a new flow cannot accidentally store a
 * plaintext. Callers are responsible for revoking sessions — that is a policy
 * decision (a reset ends them all; an invite acceptance has none to end).
 */
export async function setUserPassword(userId: string, password: string) {
  const hash = await hashPassword(password);
  return update<UserDoc>('users', userId, { passwordHash: hash });
}

/** Marks an address as proved — after a code, or after an invitation was accepted. */
export function markEmailVerified(userId: string) {
  return update<UserDoc>('users', userId, { emailVerified: true });
}

export function userByEmail(email: string) {
  return find<UserDoc>('users', (u) => u.email === email.toLowerCase());
}
