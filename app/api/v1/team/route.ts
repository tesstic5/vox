import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, publicOrigin, readJson, requireAuth, requireConfigRole } from '@/lib/server/api';
import { inviteMember, pendingInvites, revokeInvites } from '@/lib/server/auth-flows';
import { audit } from '@/lib/server/audit';
import {
  CAPABILITIES,
  ROLES,
  changeRole,
  createMember,
  memberById,
  membersFor,
  resetMemberPassword,
  revokeMemberSessions,
  roleCounts,
  sessionsFor,
  setMemberActive,
  setMemberPhone,
  type Role,
} from '@/lib/server/team';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The team.
 *
 * A login is a real thing to hand out and a real thing to take away: hiring a
 * receptionist must not mean editing a database, and somebody leaving must not
 * keep a session that reads the diary until it expires. Inviting mints a
 * one-time password (stored hashed), deactivating ends their sessions with it,
 * and a workspace can never be left without an owner.
 *
 * Session-only by design: an API key is for machines, and a machine has no
 * business inviting people.
 */
function sessionOnly(ctx: { auth: string }): NextResponse | null {
  if (ctx.auth !== 'session') {
    return fail('FORBIDDEN', 'Managing the team needs a signed-in person, not an API key.', {});
  }
  return null;
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = sessionOnly(ctx);
  if (denied) return denied;

  const url = new URL(req.url);
  const view = url.searchParams.get('view') ?? 'members';
  const youId = ctx.user?.id;

  switch (view) {
    case 'members':
      return ok(
        {
          members: membersFor(ctx.orgId, { youId }),
          roles: ROLES,
          counts: roleCounts(ctx.orgId),
          you: youId ? { id: youId, role: ctx.user?.role } : undefined,
        },
        { requestId: ctx.requestId }
      );

    case 'roles':
      return ok(
        {
          capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, note: c.note, roles: c.roles })),
          roles: ROLES,
          counts: roleCounts(ctx.orgId),
        },
        { requestId: ctx.requestId }
      );

    case 'invites':
      // Live invitation links, read from the tokens themselves.
      return ok({ invites: pendingInvites(ctx.orgId), emailRelay: Boolean(process.env.VOXERA_EMAIL_API_BASE) }, { requestId: ctx.requestId });

    case 'sessions': {
      const userId = url.searchParams.get('userId') ?? '';
      const member = memberById(ctx.orgId, userId);
      if (!member) return fail('NOT_FOUND', `No member with id ${userId} in this workspace.`, { requestId: ctx.requestId });
      return ok({ sessions: sessionsFor(ctx.orgId, userId), member: { id: member.id, name: member.name, email: member.email } }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', '`view` must be one of: members, roles, invites, sessions.', { param: 'view', requestId: ctx.requestId });
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  const denied = sessionOnly(ctx) ?? requireConfigRole(ctx);
  if (denied) return denied;

  const body = await readJson<{ action?: string; id?: string; email?: string; name?: string; role?: Role; phone?: string }>(req);
  if (body instanceof NextResponse) return body;
  const actor = ctx.user?.email ?? 'dashboard';
  const actorId = ctx.user?.id ?? '';

  switch (body.action) {
    case 'invite': {
      const result = await createMember(
        ctx.orgId,
        { email: String(body.email ?? ''), name: String(body.name ?? ''), role: (body.role ?? 'receptionist') as Role, actorId, phone: body.phone },
        actor
      );
      if (result.error) {
        const code = result.error === 'duplicate' ? 'CONFLICT' : result.error === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION_ERROR';
        return fail(code, result.message ?? 'Could not add that person.', { requestId: ctx.requestId });
      }
      // The link and the one-time password are two doors to the same room. The
      // link is the one most people will use; the password is what an admin
      // reads out when the email does not arrive, so both are kept.
      const invited = result.member
        ? await inviteMember(
            { id: result.member.id, email: result.member.email, name: result.member.name, role: result.member.role },
            {
              orgId: ctx.orgId,
              orgName: ctx.org?.name ?? 'your workspace',
              invitedBy: { id: ctx.user?.id ?? 'system', name: ctx.user?.name ?? 'A workspace admin' },
              origin: publicOrigin(req),
              ip: clientIp(req),
            }
          )
        : undefined;
      return ok(
        {
          member: result.member,
          temporaryPassword: result.temporaryPassword,
          inviteSent: Boolean(invited?.mail.ok),
          inviteExpiresAt: invited?.expiresAt,
          inviteError: invited && !invited.mail.ok ? invited.mail.reason : undefined,
        },
        { requestId: ctx.requestId, status: 201 }
      );
    }

    case 'resend_invite': {
      const id = String(body.id ?? '');
      const member = memberById(ctx.orgId, id);
      if (!member) return fail('NOT_FOUND', `No member with id ${id} in this workspace.`, { requestId: ctx.requestId });
      if (member.lastLoginAt) {
        return fail('CONFLICT', `${member.name} has already signed in — send them a password reset instead.`, { requestId: ctx.requestId });
      }
      const invited = await inviteMember(
        { id: member.id, email: member.email, name: member.name, role: member.role },
        {
          orgId: ctx.orgId,
          orgName: ctx.org?.name ?? 'your workspace',
          invitedBy: { id: ctx.user?.id ?? 'system', name: ctx.user?.name ?? 'A workspace admin' },
          origin: publicOrigin(req),
          ip: clientIp(req),
        }
      );
      if (!invited.mail.ok) {
        return fail('EMAIL_UNAVAILABLE', `The invitation could not be emailed: ${invited.mail.reason}`, { requestId: ctx.requestId });
      }
      return ok({ invited: true, member: { id: member.id, email: member.email }, expiresAt: invited.expiresAt }, { requestId: ctx.requestId });
    }

    case 'revoke_invite': {
      const id = String(body.id ?? '');
      const member = memberById(ctx.orgId, id);
      if (!member) return fail('NOT_FOUND', `No member with id ${id} in this workspace.`, { requestId: ctx.requestId });
      const revoked = revokeInvites(id);
      audit({ orgId: ctx.orgId, actor, action: 'team.invite_revoked', target: id, detail: `${revoked} link(s) cancelled` });
      return ok({ revoked, member: { id: member.id, email: member.email } }, { requestId: ctx.requestId });
    }

    case 'role': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = changeRole(ctx.orgId, id, (body.role ?? '') as Role, actorId, actor);
      if (result.error) {
        const code = result.error === 'not_found' ? 'NOT_FOUND' : result.error === 'forbidden' ? 'FORBIDDEN' : result.error === 'last_owner' ? 'CONFLICT' : 'VALIDATION_ERROR';
        return fail(code, result.message ?? 'Could not change that role.', { requestId: ctx.requestId });
      }
      return ok({ member: result.member }, { requestId: ctx.requestId });
    }

    case 'deactivate':
    case 'reactivate': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const active = body.action === 'reactivate';
      const result = setMemberActive(ctx.orgId, id, active, actorId, actor);
      if (result.error) {
        const code = result.error === 'not_found' ? 'NOT_FOUND' : result.error === 'forbidden' ? 'FORBIDDEN' : 'CONFLICT';
        return fail(code, result.message ?? 'Could not change that login.', { requestId: ctx.requestId });
      }
      return ok({ member: result.member, sessionsEnded: result.sessions ?? 0 }, { requestId: ctx.requestId });
    }

    case 'phone': {
      // The mobile the assistant recognises when this person rings the practice
      // line — the difference between "the team's figures" and "sorry, I can't
      // share those".
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = setMemberPhone(ctx.orgId, id, body.phone, actorId, actor);
      if (result.error) {
        const code = result.error === 'not_found' ? 'NOT_FOUND' : result.error === 'duplicate' ? 'CONFLICT' : 'VALIDATION_ERROR';
        return fail(code, result.message ?? 'Could not save that number.', { requestId: ctx.requestId });
      }
      return ok({ member: result.member }, { requestId: ctx.requestId });
    }

    case 'password': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = await resetMemberPassword(ctx.orgId, id, actor);
      if (result.error) return fail('NOT_FOUND', result.message ?? 'No such member.', { requestId: ctx.requestId });
      return ok({ temporaryPassword: result.temporaryPassword, note: 'Their existing sessions have been ended.' }, { requestId: ctx.requestId });
    }

    case 'sessions:revoke': {
      const id = String(body.id ?? '');
      if (!id) return fail('VALIDATION_ERROR', '`id` is required.', { param: 'id', requestId: ctx.requestId });
      const result = revokeMemberSessions(ctx.orgId, id, actor);
      return ok({ revoked: result.revoked }, { requestId: ctx.requestId });
    }

    default:
      return fail('VALIDATION_ERROR', '`action` must be one of: invite, role, deactivate, reactivate, password, sessions:revoke.', {
        param: 'action',
        requestId: ctx.requestId,
      });
  }
}
