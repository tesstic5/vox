/**
 * The team: who can sign in, what they may do, and how that changes.
 *
 * Until now a workspace had exactly one owner and whoever the demo seeder
 * created; roles existed as a type union and three hard-coded allow-lists
 * (`NOTE_READ_ROLES`, `MONEY_*_ROLES`, `requireConfigRole`). A clinic cannot
 * run like that — a receptionist is hired, a locum covers a fortnight, somebody
 * leaves — and doing it by editing the database is how a leaver keeps a login.
 *
 * Design rules:
 *
 *   1. **The permission table is derived, not decorative.** `capabilitiesFor`
 *      reads the same lists the middleware enforces, so the team screen cannot
 *      promise a role something the API will refuse.
 *   2. **Nothing leaks a password hash.** An invite or a reset mints a
 *      temporary password, returns it once, and stores only its hash.
 *   3. **A workspace always has an owner.** The last owner cannot be demoted,
 *      deactivated or deleted; the API says why instead of leaving a practice
 *      with nobody who can administer it.
 *   4. **Every change is audited**, with who did it to whom.
 */

import crypto from 'node:crypto';
import { find, insert, list, newId, nowIso, update, type Doc } from './db';
import { audit } from './audit';
import { hashPassword, type UserDoc } from './auth';
import { MONEY_EDIT_ROLES, MONEY_READ_ROLES, MONEY_TAKE_ROLES } from './money';
import { NOTE_READ_ROLES } from './notes';

export type Role = UserDoc['role'];

export const ROLES: Role[] = ['owner', 'admin', 'developer', 'receptionist', 'practitioner', 'viewer'];

const CONFIG_ROLES: Role[] = ['owner', 'admin', 'developer'];

export type Capability = {
  key: string;
  label: string;
  /** One line in the practice's own words, for the person choosing a role. */
  note: string;
  roles: Role[];
};

/**
 * What a role may do, in the vocabulary of the dashboard.
 *
 * Each row names the allow-list that actually enforces it in the server code.
 */
export const CAPABILITIES: Capability[] = [
  { key: 'diary.run', label: 'Run the diary', note: 'Book, move, cancel and check people in', roles: ['owner', 'admin', 'developer', 'receptionist'] },
  { key: 'clients.edit', label: 'Edit client records', note: 'Add and amend clients, notes on the record, consents', roles: ['owner', 'admin', 'developer', 'receptionist'] },
  {
    key: 'notes.read',
    label: 'Read clinical notes',
    note: 'Open finalised notes the reception team cannot see',
    roles: [...NOTE_READ_ROLES],
  },
  {
    key: 'notes.write',
    label: 'Write clinical notes',
    note: 'Draft, sign and amend notes against a visit',
    // `canWriteNotes` is the same list as reading, on purpose: a role that may
    // not see clinical content may not add to it.
    roles: [...NOTE_READ_ROLES],
  },
  { key: 'money.read', label: 'See money', note: 'Invoices, payments, balances and reports', roles: [...MONEY_READ_ROLES] },
  { key: 'money.edit', label: 'Change money', note: 'Issue, amend, credit and void; expenses', roles: [...MONEY_EDIT_ROLES] },
  { key: 'money.take', label: 'Take money', note: 'Record a payment at the desk', roles: [...MONEY_TAKE_ROLES] },
  { key: 'practice.config', label: 'Change practice setup', note: 'Providers, services, sites, rooms, hours and booking policy', roles: CONFIG_ROLES },
  { key: 'team.manage', label: 'Manage the team', note: 'Invite people, change roles, deactivate logins', roles: CONFIG_ROLES },
];

export function capabilitiesFor(role: Role): Capability[] {
  return CAPABILITIES.filter((c) => c.roles.includes(role));
}

export type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  roleId?: string;
  roleName?: string;
  active: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt?: string;
  lastLoginAt?: string;
  lastActiveAt?: string;
  sessions: number;
  /** The mobile the assistant recognises them by, when they have given one. */
  phone?: string;
  isYou?: boolean;
  /** A practitioner's record, when this login is tied to one. */
  providerId?: string;
  providerName?: string;
};

export function membersFor(orgId: string, opts?: { youId?: string }): MemberRow[] {
  const users = list<UserDoc>('users', (u) => u.orgId === orgId);
  const sessions = list<Doc & { userId?: string; orgId?: string; expiresAt?: string; revokedAt?: string; createdAt?: string }>(
    'sessions',
    (s) => s.orgId === orgId && !s.revokedAt && new Date(String(s.expiresAt ?? 0)) > new Date()
  );
  const providers = list<Doc & { id: string; orgId?: string; name?: string; userId?: string; email?: string }>('providers', (p) => p.orgId === orgId);
  const granularRoles = list<Doc & { id: string; orgId?: string; name?: string }>('roles', (role) => role.orgId === orgId);

  return users
    .map((user) => {
      const mine = sessions.filter((s) => s.userId === user.id);
      const provider = providers.find((p) => p.userId === user.id || (p.email && p.email.toLowerCase() === user.email));
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        roleId: user.roleId,
        roleName: user.roleId ? granularRoles.find((role) => role.id === user.roleId)?.name : undefined,
        active: user.active !== false,
        emailVerified: Boolean(user.emailVerified),
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        lastActiveAt: mine.map((s) => String(s.createdAt ?? '')).sort().pop(),
        sessions: mine.length,
        phone: user.phone,
        isYou: user.id === opts?.youId,
        providerId: provider?.id,
        providerName: provider?.name,
      };
    })
    .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
}

function ownersIn(orgId: string): UserDoc[] {
  return list<UserDoc>('users', (u) => u.orgId === orgId && u.role === 'owner' && u.active !== false);
}

export function memberById(orgId: string, id: string): UserDoc | undefined {
  return find<UserDoc>('users', (u) => u.orgId === orgId && u.id === id);
}

/** A readable temporary password: long enough to be real, short enough to read out. */
function temporaryPassword(): string {
  const words = ['clinic', 'diary', 'rota', 'visit', 'record', 'slot', 'care', 'path'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 9999)}`;
}

/**
 * Add somebody to the workspace.
 *
 * The password is hashed before the row is written — a user row holding a
 * promise instead of a hash is a login that never works — and the plain text is
 * returned exactly once, for the person inviting to pass on.
 */
/**
 * A phone number this platform will recognise, or nothing.
 *
 * E.164 is the only shape that survives a round trip through a carrier, so the
 * rule is strict — digits, a leading +, 8 to 15 of them — and a number that fails
 * is rejected rather than stored in a form that would never match a live call.
 */
export function normalisePhone(value?: string): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return undefined;
  if (!/^\+/.test(raw) && digits.length < 10) return undefined;
  return `+${digits}`;
}

/** Puts a mobile on somebody's record — or takes it off, when it is blank. */
export function setMemberPhone(orgId: string, id: string, value: string | undefined, actorId: string, actor: string) {
  const user = memberById(orgId, id);
  if (!user) return { error: 'not_found' as const, message: 'No such member.' };
  const phone = normalisePhone(value);
  if (String(value ?? '').trim() && !phone) {
    return { error: 'validation' as const, message: 'That mobile number does not look right — use the full number, including the country code.' };
  }
  const clash = phone ? list<UserDoc>('users', (u) => u.orgId === orgId && u.id !== id && u.phone === phone)[0] : undefined;
  if (clash) return { error: 'duplicate' as const, message: 'That mobile is already on somebody else in this team. One number, one person.' };

  update<UserDoc>('users', id, { phone } as Partial<UserDoc>);
  audit({
    orgId,
    actor,
    action: phone ? 'team.phone_set' : 'team.phone_cleared',
    target: id,
    detail: `${user.email}${phone ? ` · ${phone}` : ''}`,
  });
  return { member: membersFor(orgId, { youId: actorId }).find((m) => m.id === id) };
}

export async function createMember(
  orgId: string,
  input: { email: string; name: string; role: Role; actorId: string; phone?: string },
  actor: string
): Promise<{ member?: MemberRow; temporaryPassword?: string; error?: string; message?: string }> {
  const email = String(input.email ?? '').trim().toLowerCase();
  const name = String(input.name ?? '').trim();
  const role = input.role;
  if (!email || !email.includes('@')) return { error: 'validation', message: 'A working email address is required.' };
  if (!name) return { error: 'validation', message: 'A name is required — it is what the diary shows next to their appointments.' };
  if (!ROLES.includes(role)) return { error: 'validation', message: `\`role\` must be one of: ${ROLES.join(', ')}.` };
  if (find<UserDoc>('users', (u) => u.email === email)) {
    return { error: 'duplicate', message: `${email} already has a login. Deactivate it, or use a different address.` };
  }
  if (role === 'owner') {
    const inviter = memberById(orgId, input.actorId);
    if (inviter?.role !== 'owner') return { error: 'forbidden', message: 'Only an owner can add another owner.' };
  }

  const phone = normalisePhone(input.phone);
  if (input.phone && !phone) return { error: 'validation', message: 'That mobile number does not look right — use the full number, including the country code.' };
  if (phone && find<UserDoc>('users', (u) => u.orgId === orgId && u.phone === phone)) {
    return { error: 'duplicate', message: 'That mobile is already on somebody else in this team. One number, one person.' };
  }

  const temporary = temporaryPassword();
  const user = insert<UserDoc>('users', {
    id: newId('usr_'),
    email,
    name,
    passwordHash: await hashPassword(temporary),
    orgId,
    role,
    phone,
    emailVerified: false,
    twoFactorEnabled: false,
    createdAt: nowIso(),
    active: true,
    invitedBy: actor,
  } as UserDoc);
  audit({ orgId, actor, action: 'team.invited', target: user.id, detail: `${email} · ${role}${phone ? ` · ${phone}` : ''}` });
  return { member: membersFor(orgId).find((m) => m.id === user.id), temporaryPassword: temporary };
}

export function changeRole(
  orgId: string,
  userId: string,
  role: Role,
  actorId: string,
  actor: string
): { member?: MemberRow; error?: string; message?: string } {
  const user = memberById(orgId, userId);
  if (!user) return { error: 'not_found', message: `No such member in this workspace.` };
  if (!ROLES.includes(role)) return { error: 'validation', message: `\`role\` must be one of: ${ROLES.join(', ')}.` };
  const actorUser = memberById(orgId, actorId);
  if ((role === 'owner' || user.role === 'owner') && actorUser?.role !== 'owner') {
    return { error: 'forbidden', message: 'Only an owner can grant or take away owner access.' };
  }
  if (user.role === 'owner' && role !== 'owner' && ownersIn(orgId).length <= 1) {
    return {
      error: 'last_owner',
      message: 'This is the workspace\'s only owner. Give somebody else owner access first, or the practice is left with nobody who can administer it.',
    };
  }
  update<UserDoc>('users', userId, { role });
  audit({ orgId, actor, action: 'team.role_changed', target: userId, detail: `${user.email} ${user.role} → ${role}` });
  return { member: membersFor(orgId).find((m) => m.id === userId) };
}

export function setMemberActive(
  orgId: string,
  userId: string,
  active: boolean,
  actorId: string,
  actor: string
): { member?: MemberRow; error?: string; message?: string; sessions?: number } {
  const user = memberById(orgId, userId);
  if (!user) return { error: 'not_found', message: 'No such member in this workspace.' };
  if (!active && user.role === 'owner' && ownersIn(orgId).length <= 1) {
    return { error: 'last_owner', message: 'This is the workspace\'s only owner — deactivating it would lock everyone out.' };
  }
  if (!active && userId === actorId) {
    return { error: 'self', message: 'You cannot deactivate your own login. Ask another owner or admin.' };
  }
  update<UserDoc>('users', userId, { active, deactivatedAt: active ? undefined : nowIso(), deactivatedBy: active ? undefined : actor });
  // A deactivation that left the session alive is a leaver who can still read
  // the diary, so the sessions go with it.
  const revoked = revokeSessionsFor(orgId, userId, actor);
  audit({ orgId, actor, action: active ? 'team.reactivated' : 'team.deactivated', target: userId, detail: `${user.email} in ${user.role}${revoked ? ` · ${revoked} session(s) ended` : ''}` });
  return { member: membersFor(orgId).find((m) => m.id === userId), sessions: revoked };
}

export function resetMemberPassword(
  orgId: string,
  userId: string,
  actor: string
): Promise<{ temporaryPassword?: string; error?: string; message?: string }> {
  const user = memberById(orgId, userId);
  if (!user) return Promise.resolve({ error: 'not_found', message: 'No such member in this workspace.' });
  const temporary = temporaryPassword();
  return hashPassword(temporary).then((hash) => {
    update<UserDoc>('users', userId, { passwordHash: hash, mustChangePassword: true });
    revokeSessionsFor(orgId, userId, actor);
    audit({ orgId, actor, action: 'team.password_reset', target: userId, detail: user.email });
    return { temporaryPassword: temporary };
  });
}

function revokeSessionsFor(orgId: string, userId: string, actor: string): number {
  const live = list<Doc & { userId?: string; orgId?: string; revokedAt?: string }>(
    'sessions',
    (s) => s.orgId === orgId && s.userId === userId && !s.revokedAt
  );
  live.forEach((s) => update('sessions', s.id, { revokedAt: nowIso() }));
  if (live.length) audit({ orgId, actor, action: 'team.sessions_revoked', target: userId, detail: `${live.length} session(s)` });
  return live.length;
}

export function revokeMemberSessions(orgId: string, userId: string, actor: string): { revoked: number } {
  const user = memberById(orgId, userId);
  if (!user) return { revoked: 0 };
  return { revoked: revokeSessionsFor(orgId, userId, actor) };
}

export function sessionsFor(orgId: string, userId: string) {
  return list<Doc & { userId?: string; orgId?: string; userAgent?: string; ip?: string; createdAt?: string; expiresAt?: string; revokedAt?: string }>(
    'sessions',
    (s) => s.orgId === orgId && s.userId === userId
  )
    .map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revoked: Boolean(s.revokedAt),
      live: !s.revokedAt && new Date(String(s.expiresAt ?? 0)) > new Date(),
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** One place the UI and the API both read when they say what a role means. */
export function roleSummary() {
  return ROLES.map((role) => ({
    role,
    capabilities: capabilitiesFor(role).map((c) => c.key),
    people: 0,
  }));
}

export function roleCounts(orgId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const user of list<UserDoc>('users', (u) => u.orgId === orgId && u.active !== false)) {
    counts[user.role] = (counts[user.role] ?? 0) + 1;
  }
  return counts;
}
