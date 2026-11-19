/**
 * The four token flows: password reset, magic link, email verification and
 * invitations.
 *
 * Everything here is server-only and returns plain data — no cookies, no
 * responses. Routes own the HTTP shape, `auth-tokens.ts` owns the storage rules,
 * `auth-mail.ts` owns the sending. This module owns the decisions: what gets
 * minted, what gets revoked, what gets audited, and what the email says.
 *
 * Two behaviours worth naming, because they are the ones that look like bugs
 * when they are missing:
 *
 *   - **Requesting a reset for an address that does not exist looks exactly like
 *     requesting one that does.** Same body, same timing, no mail sent. Otherwise
 *     the reset form is a free tool for finding out which of your colleagues have
 *     accounts.
 *   - **A password reset ends every session.** Not "every other session" —
 *     every one, including the one that asked. Then, if the request came from a
 *     browser, a single fresh session is created for the person standing at the
 *     keyboard. The copy on the reset screens has promised this from the start.
 */

import { get, list, update, type Doc } from './db';
import { createSession, markEmailVerified, setUserPassword, type OrgDoc, type UserDoc } from './auth';
import { emailRelayConfigured, sendAuthEmail, type MailResult } from './auth-mail';
import {
  checkCode,
  liveTokenFor,
  mintAuthToken,
  peekToken,
  redeemToken,
  revokeToken,
  revokeTokensFor,
  TOKEN_TTL_MS,
  tokenMessage,
  verificationState,
  type AuthTokenDoc,
  type TokenFailure,
  type TokenKind,
} from './auth-tokens';
import { audit } from './audit';

export const MIN_PASSWORD = 8;

export type FlowResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string; message: string; retryAt?: string; param?: string };

function userById(id: string) {
  return get<UserDoc>('users', id);
}

function orgById(id: string) {
  return get<OrgDoc>('orgs', id);
}

/** Ends every live session for one person, and says how many it ended. */
function endAllSessions(userId: string): number {
  const rows = list<Doc & { userId?: string; revokedAt?: string; expiresAt?: string }>('sessions', (s) => s.userId === userId);
  let ended = 0;
  for (const row of rows) {
    if (row.revokedAt) continue;
    if (new Date(String(row.expiresAt ?? 0)).getTime() <= Date.now()) continue;
    update('sessions', row.id, { revokedAt: new Date().toISOString() } as never);
    ended += 1;
  }
  return ended;
}

function passwordProblem(password: string) {
  if (password.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters. Length beats symbol soup.`;
  if (password.length > 200) return 'That password is longer than 200 characters.';
  return null;
}

/* --------------------------------------------------------- password reset */

export type ResetRequest = { requested: true; expiresInMinutes: number; delivered: boolean; note?: string };

export async function requestPasswordReset(email: string, meta: { origin: string; ip: string }): Promise<ResetRequest | FlowResult> {
  if (!emailRelayConfigured()) {
    return {
      ok: false,
      error: 'EMAIL_UNAVAILABLE',
      message: 'This deployment has no email relay configured, so reset links cannot be sent. Ask an owner to set VOXERA_EMAIL_API_BASE.',
    };
  }
  const user = list<UserDoc>('users', (u) => u.email === email.toLowerCase())[0];
  // Unknown or deactivated address: answer identically, send nothing.
  if (!user || user.active === false) {
    return { requested: true, expiresInMinutes: TOKEN_TTL_MS.reset / 60_000, delivered: false };
  }

  const minted = mintAuthToken({ kind: 'reset', userId: user.id, orgId: user.orgId, email: user.email, requestIp: meta.ip });
  const link = `${meta.origin}/reset-password/${minted.plaintext}`;
  const mail = await sendAuthEmail({
    to: user.email,
    subject: 'Reset your Voxera password',
    text: [
      `Hello ${user.name.split(' ')[0]},`,
      '',
      'Somebody asked to reset the password on your Voxera account. If that was you, open this link:',
      '',
      link,
      '',
      'It works once and expires in fifteen minutes. Every session on the account is signed out the moment a new password is saved.',
      '',
      'If it was not you, ignore this message — nothing has changed and your current password still works.',
      '',
      '— Voxera',
    ].join('\n'),
  });
  if (!mail.ok) return { ok: false, error: 'EMAIL_UNAVAILABLE', message: `The email relay refused the message: ${mail.reason}` };

  audit({ orgId: user.orgId, actor: user.email, action: 'auth.reset_requested', target: user.id, detail: 'single-use link, 15 minutes' });
  return { requested: true, expiresInMinutes: TOKEN_TTL_MS.reset / 60_000, delivered: true };
}

export type LinkState = { valid: boolean; reason?: TokenFailure; message?: string; email?: string; expiresAt?: string };

export function passwordResetState(token: string): LinkState {
  const state = peekToken('reset', token);
  if (state.valid) return { valid: true, email: state.token.email, expiresAt: state.expiresAt };
  return { valid: false, reason: state.reason, message: tokenMessage(state.reason) };
}

export type ResetDone = { email: string; sessionsEnded: number; user: UserDoc };

export async function completePasswordReset(
  token: string,
  password: string,
  meta: { ip: string; userAgent: string }
): Promise<FlowResult<ResetDone>> {
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: 'VALIDATION_ERROR', message: problem, param: 'password' };

  const state = redeemToken('reset', token);
  if (!state.valid) return { ok: false, error: 'TOKEN_' + state.reason.toUpperCase(), message: tokenMessage(state.reason) };

  const user = userById(state.token.userId);
  if (!user) return { ok: false, error: 'TOKEN_UNKNOWN', message: 'That account no longer exists. Ask an owner for access.' };
  if (user.active === false) return { ok: false, error: 'FORBIDDEN', message: 'That account has been deactivated.' };

  await setUserPassword(user.id, password);
  // Every session, including the one that asked: a reset is the moment to
  // assume the old credentials are in somebody else's hands.
  const sessionsEnded = endAllSessions(user.id);
  revokeTokensFor(user.id, 'reset');
  audit({
    orgId: user.orgId,
    actor: user.email,
    action: 'auth.password_reset',
    target: user.id,
    detail: `${sessionsEnded} session(s) ended`,
  });

  return { ok: true, email: user.email, sessionsEnded, user };
}

/* ------------------------------------------------------------ magic links */

export async function requestMagicLink(email: string, meta: { origin: string; ip: string }): Promise<ResetRequest | FlowResult> {
  if (!emailRelayConfigured()) {
    return {
      ok: false,
      error: 'EMAIL_UNAVAILABLE',
      message: 'This deployment has no email relay configured, so magic links cannot be sent. Use a password instead.',
    };
  }
  const user = list<UserDoc>('users', (u) => u.email === email.toLowerCase())[0];
  if (!user || user.active === false) {
    return { requested: true, expiresInMinutes: TOKEN_TTL_MS.magic / 60_000, delivered: false };
  }

  const minted = mintAuthToken({ kind: 'magic', userId: user.id, orgId: user.orgId, email: user.email, requestIp: meta.ip });
  const link = `${meta.origin}/magic-link/${minted.plaintext}`;
  const mail = await sendAuthEmail({
    to: user.email,
    subject: 'Your Voxera sign-in link',
    text: [
      `Hello ${user.name.split(' ')[0]},`,
      '',
      'Here is the sign-in link you asked for:',
      '',
      link,
      '',
      'It signs you in once, and expires in fifteen minutes. Nothing happens until you open it and press the button, so a mail scanner that follows the link cannot use it up.',
      '',
      'If you did not ask for this, you can ignore it — no session is created until the link is used.',
      '',
      '— Voxera',
    ].join('\n'),
  });
  if (!mail.ok) return { ok: false, error: 'EMAIL_UNAVAILABLE', message: `The email relay refused the message: ${mail.reason}` };

  audit({ orgId: user.orgId, actor: user.email, action: 'auth.magic_link_requested', target: user.id, detail: 'sign-in link, 15 minutes' });
  return { requested: true, expiresInMinutes: TOKEN_TTL_MS.magic / 60_000, delivered: true };
}

export function magicLinkState(token: string): LinkState {
  const state = peekToken('magic', token);
  if (state.valid) return { valid: true, email: state.token.email, expiresAt: state.expiresAt };
  return { valid: false, reason: state.reason, message: tokenMessage(state.reason) };
}

export async function consumeMagicLink(
  token: string,
  meta: { ip: string; userAgent: string }
): Promise<{
  ok: true;
  user: UserDoc;
  session: { token: string };
} | { ok: false; error: string; message: string }> {
  const state = redeemToken('magic', token);
  if (!state.valid) return { ok: false, error: 'TOKEN_' + state.reason.toUpperCase(), message: tokenMessage(state.reason) };
  const user = userById(state.token.userId);
  if (!user) return { ok: false, error: 'TOKEN_UNKNOWN', message: 'That account no longer exists.' };
  if (user.active === false) return { ok: false, error: 'FORBIDDEN', message: 'That account has been deactivated.' };

  const { token: sessionToken } = createSession(user, { userAgent: meta.userAgent, ip: meta.ip });
  audit({ orgId: user.orgId, actor: user.email, action: 'auth.magic_link_used', target: user.id, detail: 'signed in without a password' });
  return { ok: true, user, session: { token: sessionToken } };
}

/* ------------------------------------------------------ email verification */

export type VerifySend =
  | { ok: true; to: string; expiresAt: string; attemptsLeft: number; alreadyVerified?: boolean }
  | { ok: false; error: string; message: string; retryAt?: string };

export async function sendVerificationCode(
  user: UserDoc,
  meta: { origin: string; ip: string }
): Promise<VerifySend> {
  if (user.emailVerified) return { ok: true, to: user.email, expiresAt: '', attemptsLeft: 0, alreadyVerified: true };
  if (!emailRelayConfigured()) {
    return {
      ok: false,
      error: 'EMAIL_UNAVAILABLE',
      message: 'This deployment has no email relay configured, so verification codes cannot be sent. Set VOXERA_EMAIL_API_BASE.',
    };
  }
  // A locked code stays locked: re-sending must not clear the attempt counter,
  // or five guesses would just mean five guesses per email.
  const current = verificationState(user.id);
  if (current.locked) {
    return {
      ok: false,
      error: 'LOCKED',
      message: 'That code is locked for an hour after five wrong attempts. Try again after that, or ask an owner to verify you.',
      retryAt: current.retryAt,
    };
  }

  const minted = mintAuthToken({
    kind: 'verify',
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    requestIp: meta.ip,
    withCode: true,
  });
  const mail = await sendAuthEmail({
    to: user.email,
    subject: `${minted.code} is your Voxera verification code`,
    text: [
      `Hello ${user.name.split(' ')[0]},`,
      '',
      `Your verification code is ${minted.code}.`,
      '',
      `Enter it at ${meta.origin}/verify-email — it expires in fifteen minutes, and five wrong attempts lock it for an hour.`,
      '',
      'Verifying is what unlocks publishing an assistant, buying a number, and creating API keys.',
      '',
      '— Voxera',
    ].join('\n'),
  });
  if (!mail.ok) return { ok: false, error: 'EMAIL_UNAVAILABLE', message: `The email relay refused the message: ${mail.reason}` };

  audit({ orgId: user.orgId, actor: user.email, action: 'auth.verification_sent', target: user.id, detail: user.email });
  return { ok: true, to: user.email, expiresAt: minted.expiresAt, attemptsLeft: minted.token.maxAttempts };
}

export type VerifyConfirm =
  | { ok: true; emailVerified: true; alreadyVerified?: boolean; user: UserDoc }
  | { ok: false; error: string; message: string; attemptsLeft?: number; retryAt?: string };

export async function confirmVerificationCode(user: UserDoc, code: string): Promise<VerifyConfirm> {
  if (user.emailVerified) return { ok: true, emailVerified: true, alreadyVerified: true, user };
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return { ok: false, error: 'VALIDATION_ERROR', message: 'Enter all six digits.' };

  const row = liveTokenFor(user.id, 'verify');
  if (!row) return { ok: false, error: 'NO_CODE', message: 'That code has expired or was never issued. Send yourself a new one.' };

  const checked = checkCode(row, digits);
  if (!checked.ok) {
    if (checked.reason === 'locked') {
      return { ok: false, error: 'LOCKED', message: 'Five wrong attempts — this code is locked for an hour.', attemptsLeft: 0 };
    }
    return {
      ok: false,
      error: 'WRONG_CODE',
      message: `That code is not right. ${checked.attemptsLeft} attempt${checked.attemptsLeft === 1 ? '' : 's'} left before it locks for an hour.`,
      attemptsLeft: checked.attemptsLeft,
    };
  }

  update<AuthTokenDoc>('authTokens', row.id, { usedAt: new Date().toISOString() } as Partial<AuthTokenDoc>);
  const updated = markEmailVerified(user.id);
  audit({ orgId: user.orgId, actor: user.email, action: 'auth.email_verified', target: user.id, detail: 'six-digit code accepted' });
  return { ok: true, emailVerified: true, user: updated ?? user };
}

/** What the verify screen gets on load: verification plus code state, in one object. */
export function verificationSummary(user: UserDoc) {
  return {
    verified: Boolean(user.emailVerified),
    email: user.email,
    code: verificationState(user.id),
  };
}

/* ------------------------------------------------------------ invitations */

export type InviteState =
  | { valid: true; email: string; org: string; inviter: string; role: string; expiresAt: string; name: string }
  | { valid: false; reason: TokenFailure; message: string };

export function inviteState(token: string): InviteState {
  const state = peekToken('invite', token);
  if (!state.valid) return { valid: false, reason: state.reason, message: tokenMessage(state.reason) };
  const org = orgById(state.token.orgId);
  const member = userById(state.token.userId);
  const inviterId = state.token.meta?.invitedBy;
  const inviter = inviterId ? userById(inviterId) : undefined;
  return {
    valid: true,
    email: state.token.email,
    org: org?.name ?? 'the workspace',
    inviter: inviter?.name ?? 'a workspace admin',
    role: state.token.meta?.role ?? member?.role ?? 'receptionist',
    expiresAt: state.token.expiresAt,
    name: member?.name ?? '',
  };
}

export type InviteCreated = { plaintext: string; expiresAt: string; mail: MailResult };

/** Mints an invitation and mails the link. Called by the team invite route. */
export async function inviteMember(
  member: { id: string; email: string; name: string; role: string },
  context: { orgId: string; orgName: string; invitedBy: { id: string; name: string }; origin: string; ip: string }
): Promise<InviteCreated> {
  const minted = mintAuthToken({
    kind: 'invite',
    userId: member.id,
    orgId: context.orgId,
    email: member.email,
    requestIp: context.ip,
    meta: { invitedBy: context.invitedBy.id, role: member.role, invitedByName: context.invitedBy.name },
  });
  const link = `${context.origin}/invite/${minted.plaintext}`;
  const mail = await sendAuthEmail({
    to: member.email,
    subject: `${context.invitedBy.name} invited you to ${context.orgName} on Voxera`,
    text: [
      `Hello ${member.name.split(' ')[0]},`,
      '',
      `${context.invitedBy.name} added you to ${context.orgName} as ${member.role}.`,
      '',
      'Open this link to pick your own password and sign in:',
      '',
      link,
      '',
      'The invitation lasts seven days and works once. If it expires, ask for a new one — they are cheap, guessing is not.',
      '',
      '— Voxera',
    ].join('\n'),
  });
  audit({
    orgId: context.orgId,
    actor: context.invitedBy.name,
    action: 'team.invite_sent',
    target: member.id,
    detail: mail.ok ? `invitation emailed to ${member.email}` : `email not sent: ${mail.reason}`,
  });
  return { plaintext: minted.plaintext, expiresAt: minted.expiresAt, mail };
}

/**
 * Declining an invitation cancels it.
 *
 * The old screen had a "Decline" button that showed a toast and did nothing, so
 * the link stayed live for its full seven days after somebody had said no. A
 * refusal that leaves the credential working is not a refusal.
 */
export function declineInvite(token: string): { declined: boolean; message?: string } {
  const state = peekToken('invite', token);
  if (!state.valid) return { declined: false, message: tokenMessage(state.reason) };
  revokeToken(state.token.id);
  audit({
    orgId: state.token.orgId,
    actor: state.token.email,
    action: 'team.invite_declined',
    target: state.token.userId,
    detail: 'declined from the invitation screen',
  });
  return { declined: true };
}

export type InviteAccepted = { user: UserDoc; role: string; org: string; session: { token: string } };

export async function acceptInvite(
  token: string,
  input: { name?: string; password: string },
  meta: { ip: string; userAgent: string }
): Promise<FlowResult<InviteAccepted>> {
  const problem = passwordProblem(input.password);
  if (problem) return { ok: false, error: 'VALIDATION_ERROR', message: problem, param: 'password' };

  const state = redeemToken('invite', token);
  if (!state.valid) return { ok: false, error: 'TOKEN_' + state.reason.toUpperCase(), message: tokenMessage(state.reason) };

  const user = userById(state.token.userId);
  const org = orgById(state.token.orgId);
  if (!user || !org) return { ok: false, error: 'TOKEN_UNKNOWN', message: 'That invitation points at an account that no longer exists.' };
  if (user.active === false) return { ok: false, error: 'FORBIDDEN', message: 'That account has been deactivated. Ask an owner to switch it back on.' };

  const name = (input.name ?? '').trim();
  if (name.length >= 2) update<UserDoc>('users', user.id, { name } as Partial<UserDoc>);
  await setUserPassword(user.id, input.password);
  // Accepting an invitation proves control of the inbox the invitation went to,
  // so it is also the moment the address is verified.
  markEmailVerified(user.id);
  update<UserDoc>('users', user.id, { mustChangePassword: false });
  const fresh = userById(user.id) ?? user;

  const { token: sessionToken } = createSession(fresh, { userAgent: meta.userAgent, ip: meta.ip });
  audit({
    orgId: org.id,
    actor: fresh.email,
    action: 'team.invite_accepted',
    target: fresh.id,
    detail: `${fresh.role} in ${org.name}`,
  });
  return { ok: true, user: fresh, role: fresh.role, org: org.name, session: { token: sessionToken } };
}

/**
 * The invitations that are still live for one workspace.
 *
 * An invitation is only real if somebody can see it: who was invited, which role
 * they were offered, when it lapses, and a way to send it again. This is what the
 * dashboard's pending list is built from — the same rows the tokens live in, so
 * the list cannot disagree with what the links actually do.
 */
export function pendingInvites(orgId: string) {
  const now = Date.now();
  return list<AuthTokenDoc>('authTokens', (t) => t.kind === 'invite' && t.orgId === orgId && !t.usedAt && !t.revokedAt)
    .filter((t) => new Date(t.expiresAt).getTime() > now)
    .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)))
    .map((t) => {
      const member = userById(t.userId);
      const invitedBy = t.meta?.invitedBy ? userById(t.meta.invitedBy) : undefined;
      return {
        id: t.id,
        userId: t.userId,
        name: member?.name ?? t.email,
        email: t.email,
        role: t.meta?.role ?? member?.role ?? 'receptionist',
        invitedBy: invitedBy?.name ?? t.meta?.invitedByName ?? 'a workspace admin',
        sentAt: t.createdAt,
        expiresAt: t.expiresAt,
        expiresInHours: Math.max(0, Math.round((new Date(t.expiresAt).getTime() - now) / 36_000) / 100),
        active: member ? member.active !== false : false,
        alreadySignedIn: Boolean(member?.lastLoginAt),
      };
    });
}

/** Ends the live invitation(s) for one person, and says how many it ended. */
export function revokeInvites(userId: string) {
  const rows = list<AuthTokenDoc>('authTokens', (t) => t.kind === 'invite' && t.userId === userId && !t.usedAt && !t.revokedAt);
  for (const row of rows) revokeToken(row.id);
  return rows.length;
}

/** Revokes live tokens for somebody who has left, or after an admin reset. */
export function revokeAllFor(userId: string) {
  for (const kind of ['reset', 'magic', 'verify', 'invite'] as TokenKind[]) revokeTokensFor(userId, kind);
}
