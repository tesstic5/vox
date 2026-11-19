import { NextResponse, type NextRequest } from 'next/server';
import { currentUser, verifyPassword } from '@/lib/server/auth';
import { crossOriginRefusal, fail, ok, readJson, requestId } from '@/lib/server/api';
import { audit } from '@/lib/server/audit';
import {
  beginEnrolment,
  checkSecondFactor,
  confirmEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorLive,
  twoFactorSummary,
} from '@/lib/server/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Two-factor management for the signed-in account.
 *
 *   POST { action: 'setup' }                        → mint a pending secret (base32 + otpauth URL)
 *   POST { action: 'confirm', code }                → prove the secret, go live, recovery codes shown once
 *   POST { action: 'recovery', code }               → replace the recovery set (needs a current code)
 *   POST { action: 'disable', password, code }      → turn it off (needs the password AND a current code)
 *
 * GET returns the account's live status. Everything here is session-only:
 * an API key must never be able to enrol or remove the factor that protects
 * the human who owns it.
 */
export async function GET(req: NextRequest) {
  const rid = requestId();
  const session = await currentUser();
  if (!session) return fail('UNAUTHORIZED', 'Sign in first.', { requestId: rid });
  return ok({ twoFactor: twoFactorSummary(session.user) }, { requestId: rid });
}

export async function POST(req: NextRequest) {
  const rid = requestId();
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;
  const session = await currentUser();
  if (!session) return fail('UNAUTHORIZED', 'Sign in first.', { requestId: rid });
  const { user } = session;

  const body = await readJson<{ action?: string; code?: string; password?: string }>(req);
  if (body instanceof NextResponse) return body;

  switch (body.action) {
    case 'setup': {
      const begun = beginEnrolment(user);
      audit({ orgId: user.orgId, actor: user.email, action: 'auth.2fa_setup_started', target: user.id });
      return ok({ secret: begun.secret, otpauthUrl: begun.otpauthUrl }, { requestId: rid });
    }
    case 'confirm': {
      if (!body.code) return fail('VALIDATION_ERROR', 'Send the `code` from your authenticator.', { param: 'code', requestId: rid });
      const result = confirmEnrolment(user, body.code);
      if (!result.ok) return fail('VALIDATION_ERROR', result.message, { param: 'code', requestId: rid });
      audit({ orgId: user.orgId, actor: user.email, action: 'auth.2fa_enabled', target: user.id, detail: 'Authenticator app enrolled' });
      return ok({ enabled: true, recoveryCodes: result.recoveryCodes }, { requestId: rid });
    }
    case 'recovery': {
      if (!twoFactorLive(user)) return fail('VALIDATION_ERROR', 'Two-factor is not on for this account.', { requestId: rid });
      if (!body.code || !checkSecondFactor(user, body.code).ok) {
        return fail('UNAUTHORIZED', 'That code is not current. Recovery codes are only replaced after a good code.', { requestId: rid });
      }
      const recoveryCodes = regenerateRecoveryCodes(user);
      audit({ orgId: user.orgId, actor: user.email, action: 'auth.2fa_recovery_regenerated', target: user.id });
      return ok({ recoveryCodes }, { requestId: rid });
    }
    case 'disable': {
      if (!twoFactorLive(user)) return fail('VALIDATION_ERROR', 'Two-factor is not on for this account.', { requestId: rid });
      // Removing the factor demands both things the account knows: the
      // password and a current code. A stolen session alone cannot do it.
      if (!body.password || !(await verifyPassword(body.password, user.passwordHash))) {
        return fail('UNAUTHORIZED', 'That password does not match this account.', { requestId: rid });
      }
      if (!body.code || !checkSecondFactor(user, body.code).ok) {
        return fail('UNAUTHORIZED', 'That code is not current.', { requestId: rid });
      }
      disableTwoFactor(user);
      audit({ orgId: user.orgId, actor: user.email, action: 'auth.2fa_disabled', target: user.id });
      return ok({ enabled: false }, { requestId: rid });
    }
    default:
      return fail('VALIDATION_ERROR', '`action` must be one of: setup, confirm, recovery, disable.', { param: 'action', requestId: rid });
  }
}
